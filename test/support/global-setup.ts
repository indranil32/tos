import { execFileSync } from 'child_process';
import { join } from 'path';
import { runMigrations } from '../../src/platform/db/migrate';

/**
 * Uses TEST_OWNER_DATABASE_URL / TEST_APP_DATABASE_URL when given (CI service container),
 * otherwise starts a throwaway local PostgreSQL with scripts/test-db.sh.
 */
export default async function globalSetup() {
  let owner = process.env.TEST_OWNER_DATABASE_URL;
  let app = process.env.TEST_APP_DATABASE_URL;
  if (!owner || !app) {
    const out = execFileSync('bash', [join(__dirname, '..', '..', 'scripts', 'test-db.sh'), 'start'], { encoding: 'utf8' });
    owner = /OWNER_URL=(\S+)/.exec(out)![1];
    app = /APP_URL=(\S+)/.exec(out)![1];
    process.env.TOS_TEST_LOCAL_PG = '1';
  }
  await runMigrations(owner, 'tos_app');
  process.env.OWNER_DATABASE_URL = owner;
  process.env.APP_DATABASE_URL = app;
  process.env.APP_DB_ROLE = 'tos_app';
  process.env.PLATFORM_OIDC_ISSUER = 'https://id.test/realms/platform';
  process.env.TRUSTED_ISSUER_PREFIXES = 'https://id.test/realms/';
}
