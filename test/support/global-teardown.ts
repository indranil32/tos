import { execFileSync } from 'child_process';
import { join } from 'path';

export default async function globalTeardown() {
  if (process.env.TOS_TEST_LOCAL_PG === '1' && process.env.KEEP_TEST_DB !== '1') {
    execFileSync('bash', [join(__dirname, '..', '..', 'scripts', 'test-db.sh'), 'stop']);
  }
}
