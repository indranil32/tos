import { Injectable } from '@nestjs/common';
import { RequestContext } from '../context';
import { Tx } from '../db/database.service';

export interface DomainEvent {
  id?: number;
  type: string;
  aggregateType: string;
  aggregateId: string;
  facilityId?: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

/** Handler that runs inside the emitting transaction (e.g. billing accrual). */
export type InTxHandler = (tx: Tx, ctx: RequestContext, event: DomainEvent) => Promise<void>;

/**
 * Writes domain events to the transactional outbox and runs in-transaction handlers.
 * Event names match the AsyncAPI catalogue (api/asyncapi.yaml) and the EDI/API catalogue.
 */
@Injectable()
export class EventsService {
  private readonly handlers = new Map<string, InTxHandler[]>();

  on(type: string, handler: InTxHandler) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
  }

  async emit(tx: Tx, ctx: RequestContext, event: DomainEvent): Promise<void> {
    const row = await tx.one<{ id: string; occurred_at: Date }>(
      `INSERT INTO outbox_events (tenant_id, facility_id, event_type, aggregate_type, aggregate_id, payload, actor, occurred_at)
       VALUES (current_tenant(), $1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()))
       RETURNING id, occurred_at`,
      [event.facilityId ?? null, event.type, event.aggregateType, event.aggregateId, event.payload, ctx.subject, event.occurredAt ?? null],
    );
    const full: DomainEvent = { ...event, id: Number(row!.id), occurredAt: row!.occurred_at.toISOString() };
    for (const h of this.handlers.get(event.type) ?? []) await h(tx, ctx, full);
  }
}
