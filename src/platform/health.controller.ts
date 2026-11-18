import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/decorators';
import { DatabaseService } from './db/database.service';

@Controller()
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  @Public()
  @Get('health')
  async health() {
    await this.db.pool.query('SELECT 1');
    return { status: 'ok' };
  }
}
