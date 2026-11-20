import { Injectable } from '@nestjs/common';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { FacilityRow } from '../platform/facility';
import type { BaplieCell } from '../edi/messages';
import { LoadListItem, VesselService } from './vessel.service';
import {
  Cell, cellsClash, cellSizeProblem, craneSplit, findRestows, hatchOf, parseCell, PlannedMove, sequenceHatch, StowItem, workload,
} from './stowage';

export interface BerthPlanInput {
  berth: string;
  quayFromM?: number;
  eta?: string;
  etb: string;
  etd: string;
  sideTo?: 'PORT' | 'STARBOARD';
}

export interface BayPlanCell {
  cell: string;
  bay: number;
  row: number;
  tier: number;
  deck: boolean;
  unitRef: string | null;
  isoType: string | null;
  weightKg: number | null;
  pol: string | null;
  pod: string | null;
  line: string | null;
  dgClass: string | null;
  isReefer: boolean;
  /** ROB, RESTOW, DISCHARGE (to come off), DISCHARGED, LOAD (planned), LOADED */
  state: string;
  crane: string | null;
}

const OPEN = ['PLANNED', 'DISPATCHED', 'IN_PROGRESS'];

/**
 * Vessel planning: berth plan, arrival stowage from BAPLIE, load stow planning, bay plan and crane split.
 * The crane split turns the visit's planned moves into one sequenced work queue per crane, so execution
 * (dispatch, devices) needs nothing vessel-specific.
 */
@Injectable()
export class PlanningService {
  constructor(
    private readonly events: EventsService,
    private readonly vessels: VesselService,
  ) {}

  // Berth plan ----------------------------------------------------------------------------------

  async placeOnBerth(tx: Tx, ctx: RequestContext, f: FacilityRow, visitId: string, b: BerthPlanInput) {
    const v = await tx.must<{ id: string; visit_ref: string; phase: string; loa_m: string | null; max_draft_m: string | null; name: string }>(
      `SELECT v.id, v.visit_ref, v.phase, s.loa_m, s.max_draft_m, s.name FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id
        WHERE v.id = $1 AND v.facility_id = $2 FOR UPDATE OF v`,
      [visitId, f.id],
      'Vessel visit',
    );
    if (['DEPARTED', 'CANCELLED'].includes(v.phase)) throw ApiError.conflict('visit_closed', `Visit is ${v.phase}`);
    if (!v.loa_m) throw ApiError.invalid(`Set the length overall (LOA) of ${v.name} before placing it on a berth`);
    const loa = Number(v.loa_m);
    const berth = await tx.must<{ id: string; code: string; start_mark_m: string; length_m: string; depth_m: string | null }>(
      'SELECT id, code, start_mark_m, length_m, depth_m FROM berths WHERE facility_id = $1 AND code = $2',
      [f.id, b.berth],
      `Berth ${b.berth}`,
    );
    const start = Number(berth.start_mark_m);
    const end = start + Number(berth.length_m);
    const from = b.quayFromM ?? start;
    if (from < start || from + loa > end) {
      throw ApiError.conflict('berth_too_short', `${v.name} (${loa} m) at ${from} m does not fit berth ${berth.code} (${start}–${end} m)`);
    }
    if (berth.depth_m && v.max_draft_m && Number(v.max_draft_m) > Number(berth.depth_m)) {
      throw ApiError.conflict('berth_too_shallow', `${v.name} draft ${v.max_draft_m} m exceeds berth ${berth.code} depth ${berth.depth_m} m`);
    }
    if (Date.parse(b.etd) <= Date.parse(b.etb)) throw ApiError.invalid('etd must be after etb');
    if (b.eta && Date.parse(b.eta) > Date.parse(b.etb)) throw ApiError.invalid('eta must not be after etb');

    const clashes = await tx.many<{ visit_ref: string; name: string; etb: Date; etd: Date; quay_from_m: string }>(
      `SELECT v.visit_ref, s.name, v.etb, v.etd, v.quay_from_m
         FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id
        WHERE v.facility_id = $1 AND v.id <> $2 AND v.quay_from_m IS NOT NULL AND v.phase NOT IN ('DEPARTED','CANCELLED')
          AND v.etb < $4::timestamptz AND v.etd > $3::timestamptz
          AND v.quay_from_m < $5::numeric + $6::numeric AND v.quay_from_m + coalesce(s.loa_m, 0) > $5::numeric`,
      [f.id, visitId, b.etb, b.etd, from, loa],
    );
    if (clashes.length) {
      throw ApiError.conflict(
        'berth_conflict',
        `Quay ${from}–${from + loa} m is taken in that window by ${clashes.map((c) => `${c.visit_ref} (${c.name})`).join(', ')}`,
      );
    }
    await tx.exec(
      `UPDATE vessel_visits SET berth_id = $2, berth = $3, quay_from_m = $4, etb = $5, etd = $6, eta = coalesce($7, eta, $5), side_to = $8
        WHERE id = $1`,
      [visitId, berth.id, berth.code, from, b.etb, b.etd, b.eta ?? null, b.sideTo ?? null],
    );
    await this.events.emit(tx, ctx, {
      type: 'vessel-call.updated', aggregateType: 'vessel_visit', aggregateId: visitId, facilityId: f.id,
      payload: { visitRef: v.visit_ref, berth: berth.code, quayFromM: from, etb: b.etb, etd: b.etd },
    });
    return { visitRef: v.visit_ref, berth: berth.code, quayFromM: from, quayToM: from + loa, etb: b.etb, etd: b.etd };
  }

