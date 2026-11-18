import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadConfig } from './platform/config';
import { runMigrations } from './platform/db/migrate';

async function main() {
  const config = loadConfig();
  if (config.ownerDatabaseUrl && process.env.MIGRATE_ON_START !== 'false') {
    const applied = await runMigrations(config.ownerDatabaseUrl, config.appDbRole);
    if (applied.length) console.log(`Migrations applied: ${applied.join(', ')}`);
  }
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureApp(app);
  await app.listen(config.port);
  console.log(`TOS platform listening on :${config.port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
