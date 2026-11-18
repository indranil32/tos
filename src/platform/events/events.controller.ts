import { Controller, Get, Query } from '@nestjs/common';
import { RequestContext, ROLES } from '../context';
import { Ctx, Roles } from '../auth/decorators';
import { DatabaseService } from '../db/database.service';

/**
 * Event feed for API consumers that poll instead of receiving webhooks.
 * Every EDI message in the catalogue has an event here (see api/asyncapi.yaml).
 */
@Controller('v1/events')
export class EventsController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  @Roles(ROLES.viewer, ROLES.edi, ROLES.operator, ROLES.planner, ROLES.billing, ROLES.gate)
  list(@Ctx() ctx: RequestContext, @Query('after') after?: string, @Query('type') type?: string) {
    const afterId = Number(after ?? 0) || 0;
    return this.db.tx(ctx, async (tx) => {
      const rows = await tx.many(
        `SELECT e.id, e.event_type AS type, e.aggregate_type, e.aggregate_id, f.code AS facility, e.payload, e.actor, e.occurred_at
           FROM outbox_events e LEFT JOIN facilities f ON f.id = e.facility_id
          WHERE e.id > $1 AND ($2::text IS NULL OR e.event_type = $2)
            AND ($3::text[] IS NULL OR f.code = ANY($3))
          ORDER BY e.id LIMIT 500`,
        [afterId, type ?? null, ctx.allowedFacilities ?? null],
      );
      return { events: rows.map((r) => ({ ...r, id: Number(r.id) })) };
    });
  }
}
