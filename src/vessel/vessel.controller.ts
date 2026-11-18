import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, FacilityScoped, Roles } from '../platform/auth/decorators';
import { RequestContext, ROLES } from '../platform/context';
import { DatabaseService } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { currentFacility } from '../platform/facility';
import { isoDateTime, parse } from '../platform/validation';
import { DischargeBody, LoadListItem, VesselService } from './vessel.service';

const VesselBody = z.object({
  imo: z.string().regex(/^[0-9]{7}$/),
  name: z.string().min(1),
  callSign: z.string().optional(),
  vesselType: z.enum(['CONTAINER', 'GENERAL_CARGO', 'RORO', 'TANKER', 'BULK', 'CRUISE', 'OTHER']).default('CONTAINER'),
  loaM: z.number().positive().optional(),
});

const VisitBody = z.object({
  visitRef: z.string().min(1).max(30),
  imo: z.string().regex(/^[0-9]{7}$/),
  lineOperator: z.string().optional(),
  voyageIn: z.string().optional(),
  voyageOut: z.string().optional(),
  berth: z.string().optional(),
  eta: isoDateTime.optional(),
  etd: isoDateTime.optional(),
});

@Controller('v1/vessels')
export class VesselsController {
  constructor(private readonly db: DatabaseService) {}

  @Post()
  @Roles(ROLES.planner)
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(VesselBody, body);
    return this.db.tx(ctx, (tx) =>
      tx.one(
        `INSERT INTO vessels (tenant_id, imo, name, call_sign, vessel_type, loa_m) VALUES (current_tenant(), $1,$2,$3,$4,$5)
         RETURNING id, imo, name, call_sign AS "callSign", vessel_type AS "vesselType", loa_m AS "loaM"`,
        [b.imo, b.name, b.callSign ?? null, b.vesselType, b.loaM ?? null],
      ),
    );
  }
}

/** Vessel visits (berth/port call). Maps to BERMAN/CALINF in, VESDEP out (see docs/edi-api-catalogue.md). */
@Controller('v1/visits')
@FacilityScoped()
export class VisitsController {
  constructor(private readonly db: DatabaseService, private readonly events: EventsService, private readonly vessels: VesselService) {}

  @Post()
  @Roles(ROLES.planner)
  create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const b = parse(VisitBody, body);
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const v = await tx.must('SELECT id FROM vessels WHERE imo = $1', [b.imo], `Vessel IMO ${b.imo}`);
      const op = b.lineOperator
        ? await tx.must('SELECT id FROM partners WHERE code = $1', [b.lineOperator], `Partner ${b.lineOperator}`)
        : null;
      const visit = await tx.one(
        `INSERT INTO vessel_visits (tenant_id, facility_id, vessel_id, visit_ref, line_operator_id, voyage_in, voyage_out, berth, eta, etd)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, visit_ref AS "visitRef", phase, voyage_in AS "voyageIn", voyage_out AS "voyageOut", berth, eta, etd`,
        [f.id, v.id, b.visitRef, op?.id ?? null, b.voyageIn ?? null, b.voyageOut ?? null, b.berth ?? null, b.eta ?? null, b.etd ?? null],
      );
      await this.events.emit(tx, ctx, {
        type: 'vessel-call.updated', aggregateType: 'vessel_visit', aggregateId: visit.id, facilityId: f.id,
        payload: { visitRef: b.visitRef, imo: b.imo, phase: 'PLANNED', eta: b.eta ?? null },
      });
      return visit;
    });
  }

  @Get(':id')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      return tx.must(
        `SELECT v.id, v.visit_ref AS "visitRef", v.phase, s.imo, s.name AS "vesselName", v.voyage_in AS "voyageIn",
                v.voyage_out AS "voyageOut", v.berth, v.eta, v.etd, v.ata, v.atd,
                (SELECT count(*)::int FROM work_instructions w WHERE w.visit_id = v.id AND w.status = 'PLANNED') AS "plannedMoves",
                (SELECT count(*)::int FROM work_instructions w WHERE w.visit_id = v.id AND w.status = 'COMPLETED') AS "completedMoves"
           FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id WHERE v.id = $1 AND v.facility_id = $2`,
        [id, f.id],
        'Vessel visit',
      );
    });
  }

  @Post(':id/arrive')
  @Roles(ROLES.planner, ROLES.operator)
  arrive(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ ata: isoDateTime.optional(), berth: z.string().optional() }), body);
    return this.transition(ctx, id, ['PLANNED'], 'ARRIVED', 'vessel.arrived', { ata: b.ata ?? new Date().toISOString(), berth: b.berth });
  }

  @Post(':id/depart')
  @Roles(ROLES.planner, ROLES.operator)
  depart(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ atd: isoDateTime.optional() }), body);
    return this.transition(ctx, id, ['ARRIVED', 'WORKING', 'COMPLETED'], 'DEPARTED', 'vessel.departed', { atd: b.atd ?? new Date().toISOString() });
  }

  /** Load/discharge list. API twin of COPRAR. */
  @Post(':id/load-lists')
  @Roles(ROLES.planner, ROLES.edi)
  loadList(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(z.object({ items: z.array(LoadListItem).min(1).max(5000) }), body);
    return this.db.tx(ctx, async (tx) => this.vessels.applyLoadList(tx, ctx, await currentFacility(tx, ctx), id, b.items));
  }

  /** Discharge confirmation from the quay (crane/checker). */
  @Post(':id/discharges')
  @Roles(ROLES.operator)
  discharge(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(DischargeBody, body);
    return this.db.tx(ctx, async (tx) => this.vessels.discharge(tx, ctx, await currentFacility(tx, ctx), id, b));
  }

  /** Completed vessel moves. API twin of COARRI. */
  @Get(':id/moves')
  moves(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      await this.vessels.visit(tx, f, id);
      return tx.many(
        `SELECT w.id, w.move_kind AS "moveKind", w.status, w.from_position AS "fromPosition", w.to_position AS "toPosition",
                w.che_id AS "cheId", w.completed_at AS "completedAt", u.unit_ref AS "unitRef", u.cargo_kind AS "cargoKind",
                u.iso_type AS "isoType", u.freight_kind AS "freightKind", u.gross_weight_kg AS "grossWeightKg"
           FROM work_instructions w JOIN units u ON u.id = w.unit_id
          WHERE w.visit_id = $1 ORDER BY w.completed_at NULLS LAST, u.unit_ref`,
        [id],
      );
    });
  }

  private transition(ctx: RequestContext, id: string, from: string[], to: string, event: string, data: Record<string, unknown>) {
    return this.db.tx(ctx, async (tx) => {
      const f = await currentFacility(tx, ctx);
      const v = await this.vessels.visit(tx, f, id, true);
      if (!from.includes(v.phase)) throw ApiError.conflict('invalid_phase', `Cannot move visit from ${v.phase} to ${to}`);
      const col = to === 'ARRIVED' ? 'ata' : 'atd';
      await tx.exec(
        `UPDATE vessel_visits SET phase = $2, ${col} = $3, berth = coalesce($4, berth) WHERE id = $1`,
        [id, to, data[col], (data.berth as string | undefined) ?? null],
      );
      await this.events.emit(tx, ctx, {
        type: event, aggregateType: 'vessel_visit', aggregateId: id, facilityId: f.id,
        payload: { visitRef: v.visit_ref, imo: v.imo, ...data },
      });
      return { id, visitRef: v.visit_ref, phase: to, ...data };
    });
  }
}
