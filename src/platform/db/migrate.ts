import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export function migrationsDir(): string {
  // Works from both src/ (ts-node, tests) and dist/ (compiled).
  return join(__dirname, '..', '..', '..', 'db', 'migrations');
}

/**
 * Apply pending SQL migrations in file-name order as the owner role,
 * then grant the application role DML rights (it never owns tables, so RLS always applies).
 */
export async function runMigrations(ownerUrl: string, appRole: string, dir = migrationsDir(), appPassword?: string): Promise<string[]> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name as string));
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = readFileSync(join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${f} failed: ${(e as Error).message}`);
      }
    }
    if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) throw new Error(`Invalid app role name: ${appRole}`);
    if (appPassword) {
      // Managed PostgreSQL (Azure, RDS) has no init scripts: create or update the non-owner app role here.
      await client.query("SELECT set_config('tos.app_role', $1, false), set_config('tos.app_pw', $2, false)", [appRole, appPassword]);
      await client.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_setting('tos.app_role')) THEN
          EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', current_setting('tos.app_role'), current_setting('tos.app_pw'));
        ELSE
          EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', current_setting('tos.app_role'), current_setting('tos.app_pw'));
        END IF;
      END $$`);
      await client.query("SELECT set_config('tos.app_pw', '', false)");
    }
    await client.query(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${appRole}', current_database()); END $$`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);
    await client.query(`REVOKE ALL ON schema_migrations FROM ${appRole}`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    await client.end();
  }
  return applied;
}
