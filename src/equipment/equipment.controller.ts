import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { currentFacility } from '../platform/facility';
import { code, parse } from '../platform/validation';
import { EquipmentService, EQUIPMENT_KINDS, EQUIPMENT_STATUSES } from './equipment.service';

const PoolBody = z.object({ code, name: z.string().min(1) });
const EquipmentBody = z.object({
  code,
  kind: z.enum(EQUIPMENT_KINDS),
  pool: code.optional(),
  maxWeightKg: z.number().int().positive().optional(),
  twinLift: z.boolean().default(false),
  position: z.string().max(40).optional(),
});
const StatusBody = z.object({
  status: z.enum(EQUIPMENT_STATUSES),
  reason: z.string().max(200).optional(),
  operator: z.string().max(80).optional(),
  position: z.string().max(40).optional(),
});
const time = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'HH:MM');
const ShiftBody = z.object({ code, name: z.string().min(1), startsAt: time, endsAt: time });
const GangBody = z.object({ code, name: z.string().min(1), shift: code.optional(), members: z.array(z.string().min(1).max(80)).default([]) });

/** Container handling equipment (CHE), pools, shifts and gangs. */
@Controller('v1')
@FacilityScoped()
export class EquipmentController {
  constructor(
    private readonly db: DatabaseService,
    private readonly equipment: EquipmentService,
  ) {}

  @Post('equipment-pools')
  @Roles(ROLES.admin, ROLES.planner)
  createPool(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(PoolBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.one(
        'INSERT INTO equipment_pools (tenant_id, facility_id, code, name) VALUES (current_tenant(), $1,$2,$3) RETURNING id, code, name',
        [f.id, b.code, b.name],
      );
    });
  }

  @Get('equipment-pools')
  listPools(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT p.id, p.code, p.name, (SELECT count(*)::int FROM equipment e WHERE e.pool_id = p.id) AS machines
           FROM equipment_pools p WHERE p.facility_id = $1 ORDER BY p.code`,
        [f.id],
      );
    });
  }

  @Post('equipment')
  @Roles(ROLES.admin)
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(EquipmentBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const pool = b.pool
        ? await tx.must<{ id: string }>('SELECT id FROM equipment_pools WHERE facility_id = $1 AND code = $2', [f.id, b.pool], `Pool ${b.pool}`)
        : null;
      const row = await tx.one<{ id: string }>(
        `INSERT INTO equipment (tenant_id, facility_id, code, kind, pool_id, max_weight_kg, twin_lift, position)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [f.id, b.code, b.kind, pool?.id ?? null, b.maxWeightKg ?? null, b.twinLift, b.position ?? null],
      );
      return this.equipment.get(tx, f.id, row!.id);
    });
  }

  @Get('equipment')
  list(@Ctx() ctx: RequestContext, @Query('kind') kind?: string, @Query('status') status?: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return this.equipment.list(tx, f.id, { kind, status });
    });
  }

  @Get('equipment/:code')
  one(@Ctx() ctx: RequestContext, @Param('code') eqCode: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const e = await this.equipment.byCode(tx, f.id, eqCode);
      const history = await tx.many(
        `SELECT status, reason, operator, actor, at FROM equipment_status_log WHERE equipment_id = $1 ORDER BY at DESC, id DESC LIMIT 50`,
        [e.id],
      );
      return { ...e, history };
    });
  }

  /**
   * Status change from the operator app or the control room (log on, break, breakdown, maintenance).
   * A breakdown or maintenance hands the machine's open jobs back to their queues for re-dispatch.
   */
  @Post('equipment/:code/status')
  @Roles(ROLES.operator, ROLES.planner)
  setStatus(@Ctx() ctx: RequestContext, @Param('code') eqCode: string, @Body() body: unknown) {
    const b = parse(StatusBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const e = await this.equipment.byCode(tx, f.id, eqCode, true);
      return this.equipment.changeStatus(tx, ctx, f.id, e, b);
    });
  }

  @Post('shifts')
  @Roles(ROLES.admin, ROLES.planner)
  createShift(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(ShiftBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.one(
        `INSERT INTO shifts (tenant_id, facility_id, code, name, starts_at, ends_at) VALUES (current_tenant(), $1,$2,$3,$4,$5)
         RETURNING id, code, name, to_char(starts_at, 'HH24:MI') AS "startsAt", to_char(ends_at, 'HH24:MI') AS "endsAt"`,
        [f.id, b.code, b.name, b.startsAt, b.endsAt],
      );
    });
  }

  @Get('shifts')
  listShifts(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT id, code, name, to_char(starts_at, 'HH24:MI') AS "startsAt", to_char(ends_at, 'HH24:MI') AS "endsAt"
           FROM shifts WHERE facility_id = $1 ORDER BY starts_at`,
        [f.id],
      );
    });
  }

  @Post('gangs')
  @Roles(ROLES.admin, ROLES.planner)
  createGang(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(GangBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const shift = b.shift
        ? await tx.must<{ id: string }>('SELECT id FROM shifts WHERE facility_id = $1 AND code = $2', [f.id, b.shift], `Shift ${b.shift}`)
        : null;
      if (new Set(b.members).size !== b.members.length) throw ApiError.invalid('Gang members must be unique');
      return tx.one(
        `INSERT INTO gangs (tenant_id, facility_id, code, name, shift_id, members) VALUES (current_tenant(), $1,$2,$3,$4,$5)
         RETURNING id, code, name, members`,
        [f.id, b.code, b.name, shift?.id ?? null, b.members],
      );
    });
  }

  @Get('gangs')
  listGangs(@Ctx() ctx: RequestContext) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT g.id, g.code, g.name, s.code AS shift, g.members FROM gangs g LEFT JOIN shifts s ON s.id = g.shift_id
          WHERE g.facility_id = $1 ORDER BY g.code`,
        [f.id],
      );
    });
  }
}
