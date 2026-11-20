import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { currentFacility } from '../platform/facility';
import { code, isoDateTime, parse } from '../platform/validation';
import { PlanningService } from './planning.service';

const BerthPlanBody = z.object({
  berth: code,
  quayFromM: z.number().min(0).optional(),
  eta: isoDateTime.optional(),
  etb: isoDateTime,
  etd: isoDateTime,
  sideTo: z.enum(['PORT', 'STARBOARD']).optional(),
});
const StowBody = z.object({
  assignments: z.array(z.object({
    unitRef: z.string().trim().toUpperCase(),
    cell: z.string().trim().regex(/^[0-9]{6,7}$/, 'bay-row-tier, e.g. 0120682').nullable(),
  })).min(1).max(5000),
});
const SplitBody = z.object({
  /** Cranes in quay order, matching bay order (first crane works the lowest bays). */
  cranes: z.array(code).min(1).max(12),
  movesPerHour: z.number().positive().max(80).optional(),
});

/** Vessel planning: berth plan, bay plan, load stow planning and crane split. */
@Controller('v1')
@FacilityScoped()
export class PlanningController {
  constructor(
    private readonly db: DatabaseService,
    private readonly planning: PlanningService,
  ) {}

  /** Berths and the visits on or waiting for them in a time window (default: 2 days back, 14 ahead). */
  @Get('berth-plan')
  berthPlan(@Ctx() ctx: RequestContext, @Query('from') from?: string, @Query('to') to?: string) {
    const start = from ? new Date(from) : new Date(Date.now() - 2 * 864e5);
    const end = to ? new Date(to) : new Date(start.getTime() + 16 * 864e5);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) throw ApiError.invalid('from/to must be ISO dates, from before to');
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const berths = await tx.many(
        `SELECT code, name, berth_kind AS "berthKind", start_mark_m::float AS "startMarkM", length_m::float AS "lengthM", depth_m::float AS "depthM"
           FROM berths WHERE facility_id = $1 ORDER BY start_mark_m`,
        [f.id],
      );
      const visits = await this.planning.berthPlan(tx, f, start.toISOString(), end.toISOString());
      return { from: start.toISOString(), to: end.toISOString(), berths, visits };
    });
  }

  @Put('visits/:id/berth-plan')
  @Roles(ROLES.planner)
  place(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(BerthPlanBody, body);
    return this.db.tx(ctx, async (tx) => this.planning.placeOnBerth(tx, ctx, await currentFacility(tx, ctx), id, b));
  }

  @Get('visits/:id/bay-plan')
  bayPlan(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => this.planning.bayPlan(tx, await currentFacility(tx, ctx), id));
  }

  /** Put load units into vessel cells (cell null clears the plan for that unit). All-or-nothing. */
  @Put('visits/:id/stow-plan')
  @Roles(ROLES.planner)
  stow(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(StowBody, body);
    return this.db.tx(ctx, async (tx) => this.planning.planStow(tx, ctx, await currentFacility(tx, ctx), id, b.assignments));
  }

  @Post('visits/:id/crane-split')
  @Roles(ROLES.planner)
  split(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(SplitBody, body);
    return this.db.tx(ctx, async (tx) => this.planning.craneSplit(tx, ctx, await currentFacility(tx, ctx), id, b));
  }

  /** The visit's crane queues: bay ranges and progress. */
  @Get('visits/:id/crane-split')
  currentSplit(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const v = await tx.must<{ moves_per_hour: string | null }>('SELECT moves_per_hour FROM vessel_visits WHERE id = $1 AND facility_id = $2', [id, f.id], 'Vessel visit');
      const queues = await tx.many(
        `SELECT q.code AS queue, e.code AS crane, e.status AS "craneStatus", q.status, q.bay_from AS "bayFrom", q.bay_to AS "bayTo",
                count(w.id) FILTER (WHERE w.status = 'PLANNED')::int AS planned,
                count(w.id) FILTER (WHERE w.status IN ('DISPATCHED','IN_PROGRESS'))::int AS active,
                count(w.id) FILTER (WHERE w.status = 'COMPLETED')::int AS completed
           FROM work_queues q LEFT JOIN equipment e ON e.id = q.equipment_id LEFT JOIN work_instructions w ON w.work_queue_id = q.id
          WHERE q.visit_id = $1 AND q.pow_kind = 'VESSEL'
          GROUP BY q.id, e.code, e.status ORDER BY q.status, q.bay_from NULLS LAST, q.code`,
        [id],
      );
      return { movesPerHour: v.moves_per_hour === null ? null : Number(v.moves_per_hour), queues };
    });
  }
}