  berthPlan(tx: Tx, f: FacilityRow, from: string, to: string) {
    return tx.many(
      `SELECT v.id, v.visit_ref AS "visitRef", v.phase, s.name AS "vesselName", s.vessel_type AS "vesselType", s.loa_m::float AS "loaM",
              p.code AS "lineOperator", v.berth, v.quay_from_m::float AS "quayFromM", v.eta, v.etb, v.etd, v.ata, v.atd, v.side_to AS "sideTo",
              (SELECT count(*)::int FROM work_instructions w WHERE w.visit_id = v.id AND w.status IN ('PLANNED','DISPATCHED','IN_PROGRESS')) AS "openMoves",
              (SELECT count(*)::int FROM work_instructions w WHERE w.visit_id = v.id AND w.status = 'COMPLETED') AS "doneMoves"
         FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id LEFT JOIN partners p ON p.id = v.line_operator_id
        WHERE v.facility_id = $1 AND v.phase <> 'CANCELLED'
          AND (v.quay_from_m IS NULL AND v.phase NOT IN ('DEPARTED')
               OR coalesce(v.atd, CASE WHEN v.phase IN ('ARRIVED','WORKING') THEN greatest(v.etd, now()) ELSE v.etd END) >= $2
                  AND coalesce(v.ata, v.etb) <= $3)
        ORDER BY coalesce(v.etb, v.eta, v.created_at)`,
      [f.id, from, to],
    );
  }

  // Arrival stowage (BAPLIE in) -----------------------------------------------------------------

