import { runMigrations } from './migrate';

async function main() {
  const owner = process.env.OWNER_DATABASE_URL;
  if (!owner) throw new Error('OWNER_DATABASE_URL must be set');
  const applied = await runMigrations(owner, process.env.APP_DB_ROLE ?? 'tos_app', undefined, process.env.APP_DB_PASSWORD);
  // eslint-disable-next-line no-console
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
