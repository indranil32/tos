import { Injectable } from '@nestjs/common';
import { RequestContext } from '../platform/context';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import { EventsService } from '../platform/events/events.service';
import { FacilityRow } from '../platform/facility';
import { EquipmentRow, EquipmentService, UNAVAILABLE } from '../equipment/equipment.service';
import { YardAllocator } from '../inventory/yard-allocator';
import { VesselService } from '../vessel/vessel.service';

/** Moves that relocate a unit inside the yard and are completed by the work module itself. */
export const YARD_MOVES = ['YARD_SHIFT', 'HOUSEKEEPING'];

export interface InstructionRow {
  id: string;
  queue: string | null;
  queueId: string | null;
  sequence: number | null;
  moveKind: string;
  status: string;
  unitId: string;
  unitRef: string;
  isoType: string | null;
  cargoKind: string;
  visitId: string | null;
  visitRef: string | null;
  fromPosition: string | null;
  toPosition: string | null;
  plannedPosition: string | null;
  equipment: string | null;
  dispatchedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  version: number;
}

export const INSTRUCTION_SELECT = `
  SELECT w.id, q.code AS queue, w.work_queue_id AS "queueId", w.sequence, w.move_kind AS "moveKind", w.status,
         u.id AS "unitId", u.unit_ref AS "unitRef", u.iso_type AS "isoType", u.cargo_kind AS "cargoKind",
         w.visit_id AS "visitId", v.visit_ref AS "visitRef",
         coalesce(w.from_position, CASE WHEN w.move_kind = 'DISCHARGE' THEN 'VESSEL' ELSE u.yard_position END) AS "fromPosition",
         w.to_position AS "toPosition", w.planned_position AS "plannedPosition", e.code AS equipment,
         w.dispatched_at AS "dispatchedAt", w.started_at AS "startedAt", w.completed_at AS "completedAt", w.version
    FROM work_instructions w
    JOIN units u ON u.id = w.unit_id
    LEFT JOIN work_queues q ON q.id = w.work_queue_id
    LEFT JOIN vessel_visits v ON v.id = w.visit_id
    LEFT JOIN equipment e ON e.id = w.equipment_id`;

/**
 * Work instruction life cycle: PLANNED -> DISPATCHED -> IN_PROGRESS -> COMPLETED (or back to PLANNED when rejected
 * or when the machine breaks down). The dispatcher is rule-based (v1): a machine asks for work and gets the head of
 * the most urgent active queue it may serve, either as the queue's dedicated machine or through the queue's pool.
 */
@Injectable()
export class WorkService {
  constructor(
    private readonly events: EventsService,
    private readonly equipment: EquipmentService,
    private readonly yard: YardAllocator,
    private readonly vessel: VesselService,
  ) {}

  instruction(tx: Tx, facilityId: string, id: string, lock = false): Promise<InstructionRow> {
    return tx.must<InstructionRow>(
      `${INSTRUCTION_SELECT} WHERE w.facility_id = $1 AND w.id = $2${lock ? ' FOR UPDATE OF w' : ''}`,
      [facilityId, id],
      'Work instruction',
    );
  }

