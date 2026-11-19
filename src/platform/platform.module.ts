import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { KeyResolver } from './auth/key-resolver';
import { APP_CONFIG, loadConfig } from './config';
import { DatabaseService } from './db/database.service';
import { ProblemFilter } from './errors';
import { EventsService } from './events/events.service';
import { EventsController } from './events/events.controller';
import { HealthController } from './health.controller';
import { WebConfigController } from './web-config.controller';

@Global()
@Module({
  controllers: [HealthController, EventsController, WebConfigController],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    DatabaseService,
    KeyResolver,
    EventsService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
  ],
  exports: [APP_CONFIG, DatabaseService, EventsService],
})
export class PlatformModule {}
