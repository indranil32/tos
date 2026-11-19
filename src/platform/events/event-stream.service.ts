import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Client } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { RequestContext } from '../context';
import { DatabaseService } from '../db/database.service';

export interface StreamClient {
  ctx: RequestContext;
  /** Facility codes this client wants (intersected with what the token allows); undefined = all allowed. */
  facilities?: string[];
  types?: string[];
  lastId: number;
  write: (chunk: string) => void;
  busy?: boolean;
  again?: boolean;
}

/**
 * Pushes committed domain events to browsers and devices (Server-Sent Events).
 * The outbox trigger NOTIFYs on commit; one LISTEN connection per API instance wakes the clients of that tenant,
 * and each client reads its new events through a normal RLS-scoped transaction, so a stream can never see
 * another tenant's or another facility's events. Works the same on every instance behind a load balancer.
 */
@Injectable()
export class EventStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EventStream');
  private readonly clients = new Map<string, Set<StreamClient>>();
  private listener?: Client;
  private heartbeat?: NodeJS.Timeout;
  private closing = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly db: DatabaseService,
  ) {}

  async onModuleInit() {
    await this.connect();
    this.heartbeat = setInterval(() => {
      for (const set of this.clients.values()) for (const c of set) c.write(': keep-alive\n\n');
    }, 25_000);
    this.heartbeat.unref();
  }

  async onModuleDestroy() {
    this.closing = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const set of this.clients.values()) set.clear();
    await this.listener?.end().catch(() => undefined);
  }

  private async connect(attempt = 0): Promise<void> {
    if (this.closing) return;
    const client = new Client({ connectionString: this.config.appDatabaseUrl });
    client.on('notification', (n) => {
      const tenantId = n.payload?.split(':')[0];
      if (tenantId) this.wake(tenantId);
    });
    client.on('error', (e) => {
      this.log.warn(`listener error: ${e.message}`);
      this.listener = undefined;
      setTimeout(() => void this.connect(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt)).unref();
    });
    try {
      await client.connect();
      await client.query('LISTEN tos_events');
      this.listener = client;
      if (attempt > 0) for (const t of this.clients.keys()) this.wake(t); // catch up after a reconnect
    } catch (e) {
      this.log.warn(`listener connect failed: ${(e as Error).message}`);
      await client.end().catch(() => undefined);
      setTimeout(() => void this.connect(attempt + 1), Math.min(30_000, 1000 * 2 ** attempt)).unref();
    }
  }

  /** Register a client; returns the id the stream starts after and an unsubscribe function. */
  async subscribe(c: Omit<StreamClient, 'lastId'> & { after?: number }): Promise<() => void> {
    const tenantId = c.ctx.tenantId!;
    const start = c.after ?? (await this.db.tx(c.ctx, (tx) => tx.one<{ id: string }>('SELECT coalesce(max(id), 0) AS id FROM outbox_events')))!.id;
    const client: StreamClient = { ...c, lastId: Number(start) };
    const set = this.clients.get(tenantId) ?? new Set();
    set.add(client);
    this.clients.set(tenantId, set);
    client.write(`event: ready\ndata: ${JSON.stringify({ after: client.lastId })}\n\n`);
    if (c.after !== undefined) void this.drain(client); // replay what the client missed
    return () => {
      set.delete(client);
      if (!set.size) this.clients.delete(tenantId);
    };
  }

  connections(): number {
    let n = 0;
    for (const s of this.clients.values()) n += s.size;
    return n;
  }

  private wake(tenantId: string) {
    for (const c of this.clients.get(tenantId) ?? []) void this.drain(c);
  }

  private async drain(c: StreamClient): Promise<void> {
    if (c.busy) {
      c.again = true;
      return;
    }
    c.busy = true;
    try {
      do {
        c.again = false;
        const allowed = intersect(c.ctx.allowedFacilities, c.facilities);
        const rows = await this.db.tx(c.ctx, (tx) =>
          tx.many(
            `SELECT e.id, e.event_type AS type, e.aggregate_type AS "aggregateType", e.aggregate_id AS "aggregateId",
                    f.code AS facility, e.payload, e.occurred_at AS "occurredAt"
               FROM outbox_events e LEFT JOIN facilities f ON f.id = e.facility_id
              WHERE e.id > $1 AND ($2::text[] IS NULL OR f.code = ANY($2)) AND ($3::text[] IS NULL OR e.event_type = ANY($3))
              ORDER BY e.id LIMIT 500`,
            [c.lastId, allowed ?? null, c.types ?? null],
          ),
        );
        for (const r of rows) {
          c.lastId = Number(r.id);
          c.write(`id: ${r.id}\nevent: ${r.type}\ndata: ${JSON.stringify({ ...r, id: Number(r.id) })}\n\n`);
        }
        if (rows.length === 500) c.again = true;
      } while (c.again);
    } catch (e) {
      this.log.warn(`stream read failed: ${(e as Error).message}`);
    } finally {
      c.busy = false;
    }
  }
}

function intersect(a?: string[], b?: string[]): string[] | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.filter((x) => b.includes(x));
}
