import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { YardAllocator } from '../inventory/yard-allocator';
import { isValidContainerNumber, isValidIsoType, isValidVin } from '../inventory/standards';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { FacilityRow } from '../platform/facility';
import { isoDateTime } from '../platform/validation';

export const LoadListItem = z.object({
  move: z.enum(['DISCHARGE', 'LOAD']).default('DISCHARGE'),
  unitRef: z.string().trim().toUpperCase().pipe(z.string().min(1).max(35)),
  cargoKind: z.enum(['CONTAINER', 'BREAKBULK', 'VEHICLE', 'LIQUID']).default('CONTAINER'),
  isoType: z.string().toUpperCase().optional(),
  freightKind: z.enum(['FCL', 'LCL', 'MTY', 'NA']).default('FCL'),
  category: z.enum(['IMPORT', 'EXPORT', 'TRANSSHIP', 'STORAGE']).optional(),
  grossWeightKg: z.number().nonnegative().optional(),
  vgmKg: z.number().nonnegative().optional(),
  quantity: z.number().positive().default(1),
  quantityUom: z.enum(['UNIT', 'PCS', 'MT', 'M3']).default('UNIT'),
  lineOperator: z.string().optional(),
  pol: z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/).optional(),
  pod: z.string().regex(/^[A-Z]{2}[A-Z2-9]{3}$/).optional(),
  dgClass: z.string().max(5).optional(),
  dgUnNumber: z.string().regex(/^[0-9]{4}$/).optional(),
  isReefer: z.boolean().default(false),
  seals: z.array(z.string().max(20)).default([]),
});
export type LoadListItem = z.infer<typeof LoadListItem>;

export const DischargeBody = z.object({
  unitRef: z.string().trim().toUpperCase(),
  position: z.string().optional(),
  block: z.string().optional(),
  cheId: z.string().optional(),
  completedAt: isoDateTime.optional(),
});

export const LoadBody = z.object({
  unitRef: z.string().trim().toUpperCase(),
  /** Vessel cell bay-row-tier (ISO 9711 / BAPLIE LOC+147), e.g. 0120682. */
  stowPosition: z.string().regex(/^[0-9]{6,7}$/, 'bay-row-tier, e.g. 0120682').optional(),
  cheId: z.string().optional(),
  completedAt: isoDateTime.optional(),
});

export interface VisitRow {
  id: string;
  visit_ref: string;
  phase: string;
  line_operator_id: string | null;
  voyage_in: string | null;
  vessel_name: string;
  imo: string;
  call_sign: string | null;
}

@Injectable()
export class VesselService {
  constructor(private readonly events: EventsService, private readonly yard: YardAllocator) {}

  async visit(tx: Tx, facility: FacilityRow, visitId: string, lock = false): Promise<VisitRow> {
    return tx.must<VisitRow>(
      `SELECT v.id, v.visit_ref, v.phase, v.line_operator_id, v.voyage_in, s.name AS vessel_name, s.imo, s.call_sign
         FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id
        WHERE v.id = $1 AND v.facility_id = $2 ${lock ? 'FOR UPDATE OF v' : ''}`,
      [visitId, facility.id],
      'Vessel visit',
    );
  }