  async applyBaplie(tx: Tx, ctx: RequestContext, f: FacilityRow, visitId: string, cells: BaplieCell[]) {
    if (!f.unlocode) throw ApiError.invalid(`Facility ${f.code} needs a UN/LOCODE to read a BAPLIE (which units are for this port)`);
    const visit = await this.vessels.visit(tx, f, visitId, true);
    if (['DEPARTED', 'CANCELLED'].includes(visit.phase)) throw ApiError.conflict('visit_closed', `Visit is ${visit.phase}`);
    const started = await tx.one(
      `SELECT 1 FROM work_instructions WHERE visit_id = $1 AND move_kind = 'DISCHARGE' AND status IN ('DISPATCHED','IN_PROGRESS','COMPLETED') LIMIT 1`,
      [visitId],
    );
    if (started) throw ApiError.conflict('discharge_started', 'Discharge has started; the arrival bay plan can no longer be replaced');

    const parsed = cells.map((c) => ({ c, cell: parseCell(c.cell) }));
    const bad = parsed.filter((p) => !p.cell).map((p) => p.c.cell);
    if (bad.length) throw ApiError.invalid(`Invalid cells: ${bad.join(', ')}`);
    const physical: Cell[] = [];
    for (const p of parsed) {
      if (physical.some((q) => cellsClash(q, p.cell!))) throw ApiError.invalid(`Cell ${p.cell!.cell} overlaps another occupied cell`);
      physical.push(p.cell!);
    }

    const items: StowItem[] = parsed.map((p) => ({
      cell: p.cell!, unitRef: p.c.unitRef ?? null, pod: p.c.pod ?? null,
      disposition: p.c.pod === f.unlocode ? 'DISCHARGE' : 'ROB',
    }));
    const restows = findRestows(items);

    // Discharge list for this port, through the same path as COPRAR / the load-list API.
    const lines = new Set((await tx.many<{ code: string }>('SELECT code FROM partners')).map((r) => r.code));
    const discharge = parsed.filter((p) => p.c.pod === f.unlocode);
    if (discharge.length) {
      const list: LoadListItem[] = discharge.map(({ c }) => ({
        move: 'DISCHARGE', unitRef: c.unitRef!, cargoKind: 'CONTAINER', isoType: c.isoType, freightKind: c.freightKind,
        grossWeightKg: c.weightKg, vgmKg: c.weightKg, quantity: 1, quantityUom: 'UNIT', isReefer: c.isReefer, seals: [],
        pol: c.pol, pod: c.pod, dgClass: c.dgClass, dgUnNumber: c.dgUnNumber,
        lineOperator: c.lineCode && lines.has(c.lineCode) ? c.lineCode : undefined,
      }));
      await this.vessels.applyLoadList(tx, ctx, f, visitId, list);
    }
    // Units removed from the arrival plan since the last BAPLIE are no longer to be discharged here.
    await tx.exec(
      `UPDATE work_instructions w SET status = 'CANCELLED', work_queue_id = NULL
         FROM units u
        WHERE u.id = w.unit_id AND w.visit_id = $1 AND w.move_kind = 'DISCHARGE' AND w.status = 'PLANNED'
          AND u.unit_ref IN (SELECT unit_ref FROM vessel_stow WHERE visit_id = $1 AND disposition = 'DISCHARGE')
          AND NOT (u.unit_ref = ANY($2))`,
      [visitId, discharge.map((d) => d.c.unitRef!)],
    );
    await tx.exec('DELETE FROM vessel_stow WHERE visit_id = $1', [visitId]);
    for (const { c, cell } of parsed) {
      const disposition = c.pod === f.unlocode ? 'DISCHARGE' : restows.has(cell!.cell) ? 'RESTOW' : 'ROB';
      await tx.exec(
        `INSERT INTO vessel_stow (tenant_id, visit_id, cell, unit_ref, iso_type, freight_kind, weight_kg, pol, pod, line_code,
                                  dg_class, dg_un_number, is_reefer, disposition)
         VALUES (current_tenant(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [visitId, cell!.cell, c.unitRef, c.isoType ?? null, c.freightKind, c.weightKg ?? null, c.pol ?? null, c.pod ?? null,
         c.lineCode ?? null, c.dgClass ?? null, c.dgUnNumber ?? null, c.isReefer, disposition],
      );
      if (disposition === 'DISCHARGE') {
        await tx.exec(
          `UPDATE work_instructions w SET from_position = $3 FROM units u
            WHERE u.id = w.unit_id AND w.visit_id = $1 AND u.unit_ref = $2 AND w.move_kind = 'DISCHARGE' AND w.status = 'PLANNED'`,
          [visitId, c.unitRef, cell!.cell],
        );
      }
    }
    const summary = {
      visitRef: visit.visit_ref, cells: parsed.length, discharge: discharge.length,
      restow: restows.size, remainOnBoard: parsed.length - discharge.length - restows.size,
    };
    await this.events.emit(tx, ctx, {
      type: 'bayplan.received', aggregateType: 'vessel_visit', aggregateId: visitId, facilityId: f.id, payload: summary,
    });
    return summary;
  }

  // Load stow planning ---------------------------------------------------------------------------

  async planStow(tx: Tx, ctx: RequestContext, f: FacilityRow, visitId: string, assignments: { unitRef: string; cell: string | null }[]) {
    const visit = await this.vessels.visit(tx, f, visitId, true);
    if (['DEPARTED', 'CANCELLED'].includes(visit.phase)) throw ApiError.conflict('visit_closed', `Visit is ${visit.phase}`);
    const errors: { unitRef: string; message: string }[] = [];

    // Cells that stay taken during and after this call: cargo remaining on board (restows go back to their cell),
    // units already loaded, and planned loads not touched by this request.
    const touched = new Set(assignments.map((a) => a.unitRef));
    const occupied: { cell: Cell; by: string }[] = [];
    for (const r of await tx.many<{ cell: string; unit_ref: string }>(
      `SELECT cell, unit_ref FROM vessel_stow WHERE visit_id = $1 AND disposition IN ('ROB','RESTOW')`, [visitId],
    )) occupied.push({ cell: parseCell(r.cell)!, by: r.unit_ref });
    for (const r of await tx.many<{ cell: string; unit_ref: string }>(
      `SELECT coalesce(CASE WHEN w.status = 'COMPLETED' THEN w.to_position END, w.planned_position) AS cell, u.unit_ref
         FROM work_instructions w JOIN units u ON u.id = w.unit_id
        WHERE w.visit_id = $1 AND w.move_kind = 'LOAD' AND w.status <> 'CANCELLED'
          AND coalesce(CASE WHEN w.status = 'COMPLETED' THEN w.to_position END, w.planned_position) ~ '^[0-9]{6,7}$'`,
      [visitId],
    )) if (!touched.has(r.unit_ref)) occupied.push({ cell: parseCell(r.cell)!, by: r.unit_ref });

    const planned: { id: string; unitRef: string; cell: Cell | null }[] = [];
    for (const a of assignments) {
      const wi = await tx.one<{ id: string; status: string; iso_type: string | null }>(
        `SELECT w.id, w.status, u.iso_type FROM work_instructions w JOIN units u ON u.id = w.unit_id
          WHERE w.visit_id = $1 AND u.unit_ref = $2 AND w.move_kind = 'LOAD' AND w.status <> 'CANCELLED' FOR UPDATE OF w`,
        [visitId, a.unitRef],
      );
      if (!wi) { errors.push({ unitRef: a.unitRef, message: 'not on the load list of this visit' }); continue; }
      if (wi.status !== 'PLANNED') { errors.push({ unitRef: a.unitRef, message: `load is already ${wi.status}` }); continue; }
      if (a.cell === null) { planned.push({ id: wi.id, unitRef: a.unitRef, cell: null }); continue; }
      const cell = parseCell(a.cell);
      if (!cell) { errors.push({ unitRef: a.unitRef, message: `${a.cell} is not bay-row-tier` }); continue; }
      const size = cellSizeProblem(cell, wi.iso_type);
      if (size) { errors.push({ unitRef: a.unitRef, message: size }); continue; }
      const clash = [...occupied, ...planned.filter((p) => p.cell).map((p) => ({ cell: p.cell!, by: p.unitRef }))].find((o) => cellsClash(o.cell, cell));
      if (clash) { errors.push({ unitRef: a.unitRef, message: `${cell.cell} is taken by ${clash.by}` }); continue; }
      planned.push({ id: wi.id, unitRef: a.unitRef, cell });
    }
    if (errors.length) throw ApiError.invalid('Stow plan rejected', errors);
    for (const p of planned) {
      await tx.exec('UPDATE work_instructions SET planned_position = $2, version = version + 1 WHERE id = $1', [p.id, p.cell?.cell ?? null]);
    }
    await this.events.emit(tx, ctx, {
      type: 'stowplan.updated', aggregateType: 'vessel_visit', aggregateId: visitId, facilityId: f.id,
      payload: { visitRef: visit.visit_ref, planned: planned.filter((p) => p.cell).length, cleared: planned.filter((p) => !p.cell).length },
    });
    return { visitRef: visit.visit_ref, planned: planned.filter((p) => p.cell).length, cleared: planned.filter((p) => !p.cell).length };
  }

  // Bay plan -------------------------------------------------------------------------------------

  async bayPlan(tx: Tx, f: FacilityRow, visitId: string) {
    const v = await tx.must<{ visit_ref: string; name: string; max_bay: number | null; max_row: number | null; hold_tiers: number | null; deck_tiers: number | null }>(
      `SELECT v.visit_ref, s.name, s.max_bay, s.max_row, s.hold_tiers, s.deck_tiers FROM vessel_visits v JOIN vessels s ON s.id = v.vessel_id
        WHERE v.id = $1 AND v.facility_id = $2`,
      [visitId, f.id],
      'Vessel visit',
    );
    const stow = await tx.many(
      `SELECT st.cell, st.unit_ref, st.iso_type, st.weight_kg, st.pol, st.pod, st.line_code, st.dg_class, st.is_reefer, st.disposition,
              w.status AS wi_status, q_eq.code AS crane
         FROM vessel_stow st
         LEFT JOIN units u ON u.unit_ref = st.unit_ref AND u.facility_id = $2 AND (u.visit_in_id = st.visit_id)
         LEFT JOIN work_instructions w ON w.unit_id = u.id AND w.visit_id = st.visit_id AND w.move_kind = 'DISCHARGE' AND w.status <> 'CANCELLED'
         LEFT JOIN work_queues q ON q.id = w.work_queue_id LEFT JOIN equipment q_eq ON q_eq.id = q.equipment_id
        WHERE st.visit_id = $1`,
      [visitId, f.id],
    );
    const loads = await tx.many(
      `SELECT coalesce(CASE WHEN w.status = 'COMPLETED' THEN w.to_position END, w.planned_position) AS cell, w.status, u.unit_ref, u.iso_type,
              coalesce(u.vgm_kg, u.gross_weight_kg) AS weight_kg, u.pol, u.pod, p.code AS line, u.dg_class, u.is_reefer, q_eq.code AS crane
         FROM work_instructions w JOIN units u ON u.id = w.unit_id LEFT JOIN partners p ON p.id = u.line_operator_id
         LEFT JOIN work_queues q ON q.id = w.work_queue_id LEFT JOIN equipment q_eq ON q_eq.id = q.equipment_id
        WHERE w.visit_id = $1 AND w.move_kind = 'LOAD' AND w.status <> 'CANCELLED'`,
      [visitId],
    );
    const cells: BayPlanCell[] = [];
    for (const s of stow) {
      const c = parseCell(s.cell)!;
      const state = s.disposition === 'DISCHARGE' ? (s.wi_status === 'COMPLETED' ? 'DISCHARGED' : 'DISCHARGE') : s.disposition;
      cells.push({
        cell: c.cell, bay: c.bay, row: c.row, tier: c.tier, deck: c.deck, unitRef: s.unit_ref, isoType: s.iso_type,
        weightKg: s.weight_kg === null ? null : Number(s.weight_kg), pol: s.pol, pod: s.pod, line: s.line_code, dgClass: s.dg_class,
        isReefer: s.is_reefer, state, crane: s.crane,
      });
    }
    const unplannedLoads: { unitRef: string; isoType: string | null; pod: string | null; weightKg: number | null }[] = [];
    for (const l of loads) {
      const c = l.cell ? parseCell(l.cell) : null;
      if (!c) {
        unplannedLoads.push({ unitRef: l.unit_ref, isoType: l.iso_type, pod: l.pod, weightKg: l.weight_kg === null ? null : Number(l.weight_kg) });
        continue;
      }
      cells.push({
        cell: c.cell, bay: c.bay, row: c.row, tier: c.tier, deck: c.deck, unitRef: l.unit_ref, isoType: l.iso_type,
        weightKg: l.weight_kg === null ? null : Number(l.weight_kg), pol: l.pol, pod: l.pod, line: l.line, dgClass: l.dg_class,
        isReefer: l.is_reefer, state: l.status === 'COMPLETED' ? 'LOADED' : 'LOAD', crane: l.crane,
      });
    }
    const maxBay = Math.max(v.max_bay ?? 0, ...cells.map((c) => c.bay + (c.bay % 2 === 0 ? 1 : 0)), 1);
    const maxRow = Math.max(v.max_row ?? 0, ...cells.map((c) => c.row), 0);
    const holdTiers = Math.max(v.hold_tiers ?? 0, ...cells.filter((c) => !c.deck).map((c) => c.tier / 2), 0);
    const deckTiers = Math.max(v.deck_tiers ?? 0, ...cells.filter((c) => c.deck).map((c) => (c.tier - 80) / 2), 0);
    cells.sort((a, b) => a.cell.localeCompare(b.cell));
    return {
      visitRef: v.visit_ref, vesselName: v.name,
      profile: { maxBay, maxRow, holdTiers, deckTiers },
      counts: cells.reduce<Record<string, number>>((m, c) => ({ ...m, [c.state]: (m[c.state] ?? 0) + 1 }), {}),
      cells, unplannedLoads,
    };
  }

  // Crane split ----------------------------------------------------------------------------------

  async craneSplit(tx: Tx, ctx: RequestContext, f: FacilityRow, visitId: string, b: { cranes: string[]; movesPerHour?: number }) {
    const visit = await this.vessels.visit(tx, f, visitId, true);
    if (['DEPARTED', 'CANCELLED'].includes(visit.phase)) throw ApiError.conflict('visit_closed', `Visit is ${visit.phase}`);
    if (new Set(b.cranes).size !== b.cranes.length) throw ApiError.invalid('Each crane can be listed once');
    const cranes = [];
    for (const code of b.cranes) {
      const e = await tx.one<{ id: string; kind: string; status: string }>('SELECT id, kind, status FROM equipment WHERE facility_id = $1 AND code = $2', [f.id, code]);
      if (!e) throw ApiError.notFound(`Equipment ${code}`);
      if (!['QC', 'MHC'].includes(e.kind)) throw ApiError.invalid(`${code} is a ${e.kind}, not a quay crane`);
      cranes.push({ code, ...e });
    }

    const wis = await tx.many<{ id: string; move_kind: 'DISCHARGE' | 'LOAD'; cell: string | null; unit_ref: string }>(
      `SELECT w.id, w.move_kind, CASE WHEN w.move_kind = 'DISCHARGE' THEN w.from_position ELSE w.planned_position END AS cell, u.unit_ref
         FROM work_instructions w JOIN units u ON u.id = w.unit_id
        WHERE w.visit_id = $1 AND w.status = 'PLANNED' AND w.move_kind IN ('DISCHARGE','LOAD') FOR UPDATE OF w`,
      [visitId],
    );
    // Moves without a cell (no BAPLIE yet, load not stowed) stay out of the crane queues until a re-split.
    const missing = wis.filter((w) => !w.cell || !parseCell(w.cell));
    const moves: PlannedMove[] = wis.filter((w) => w.cell && parseCell(w.cell)).map((w) => ({ id: w.id, kind: w.move_kind, cell: parseCell(w.cell!)! }));
    const restows: PlannedMove[] = (await tx.many<{ cell: string }>(
      `SELECT cell FROM vessel_stow WHERE visit_id = $1 AND disposition = 'RESTOW'`, [visitId],
    )).map((r, i) => ({ id: `restow-${i}`, kind: 'RESTOW', cell: parseCell(r.cell)! }));
    if (!moves.length) {
      throw ApiError.conflict('nothing_to_split', missing.length
        ? `None of the ${missing.length} planned move(s) has a vessel cell yet (discharges need a BAPLIE, loads a stow plan)`
        : 'No planned vessel moves to split');
    }

    const byHatch = new Map<number, PlannedMove[]>();
    for (const m of [...moves, ...restows]) byHatch.set(m.cell.hatch, [...(byHatch.get(m.cell.hatch) ?? []), m]);
    const split = craneSplit(
      cranes.map((c) => c.code),
      [...byHatch.entries()].map(([hatch, ms]) => ({
        hatch, load: workload(ms), bayFrom: Math.min(...ms.map((m) => m.cell.bay)), bayTo: Math.max(...ms.map((m) => m.cell.bay)),
      })),
    );

    const rate = b.movesPerHour ?? 25;
    await tx.exec('UPDATE vessel_visits SET moves_per_hour = $2 WHERE id = $1', [visitId, rate]);
    // Planned moves leave every queue of this visit; dispatched and in-progress ones stay where they are.
    await tx.exec(
      `UPDATE work_instructions SET work_queue_id = NULL, sequence = NULL WHERE visit_id = $1 AND status = 'PLANNED'`, [visitId],
    );
    const result = [];
    for (const [idx, s] of split.entries()) {
      const crane = cranes[idx];
      const code = `${visit.visit_ref}-${crane.code}`.slice(0, 40);
      const existing = await tx.one<{ id: string }>('SELECT id FROM work_queues WHERE facility_id = $1 AND code = $2 FOR UPDATE', [f.id, code]);
      let queueId: string;
      if (existing) {
        await tx.exec(
          `UPDATE work_queues SET bay_from = $2, bay_to = $3, status = CASE WHEN $4 THEN 'ACTIVE' ELSE status END, equipment_id = $5 WHERE id = $1`,
          [existing.id, s.bayFrom, s.bayTo, s.moves > 0, crane.id],
        );
        queueId = existing.id;
      } else {
        const row = await tx.one<{ id: string }>(
          `INSERT INTO work_queues (tenant_id, facility_id, code, name, pow_kind, visit_id, equipment_id, priority, bay_from, bay_to)
           VALUES (current_tenant(), $1,$2,$3,'VESSEL',$4,$5,10,$6,$7) RETURNING id`,
          [f.id, code, `${crane.code} on ${visit.visit_ref}`, visitId, crane.id, s.bayFrom, s.bayTo],
        );
        queueId = row!.id;
      }
      let seq = (await tx.one<{ n: number }>(
        'SELECT coalesce(max(sequence), 0)::int AS n FROM work_instructions WHERE work_queue_id = $1', [queueId],
      ))!.n;
      const ordered = s.hatches.flatMap((h) => sequenceHatch(byHatch.get(h) ?? []));
      for (const m of ordered) {
        if (m.kind === 'RESTOW') continue; // counted in the workload; restow moves are created in a later release
        await tx.exec('UPDATE work_instructions SET work_queue_id = $2, sequence = $3, version = version + 1 WHERE id = $1', [m.id, queueId, ++seq]);
      }
      result.push({
        crane: crane.code, craneStatus: crane.status, queue: code, bayFrom: s.bayFrom, bayTo: s.bayTo,
        moves: s.moves, restows: ordered.filter((m) => m.kind === 'RESTOW').length,
        hours: Math.round((s.moves / rate) * 10) / 10,
      });
    }
    // Queues of cranes no longer on this visit: close them, or suspend if a machine still holds a job.
    await tx.exec(
      `UPDATE work_queues q SET status = CASE WHEN EXISTS (SELECT 1 FROM work_instructions w WHERE w.work_queue_id = q.id AND w.status IN ('DISPATCHED','IN_PROGRESS'))
                                              THEN 'SUSPENDED' ELSE 'CLOSED' END
        WHERE q.visit_id = $1 AND q.pow_kind = 'VESSEL' AND q.status <> 'CLOSED' AND NOT (q.equipment_id = ANY($2::uuid[]))`,
      [visitId, cranes.map((c) => c.id)],
    );
    const summary = {
      visitRef: visit.visit_ref, movesPerHour: rate, totalMoves: workload([...moves, ...restows]),
      withoutCell: missing.map((m) => m.unit_ref),
      vesselHours: Math.max(...result.map((r) => r.hours)), cranes: result,
    };
    await this.events.emit(tx, ctx, {
      type: 'crane_split.published', aggregateType: 'vessel_visit', aggregateId: visitId, facilityId: f.id,
      payload: { visitRef: visit.visit_ref, cranes: result.map((r) => ({ crane: r.crane, bays: [r.bayFrom, r.bayTo], moves: r.moves })), vesselHours: summary.vesselHours },
    });
    return summary;
  }

  /** Cells on board after this port: remain-on-board and restows (back in their cells) plus loaded units. */
  async departureCells(tx: Tx, visitId: string): Promise<BaplieCell[]> {
    const rob = await tx.many(
      `SELECT cell, unit_ref, iso_type, freight_kind, weight_kg, pol, pod, line_code, dg_class, dg_un_number, is_reefer
         FROM vessel_stow WHERE visit_id = $1 AND disposition IN ('ROB','RESTOW')`,
      [visitId],
    );
    const loaded = await tx.many(
      `SELECT coalesce(u.stow_position, w.to_position) AS cell, u.unit_ref, u.iso_type, u.freight_kind, coalesce(u.vgm_kg, u.gross_weight_kg) AS weight_kg,
              u.pol, u.pod, p.code AS line_code, u.dg_class, u.dg_un_number, u.is_reefer
         FROM work_instructions w JOIN units u ON u.id = w.unit_id LEFT JOIN partners p ON p.id = u.line_operator_id
        WHERE w.visit_id = $1 AND w.move_kind = 'LOAD' AND w.status = 'COMPLETED'`,
      [visitId],
    );
    return [...rob, ...loaded]
      .filter((r) => r.cell && parseCell(r.cell))
      .map((r) => ({
        cell: parseCell(r.cell)!.cell, unitRef: r.unit_ref, isoType: r.iso_type ?? undefined, freightKind: r.freight_kind === 'MTY' ? 'MTY' : 'FCL',
        weightKg: r.weight_kg === null ? undefined : Number(r.weight_kg), pol: r.pol ?? undefined, pod: r.pod ?? undefined,
        lineCode: r.line_code ?? undefined, dgClass: r.dg_class ?? undefined, dgUnNumber: r.dg_un_number ?? undefined, isReefer: r.is_reefer,
      }));
  }
}

export { hatchOf };
