import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { currentFacility } from '../platform/facility';
import { parse } from '../platform/validation';

const HoldBody = z.object({
  holdType: z.enum(['CUSTOMS', 'LINE', 'TERMINAL', 'DG', 'INSPECTION']),
  reference: z.string().max(80).optional(),
});

export const UNIT_COLUMNS = `u.id, u.cargo_kind AS "cargoKind", u.unit_ref AS "unitRef", u.iso_type AS "isoType",
  u.freight_kind AS "freightKind", u.category, u.gross_weight_kg AS "grossWeightKg", u.quantity, u.quantity_uom AS "quantityUom",
  u.state, u.yard_position AS "yardPosition", u.pol, u.pod, u.dg_class AS "dgClass", u.dg_un_number AS "dgUnNumber",
  u.is_reefer AS "isReefer", u.time_in AS "timeIn", u.time_out AS "timeOut",
  (SELECT code FROM partners p WHERE p.id = u.line_operator_id) AS "lineOperator"`;

@Controller('v1/units')
@FacilityScoped()
export class UnitsController {
  constructor(private readonly db: DatabaseService, private readonly events: EventsService) {}

  @Get()
  find(@Ctx() ctx: RequestContext, @Query('ref') ref?: string, @Query('state') state?: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.many(
        `SELECT ${UNIT_COLUMNS} FROM units u
          WHERE u.facility_id = $1 AND ($2::text IS NULL OR u.unit_ref = $2) AND ($3::text IS NULL OR u.state = $3)
          ORDER BY u.created_at DESC LIMIT 500`,
        [f.id, ref ?? null, state ?? null],
      );
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const unit = await tx.must(`SELECT ${UNIT_COLUMNS} FROM units u WHERE u.id = $1 AND u.facility_id = $2`, [id, f.id], 'Unit');
      const holds = await tx.many(
        `SELECT id, hold_type AS "holdType", reference, applied_by AS "appliedBy", applied_at AS "appliedAt",
                released_by AS "releasedBy", released_at AS "releasedAt"
           FROM unit_holds WHERE unit_id = $1 ORDER BY applied_at`,
        [id],
      );
      return { ...unit, holds };
    });
  }

  /** Apply a hold (customs, line, terminal...). Maps to CUSRES / customs risk decisions. */
  @Post(':id/holds')
  @Roles(ROLES.operator, ROLES.planner, ROLES.edi)
  hold(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(HoldBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const u = await tx.must('SELECT id, unit_ref FROM units WHERE id = $1 AND facility_id = $2', [id, f.id], 'Unit');
      const h = await tx.one(
        `INSERT INTO unit_holds (tenant_id, unit_id, hold_type, reference, applied_by)
         VALUES (current_tenant(), $1,$2,$3,$4) RETURNING id, hold_type AS "holdType", reference, applied_at AS "appliedAt"`,
        [id, b.holdType, b.reference ?? null, ctx.subject],
      );
      await this.events.emit(tx, ctx, {
        type: 'hold.applied', aggregateType: 'unit', aggregateId: id, facilityId: f.id,
        payload: { unitRef: u.unit_ref, holdId: h.id, holdType: b.holdType, reference: b.reference ?? null },
      });
      return h;
    });
  }

  @Post(':id/holds/:holdId/release')
  @Roles(ROLES.operator, ROLES.planner, ROLES.edi)
  release(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Param('holdId', ParseUUIDPipe) holdId: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const u = await tx.must('SELECT id, unit_ref FROM units WHERE id = $1 AND facility_id = $2', [id, f.id], 'Unit');
      const h = await tx.one(
        `UPDATE unit_holds SET released_at = now(), released_by = $3
          WHERE id = $1 AND unit_id = $2 AND released_at IS NULL
          RETURNING id, hold_type AS "holdType", released_at AS "releasedAt"`,
        [holdId, id, ctx.subject],
      );
      if (!h) throw ApiError.notFound('Active hold');
      await this.events.emit(tx, ctx, {
        type: 'hold.released', aggregateType: 'unit', aggregateId: id, facilityId: f.id,
        payload: { unitRef: u.unit_ref, holdId, holdType: h.holdType },
      });
      return h;
    });
  }
}