  /**
   * Apply a load/discharge list (API, or COPRAR via the EDI gateway).
   * Re-sending an item for a unit still ADVISED on the same visit updates it (idempotent).
   */
  async applyLoadList(tx: Tx, ctx: RequestContext, facility: FacilityRow, visitId: string, items: LoadListItem[]) {
    const visit = await this.visit(tx, facility, visitId, true);
    if (['DEPARTED', 'CANCELLED'].includes(visit.phase)) throw ApiError.conflict('visit_closed', `Visit is ${visit.phase}`);

    const errors: { unitRef: string; message: string }[] = [];
    items.forEach((i) => {
      const e = validateIdentity(i);
      if (e) errors.push({ unitRef: i.unitRef, message: e });
    });
    if (errors.length) throw ApiError.invalid('Load list rejected', errors);

    const partnerIds = new Map<string, string>();
    for (const code of new Set(items.map((i) => i.lineOperator).filter(Boolean) as string[])) {
      const p = await tx.one<{ id: string }>('SELECT id FROM partners WHERE code = $1', [code]);
      if (!p) throw ApiError.invalid(`Unknown line operator ${code}`);
      partnerIds.set(code, p.id);
    }

    let created = 0;
    let updated = 0;
    for (const i of items) {
      const category = i.category ?? (i.move === 'DISCHARGE' ? 'IMPORT' : 'EXPORT');
      const lineOperatorId = i.lineOperator ? partnerIds.get(i.lineOperator)! : visit.line_operator_id;
      const existing = await tx.one<{ id: string; state: string; visit_in_id: string | null; visit_out_id: string | null }>(
        `SELECT id, state, visit_in_id, visit_out_id FROM units WHERE facility_id = $1 AND unit_ref = $2 AND state <> 'DEPARTED' FOR UPDATE`,
        [facility.id, i.unitRef],
      );
      const visitCol = i.move === 'DISCHARGE' ? 'visit_in_id' : 'visit_out_id';
      const values = [
        i.cargoKind, i.isoType ?? null, i.freightKind, category, i.grossWeightKg ?? null, i.vgmKg ?? null, i.quantity,
        i.quantityUom, lineOperatorId, i.pol ?? null, i.pod ?? null, i.dgClass ?? null, i.dgUnNumber ?? null, i.isReefer, i.seals,
      ];
      let unitId: string;
      if (existing) {
        const sameVisit = (i.move === 'DISCHARGE' ? existing.visit_in_id : existing.visit_out_id) === visitId;
        if (i.move === 'DISCHARGE' && !(existing.state === 'ADVISED' && sameVisit)) {
          throw ApiError.conflict('unit_active', `${i.unitRef} is already active at ${facility.code} (${existing.state})`);
        }
        if (i.move === 'LOAD' && existing.visit_out_id && !sameVisit) {
          throw ApiError.conflict('unit_booked', `${i.unitRef} is already planned on another outbound visit`);
        }
        if (i.move === 'LOAD' && existing.state !== 'ADVISED') {
          // A unit already in the yard (e.g. transshipment): only plan it onto the outbound visit.
          await tx.exec('UPDATE units SET visit_out_id = $2, pod = coalesce($3, pod) WHERE id = $1', [existing.id, visitId, i.pod ?? null]);
        } else await tx.exec(
          `UPDATE units SET cargo_kind=$2, iso_type=$3, freight_kind=$4, category=$5, gross_weight_kg=$6, vgm_kg=$7, quantity=$8,
             quantity_uom=$9, line_operator_id=$10, pol=$11, pod=$12, dg_class=$13, dg_un_number=$14, is_reefer=$15, seal_numbers=$16,
             ${visitCol} = $17
           WHERE id = $1`,
          [existing.id, ...values, visitId],
        );
        unitId = existing.id;
        updated++;
      } else {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO units (tenant_id, facility_id, unit_ref, cargo_kind, iso_type, freight_kind, category, gross_weight_kg, vgm_kg,
             quantity, quantity_uom, line_operator_id, pol, pod, dg_class, dg_un_number, is_reefer, seal_numbers, ${visitCol})
           VALUES (current_tenant(), $1, $2, $3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, $18) RETURNING id`,
          [facility.id, i.unitRef, ...values, visitId],
        );
        unitId = row!.id;
        created++;
      }
      const wi = await tx.one(
        `SELECT id FROM work_instructions WHERE unit_id = $1 AND visit_id = $2 AND move_kind = $3 AND status = 'PLANNED'`,
        [unitId, visitId, i.move],
      );
      if (!wi) {
        await tx.exec(
          `INSERT INTO work_instructions (tenant_id, facility_id, unit_id, visit_id, move_kind) VALUES (current_tenant(), $1,$2,$3,$4)`,
          [facility.id, unitId, visitId, i.move],
        );
      }
    }
    await this.events.emit(tx, ctx, {
      type: 'loadlist.updated', aggregateType: 'vessel_visit', aggregateId: visitId, facilityId: facility.id,
      payload: { visitRef: visit.visit_ref, created, updated, items: items.length },
    });
    return { visitRef: visit.visit_ref, created, updated };
  }

  /** Confirm a discharge move: unit leaves the vessel and is placed in the yard. COARRI source. */
  async discharge(tx: Tx, ctx: RequestContext, facility: FacilityRow, visitId: string, body: z.infer<typeof DischargeBody>) {
    const visit = await this.visit(tx, facility, visitId, true);
    if (!['ARRIVED', 'WORKING'].includes(visit.phase)) {
      throw ApiError.conflict('visit_not_working', `Visit must be ARRIVED or WORKING, is ${visit.phase}`);
    }
    const unit = await tx.one<{ id: string; cargo_kind: string; iso_type: string | null; state: string }>(
      `SELECT id, cargo_kind, iso_type, state FROM units
        WHERE facility_id = $1 AND unit_ref = $2 AND visit_in_id = $3 AND state <> 'DEPARTED' FOR UPDATE`,
      [facility.id, body.unitRef, visitId],
    );
    if (!unit) throw ApiError.notFound(`Unit ${body.unitRef} on visit ${visit.visit_ref}`);
    if (unit.state !== 'ADVISED') throw ApiError.conflict('already_discharged', `${body.unitRef} is ${unit.state}`);

    const alloc = body.position
      ? await this.yard.resolve(tx, facility.id, body.position)
      : await this.yard.allocate(tx, facility.id, unit.cargo_kind, body.block);
    const at = body.completedAt ?? new Date().toISOString();

    await tx.exec(
      `UPDATE units SET state = 'IN_YARD', yard_block_id = $2, yard_position = $3, time_in = $4 WHERE id = $1`,
      [unit.id, alloc.blockId, alloc.position, at],
    );
    await tx.exec(
      `UPDATE work_instructions SET status = 'COMPLETED', to_position = $3, from_position = 'VESSEL', che_id = $4, completed_at = $5
        WHERE unit_id = $1 AND visit_id = $2 AND move_kind = 'DISCHARGE' AND status = 'PLANNED'`,
      [unit.id, visitId, alloc.position, body.cheId ?? null, at],
    );
    if (visit.phase === 'ARRIVED') await tx.exec(`UPDATE vessel_visits SET phase = 'WORKING' WHERE id = $1`, [visitId]);

    await this.events.emit(tx, ctx, {
      type: 'unit.discharged', aggregateType: 'unit', aggregateId: unit.id, facilityId: facility.id, occurredAt: at,
      payload: { unitRef: body.unitRef, cargoKind: unit.cargo_kind, isoType: unit.iso_type, visitRef: visit.visit_ref, position: alloc.position },
    });
    return { unitId: unit.id, unitRef: body.unitRef, position: alloc.position, completedAt: at };
  }

  load(tx: Tx, ctx: RequestContext, facility: FacilityRow, visitId: string, body: z.infer<typeof LoadBody>) {
    return loadUnit(this, this.events, tx, ctx, facility, visitId, body);
  }

  /**
   * Close a visit at departure: loaded units leave the terminal, unworked moves are cancelled
   * (units planned for discharge but not discharged stay on board and are released from the visit).
   */
  async closeOnDeparture(tx: Tx, visitId: string, atd: string) {
    const departed = await tx.exec(
      `UPDATE units SET state = 'DEPARTED' WHERE visit_out_id = $1 AND state = 'LOADED'`,
      [visitId],
    );
    const cancelled = await tx.exec(
      `UPDATE work_instructions SET status = 'CANCELLED' WHERE visit_id = $1 AND status = 'PLANNED'`,
      [visitId],
    );
    const notDischarged = await tx.exec(
      `UPDATE units SET state = 'DEPARTED', time_out = $2 WHERE visit_in_id = $1 AND state = 'ADVISED' AND category <> 'EXPORT'`,
      [visitId, atd],
    );
    await tx.exec(`UPDATE units SET visit_out_id = NULL WHERE visit_out_id = $1 AND state IN ('ADVISED','IN_YARD')`, [visitId]);
    return { unitsDeparted: departed, movesCancelled: cancelled, notDischarged };
  }
}

/**
 * Confirm a load move: unit leaves the yard onto the vessel.
 * Enforces SOLAS VGM for packed containers and blocks units with active holds. COARRI (load) source.
 */
export async function loadUnit(
  service: VesselService,
  events: EventsService,
  tx: Tx,
  ctx: RequestContext,
  facility: FacilityRow,
  visitId: string,
  body: z.infer<typeof LoadBody>,
) {
  const visit = await service.visit(tx, facility, visitId, true);
  if (!['ARRIVED', 'WORKING'].includes(visit.phase)) {
    throw ApiError.conflict('visit_not_working', `Visit must be ARRIVED or WORKING, is ${visit.phase}`);
  }
  const unit = await tx.one<{
    id: string; cargo_kind: string; iso_type: string | null; state: string; freight_kind: string;
    vgm_kg: string | null; yard_position: string | null; dg_class: string | null;
  }>(
    `SELECT id, cargo_kind, iso_type, state, freight_kind, vgm_kg, yard_position, dg_class FROM units
      WHERE facility_id = $1 AND unit_ref = $2 AND visit_out_id = $3 AND state <> 'DEPARTED' FOR UPDATE`,
    [facility.id, body.unitRef, visitId],
  );
  if (!unit) throw ApiError.notFound(`Unit ${body.unitRef} planned on visit ${visit.visit_ref}`);
  if (unit.state === 'LOADED') throw ApiError.conflict('already_loaded', `${body.unitRef} is already loaded`);
  if (unit.state !== 'IN_YARD') throw ApiError.conflict('not_in_yard', `${body.unitRef} is ${unit.state}`);
  if (unit.cargo_kind === 'CONTAINER' && unit.freight_kind !== 'MTY' && !unit.vgm_kg) {
    throw ApiError.conflict('vgm_missing', `${body.unitRef} has no verified gross mass (SOLAS VI/2)`);
  }
  const holds = await tx.many<{ hold_type: string }>('SELECT hold_type FROM unit_holds WHERE unit_id = $1 AND released_at IS NULL', [unit.id]);
  if (holds.length) throw ApiError.conflict('on_hold', `${body.unitRef} has active holds: ${holds.map((h) => h.hold_type).join(', ')}`);

  const at = body.completedAt ?? new Date().toISOString();
  await tx.exec(
    `UPDATE units SET state = 'LOADED', stow_position = $2, yard_position = NULL, yard_block_id = NULL, time_out = $3 WHERE id = $1`,
    [unit.id, body.stowPosition ?? null, at],
  );
  const updated = await tx.exec(
    `UPDATE work_instructions SET status = 'COMPLETED', from_position = $3, to_position = $4, che_id = $5, completed_at = $6
      WHERE unit_id = $1 AND visit_id = $2 AND move_kind = 'LOAD' AND status = 'PLANNED'`,
    [unit.id, visitId, unit.yard_position, body.stowPosition ?? 'VESSEL', body.cheId ?? null, at],
  );
  if (!updated) {
    await tx.exec(
      `INSERT INTO work_instructions (tenant_id, facility_id, unit_id, visit_id, move_kind, from_position, to_position, che_id, status, completed_at)
       VALUES (current_tenant(), $1,$2,$3,'LOAD',$4,$5,$6,'COMPLETED',$7)`,
      [facility.id, unit.id, visitId, unit.yard_position, body.stowPosition ?? 'VESSEL', body.cheId ?? null, at],
    );
  }
  if (visit.phase === 'ARRIVED') await tx.exec(`UPDATE vessel_visits SET phase = 'WORKING' WHERE id = $1`, [visitId]);
  await events.emit(tx, ctx, {
    type: 'unit.loaded', aggregateType: 'unit', aggregateId: unit.id, facilityId: facility.id, occurredAt: at,
    payload: { unitRef: body.unitRef, cargoKind: unit.cargo_kind, isoType: unit.iso_type, visitRef: visit.visit_ref, stowPosition: body.stowPosition ?? null },
  });
  return { unitId: unit.id, unitRef: body.unitRef, stowPosition: body.stowPosition ?? null, completedAt: at };
}

function validateIdentity(i: LoadListItem): string | undefined {
  if (i.cargoKind === 'CONTAINER') {
    if (!isValidContainerNumber(i.unitRef)) return 'Invalid ISO 6346 container number or check digit';
    if (!i.isoType || !isValidIsoType(i.isoType)) return 'ISO 6346 size/type code required, e.g. 22G1';
  }
  if (i.cargoKind === 'VEHICLE' && !isValidVin(i.unitRef)) return 'Invalid ISO 3779 VIN';
  if (i.cargoKind === 'LIQUID' && i.quantityUom !== 'M3' && i.quantityUom !== 'MT') return 'Liquid parcels need quantity in M3 or MT';
  if (i.dgClass && !i.dgUnNumber) return 'IMDG cargo needs a UN number';
  return undefined;
}
