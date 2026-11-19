import { Injectable } from '@nestjs/common';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';

export const EQUIPMENT_KINDS = ['QC', 'MHC', 'RTG', 'RMG', 'RS', 'ECH', 'SC', 'TT', 'FLT', 'MAFI', 'RAIL_CRANE', 'PUMP'] as const;
export const EQUIPMENT_STATUSES = ['OFFLINE', 'IDLE', 'WORKING', 'BREAKDOWN', 'MAINTENANCE'] as const;
export type EquipmentStatus = (typeof EQUIPMENT_STATUSES)[number];

/** Statuses in which a machine cannot hold jobs. */
export const UNAVAILABLE: EquipmentStatus[] = ['OFFLINE', 'BREAKDOWN', 'MAINTENANCE'];

export interface EquipmentRow {
  id: string;
  code: string;
  kind: string;
  pool: string | null;
  poolId: string | null;
  status: EquipmentStatus;
  statusSince: string;
  statusReason: string | null;
  operator: string | null;
  position: string | null;
  maxWeightKg: number | null;
  twinLift: boolean;
  openJobs: number;
}

const COLS = `e.id, e.code, e.kind, p.code AS pool, e.pool_id AS "poolId", e.status, e.status_since AS "statusSince",
  e.status_reason AS "statusReason", e.operator, e.position, e.max_weight_kg AS "maxWeightKg", e.twin_lift AS "twinLift",
  (SELECT count(*)::int FROM work_instructions w WHERE w.equipment_id = e.id AND w.status IN ('DISPATCHED','IN_PROGRESS')) AS "openJobs"`;

@Injectable()
export class EquipmentService {
  constructor(private readonly events: EventsService) {}

  list(tx: Tx, facilityId: string, f: { kind?: string; status?: string } = {}) {
    return tx.many<EquipmentRow>(
      `SELECT ${COLS} FROM equipment e LEFT JOIN equipment_pools p ON p.id = e.pool_id
        WHERE e.facility_id = $1 AND ($2::text IS NULL OR e.kind = $2) AND ($3::text IS NULL OR e.status = $3)
        ORDER BY e.kind, e.code`,
      [facilityId, f.kind ?? null, f.status ?? null],
    );
  }

  async get(tx: Tx, facilityId: string, id: string): Promise<EquipmentRow> {
    return tx.must<EquipmentRow>(
      `SELECT ${COLS} FROM equipment e LEFT JOIN equipment_pools p ON p.id = e.pool_id WHERE e.facility_id = $1 AND e.id = $2`,
      [facilityId, id],
      'Equipment',
    );
  }

  async byCode(tx: Tx, facilityId: string, code: string, lock = false): Promise<EquipmentRow> {
    if (lock) {
      await tx.must('SELECT id FROM equipment WHERE facility_id = $1 AND code = $2 FOR UPDATE', [facilityId, code], `Equipment ${code}`);
    }
    return tx.must<EquipmentRow>(
      `SELECT ${COLS} FROM equipment e LEFT JOIN equipment_pools p ON p.id = e.pool_id WHERE e.facility_id = $1 AND e.code = $2`,
      [facilityId, code],
      `Equipment ${code}`,
    );
  }

  /** Change status, keep the log, and release jobs held by a machine that can no longer work. */
  async changeStatus(
    tx: Tx,
    ctx: RequestContext,
    facilityId: string,
    e: EquipmentRow,
    b: { status: EquipmentStatus; reason?: string; operator?: string; position?: string },
  ) {
    if (b.status === 'WORKING' && e.openJobs === 0) {
      throw ApiError.conflict('no_job', `${e.code} has no job; WORKING is set by the dispatcher`);
    }
    if (b.status === 'IDLE' && e.openJobs > 0) {
      // Back from a break with jobs still assigned: the machine is working them.
      b = { ...b, status: 'WORKING' };
    }
    const operator = b.status === 'OFFLINE' ? null : (b.operator ?? e.operator);
    await tx.exec(
      `UPDATE equipment SET status = $2, status_reason = $3, operator = $4, position = coalesce($5, position),
              status_since = CASE WHEN status = $2 THEN status_since ELSE now() END
        WHERE id = $1`,
      [e.id, b.status, b.reason ?? null, operator, b.position ?? null],
    );
    await tx.exec(
      `INSERT INTO equipment_status_log (tenant_id, equipment_id, status, reason, operator, actor) VALUES (current_tenant(), $1,$2,$3,$4,$5)`,
      [e.id, b.status, b.reason ?? null, operator, ctx.subject],
    );
    let released: string[] = [];
    if (UNAVAILABLE.includes(b.status)) {
      released = (
        await tx.many<{ id: string }>(
          `UPDATE work_instructions SET status = 'PLANNED', equipment_id = NULL, dispatched_at = NULL, started_at = NULL, version = version + 1
            WHERE equipment_id = $1 AND status IN ('DISPATCHED','IN_PROGRESS') RETURNING id`,
          [e.id],
        )
      ).map((r) => r.id);
    }
    await this.events.emit(tx, ctx, {
      type: 'equipment.status_changed', aggregateType: 'equipment', aggregateId: e.id, facilityId,
      payload: { code: e.code, kind: e.kind, from: e.status, to: b.status, reason: b.reason ?? null, releasedJobs: released.length },
    });
    for (const id of released) {
      await this.events.emit(tx, ctx, {
        type: 'work.released', aggregateType: 'work_instruction', aggregateId: id, facilityId,
        payload: { equipment: e.code, reason: `${e.code} ${b.status.toLowerCase()}` },
      });
    }
    return { ...(await this.get(tx, facilityId, e.id)), releasedJobs: released.length };
  }
}
