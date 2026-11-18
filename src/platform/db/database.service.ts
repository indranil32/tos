import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';
import { RequestContext } from '../context';
import { ApiError } from '../errors';

/** Thin query helper bound to one transaction. */
export class Tx {
  constructor(public readonly client: PoolClient) {}

  async many<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.client.query<T>(sql, params)).rows;
  }
  async one<T extends QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    return (await this.client.query<T>(sql, params)).rows[0];
  }
  async must<T extends QueryResultRow = any>(sql: string, params: unknown[], what: string): Promise<T> {
    const row = await this.one<T>(sql, params);
    if (!row) throw ApiError.notFound(what);
    return row;
  }
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    return (await this.client.query(sql, params)).rowCount ?? 0;
  }
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.appDatabaseUrl, max: 20 });
  }

  /**
   * Run fn in a transaction scoped to the caller's tenant.
   * app.tenant_id is set with SET LOCAL semantics, so row-level security isolates every query.
   */
  async tx<T>(ctx: RequestContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (!ctx.tenantId) throw ApiError.forbidden('Token is not bound to a tenant');
    return this.run(ctx.tenantId, fn);
  }

  /** Platform-level transaction without a tenant (only tables without RLS are visible). */
  async platformTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.run(null, fn);
  }

  private async run<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId ?? '']);
      const result = await fn(new Tx(client));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