  /** Give the machine its current job, or the next one from the queues it serves. */
  async next(tx: Tx, ctx: RequestContext, f: FacilityRow, eq: EquipmentRow): Promise<InstructionRow | null> {
    if (UNAVAILABLE.includes(eq.status)) {
      throw ApiError.conflict('equipment_unavailable', `${eq.code} is ${eq.status}; log on first`);
    }
    const current = await tx.one<{ id: string }>(
      `SELECT id FROM work_instructions WHERE equipment_id = $1 AND status IN ('DISPATCHED','IN_PROGRESS') ORDER BY dispatched_at LIMIT 1`,
      [eq.id],
    );
    if (current) return this.instruction(tx, f.id, current.id);

    // Head of each eligible queue: the lowest planned sequence. A queue's order is kept: one job per queue at a time
    // for dedicated machines; pooled queues hand out their next planned move to whichever machine asks first.
    const pick = await tx.one<{ id: string }>(
      `SELECT w.id
         FROM work_instructions w JOIN work_queues q ON q.id = w.work_queue_id
        WHERE q.facility_id = $1 AND q.status = 'ACTIVE' AND w.status = 'PLANNED'
          AND (q.equipment_id = $2 OR ($3::uuid IS NOT NULL AND q.pool_id = $3))
          AND NOT EXISTS (SELECT 1 FROM unit_holds h WHERE h.unit_id = w.unit_id AND h.released_at IS NULL AND w.move_kind IN ('LOAD'))
        ORDER BY q.priority, q.created_at, w.sequence NULLS LAST, w.created_at
        LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
      [f.id, eq.id, eq.poolId],
    );
    if (!pick) return null;
    await tx.exec(
      `UPDATE work_instructions SET status = 'DISPATCHED', equipment_id = $2, dispatched_at = now(), version = version + 1 WHERE id = $1`,
      [pick.id, eq.id],
    );
    await tx.exec(`UPDATE equipment SET status = 'WORKING', status_since = CASE WHEN status = 'WORKING' THEN status_since ELSE now() END WHERE id = $1`, [eq.id]);
    const wi = await this.instruction(tx, f.id, pick.id);
    await this.events.emit(tx, ctx, {
      type: 'work.dispatched', aggregateType: 'work_instruction', aggregateId: wi.id, facilityId: f.id,
      payload: { equipment: eq.code, queue: wi.queue, unitRef: wi.unitRef, moveKind: wi.moveKind },
    });
    return wi;
  }

  async start(tx: Tx, ctx: RequestContext, f: FacilityRow, id: string, eq: EquipmentRow, version?: number) {
    const wi = await this.owned(tx, f, id, eq, version);
    if (wi.status !== 'DISPATCHED') throw ApiError.conflict('not_dispatched', `Instruction is ${wi.status}`);
    await tx.exec(`UPDATE work_instructions SET status = 'IN_PROGRESS', started_at = now(), version = version + 1 WHERE id = $1`, [id]);
    await this.events.emit(tx, ctx, {
      type: 'work.started', aggregateType: 'work_instruction', aggregateId: id, facilityId: f.id,
      payload: { equipment: eq.code, unitRef: wi.unitRef, moveKind: wi.moveKind },
    });
    return this.instruction(tx, f.id, id);
  }

  /** Hand a job back to its queue (blocked slot, wrong unit, operator cannot do it). */
  async reject(tx: Tx, ctx: RequestContext, f: FacilityRow, id: string, eq: EquipmentRow, reason: string, version?: number) {
    await this.owned(tx, f, id, eq, version);
    await tx.exec(
      `UPDATE work_instructions SET status = 'PLANNED', equipment_id = NULL, dispatched_at = NULL, started_at = NULL, version = version + 1 WHERE id = $1`,
      [id],
    );
    await this.settleEquipment(tx, eq);
    await this.events.emit(tx, ctx, {
      type: 'work.released', aggregateType: 'work_instruction', aggregateId: id, facilityId: f.id, payload: { equipment: eq.code, reason },
    });
    return this.instruction(tx, f.id, id);
  }

  /**
   * Confirm the move. Yard moves relocate the unit here; vessel moves go through the vessel module so that
   * COARRI, billing and VGM rules apply exactly as for a direct confirmation.
   */
  async complete(
    tx: Tx, ctx: RequestContext, f: FacilityRow, id: string, eq: EquipmentRow,
    body: { toPosition?: string; stowPosition?: string; version?: number },
  ) {
    const wi = await this.owned(tx, f, id, eq, body.version);
    if (wi.status === 'DISPATCHED') await tx.exec(`UPDATE work_instructions SET started_at = now() WHERE id = $1`, [id]);

    let position: string;
    if (YARD_MOVES.includes(wi.moveKind)) {
      position = await this.yardMove(tx, ctx, f, wi, eq, body.toPosition ?? wi.plannedPosition ?? undefined);
    } else if (wi.moveKind === 'DISCHARGE' && wi.visitId) {
      const r = await this.vessel.discharge(tx, ctx, f, wi.visitId, {
        unitRef: wi.unitRef, position: body.toPosition ?? wi.plannedPosition ?? undefined, cheId: eq.code,
      });
      position = r.position;
    } else if (wi.moveKind === 'LOAD' && wi.visitId) {
      const stow = body.stowPosition ?? wi.plannedPosition ?? undefined;
      await this.vessel.load(tx, ctx, f, wi.visitId, { unitRef: wi.unitRef, stowPosition: stow, cheId: eq.code });
      position = stow ?? 'VESSEL';
    } else {
      throw ApiError.conflict('unsupported_move', `${wi.moveKind} moves are confirmed through their own module`);
    }
    await tx.exec(
      `UPDATE work_instructions SET status = 'COMPLETED', equipment_id = $2, che_id = $3, to_position = $4,
              completed_at = coalesce(completed_at, now()), version = version + 1 WHERE id = $1`,
      [id, eq.id, eq.code, position],
    );
    await tx.exec(`UPDATE equipment SET position = $2 WHERE id = $1`, [eq.id, position]);
    await this.settleEquipment(tx, eq);
    await this.events.emit(tx, ctx, {
      type: 'work.completed', aggregateType: 'work_instruction', aggregateId: id, facilityId: f.id,
      payload: { equipment: eq.code, queue: wi.queue, unitRef: wi.unitRef, moveKind: wi.moveKind, toPosition: position },
    });
    return this.instruction(tx, f.id, id);
  }

  private async yardMove(tx: Tx, ctx: RequestContext, f: FacilityRow, wi: InstructionRow, eq: EquipmentRow, target?: string) {
    const unit = await tx.must<{ id: string; state: string; yard_position: string | null; cargo_kind: string }>(
      'SELECT id, state, yard_position, cargo_kind FROM units WHERE id = $1 FOR UPDATE',
      [wi.unitId],
      'Unit',
    );
    if (unit.state !== 'IN_YARD') throw ApiError.conflict('not_in_yard', `${wi.unitRef} is ${unit.state}`);
    const alloc = target ? await this.yard.resolve(tx, f.id, target) : await this.yard.allocate(tx, f.id, unit.cargo_kind);
    if (alloc.position === unit.yard_position) throw ApiError.invalid(`${wi.unitRef} is already at ${alloc.position}`);
    const taken = await tx.one(
      `SELECT unit_ref FROM units WHERE facility_id = $1 AND yard_position = $2 AND state = 'IN_YARD' AND id <> $3`,
      [f.id, alloc.position, unit.id],
    );
    if (taken) throw ApiError.conflict('slot_occupied', `${alloc.position} is occupied by ${taken.unit_ref}`);
    await tx.exec(`UPDATE units SET yard_block_id = $2, yard_position = $3 WHERE id = $1`, [unit.id, alloc.blockId, alloc.position]);
    await tx.exec(`UPDATE work_instructions SET from_position = $2 WHERE id = $1`, [wi.id, unit.yard_position]);
    await this.events.emit(tx, ctx, {
      type: 'unit.moved', aggregateType: 'unit', aggregateId: unit.id, facilityId: f.id,
      payload: { unitRef: wi.unitRef, from: unit.yard_position, to: alloc.position, moveKind: wi.moveKind, equipment: eq.code },
    });
    return alloc.position;
  }

  private async owned(tx: Tx, f: FacilityRow, id: string, eq: EquipmentRow, version?: number) {
    const wi = await this.instruction(tx, f.id, id, true);
    if (wi.equipment !== eq.code || !['DISPATCHED', 'IN_PROGRESS'].includes(wi.status)) {
      throw ApiError.conflict('not_assigned', `Instruction is ${wi.status}${wi.equipment ? ` on ${wi.equipment}` : ''}, not with ${eq.code}`);
    }
    if (version !== undefined && version !== wi.version) {
      throw ApiError.conflict('stale_version', `Instruction changed (version ${wi.version}, you sent ${version}); refresh and retry`);
    }
    return wi;
  }

  /** A machine with no open job left goes back to IDLE (unless it was taken out of service meanwhile). */
  private async settleEquipment(tx: Tx, eq: EquipmentRow) {
    await tx.exec(
      `UPDATE equipment e SET status = 'IDLE', status_since = now()
        WHERE e.id = $1 AND e.status = 'WORKING'
          AND NOT EXISTS (SELECT 1 FROM work_instructions w WHERE w.equipment_id = e.id AND w.status IN ('DISPATCHED','IN_PROGRESS'))`,
      [eq.id],
    );
  }
}
