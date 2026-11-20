import { Injectable } from '@nestjs/common';
import { Tx } from '../platform/db/database.service';
import { ApiError } from '../platform/errors';
import {
  BlockInfo, chooseSlot, FacilityFlags, groupOf, Intent, parseSlot, RangeRule, slotCode, slotProblem, UnitProfile, WeightClass, YardUnit,
} from './allocation';

export interface Allocation {
  blockId: string;
  blockCode: string;
  position: string;
  /** Why this slot: the range it is in, or general space. */
  reason?: string;
}

const BLOCK_FOR_KIND: Record<string, string> = {
  CONTAINER: 'CONTAINER_STACK',
  BREAKBULK: 'LAYDOWN',
  VEHICLE: 'RORO_LANE',
  LIQUID: 'TANK',
};

interface UnitRow {
  id: string;
  cargo_kind: string;
  iso_type: string | null;
  weight_kg: string | null;
  is_reefer: boolean;
  dg_class: string | null;
  category: string;
  freight_kind: string;
  line: string | null;
  pod: string | null;
  visit_out_id: string | null;
  yard_block_id?: string | null;
  yard_position?: string | null;
}

const UNIT_COLS = `u.id, u.cargo_kind, u.iso_type, coalesce(u.vgm_kg, u.gross_weight_kg) AS weight_kg, u.is_reefer, u.dg_class,
  u.category, u.freight_kind, p.code AS line, u.pod, u.visit_out_id`;

export function profileOf(r: UnitRow): UnitProfile {
  const c = r.iso_type?.[0];
  const intent: Intent = r.freight_kind === 'MTY' ? 'EMPTY' : r.category === 'EXPORT' ? 'EXPORT' : r.category === 'TRANSSHIP' ? 'TRANSSHIP' : 'IMPORT';
  return {
    id: r.id,
    size: c === '2' ? '20' : c === '4' ? '40' : c === 'L' || c === 'M' ? '45' : null,
    weightKg: r.weight_kg === null ? null : Number(r.weight_kg),
    isReefer: r.is_reefer,
    dgClass: r.dg_class,
    intent,
    line: r.line,
    pod: r.pod,
    visitOutId: r.visit_out_id,
  };
}

/**
 * Yard allocation v2. Container stacks follow the rules and scoring in ./allocation (ranges, block rules,
 * stack groups). Laydown, RoRo lanes and tanks are capacity-based: position = <block>-<sequence>.
 * Allocations for one facility are serialised by locking its blocks, so two gate lanes never get one slot.
 */
@Injectable()
export class YardAllocator {
  async allocate(tx: Tx, facilityId: string, unitId: string, preferredBlock?: string): Promise<Allocation> {
    const unit = await this.unit(tx, unitId);
    const here = unit.yard_position ? parseSlot(unit.yard_position) : null;
    const avoid = here && unit.yard_block_id ? { blockId: unit.yard_block_id, bay: here.bay, row: here.row, tier: here.tier } : undefined;
    if (unit.cargo_kind !== 'CONTAINER') return this.allocateArea(tx, facilityId, unit.cargo_kind, preferredBlock);
    const ctx = await this.yardContext(tx, facilityId, preferredBlock);
    const u = profileOf(unit);
    const best = chooseSlot(ctx.blocks, ctx.unitsByBlock, ctx.ranges, u, ctx.flags, avoid);
    if (!best) {
      throw ApiError.conflict(
        'yard_full',
        `No slot for ${u.size ?? ''}${u.size ? "' " : ''}${u.isReefer ? 'reefer ' : ''}${u.dgClass ? `DG ${u.dgClass} ` : ''}${u.intent.toLowerCase()} unit${preferredBlock ? ` in block ${preferredBlock}` : ''}: every allowed stack is full, reserved for other cargo or against the block rules`,
      );
    }
    return {
      blockId: best.block.id,
      blockCode: best.block.code,
      position: slotCode(best.block.code, best.bay, best.row, best.tier),
      reason: best.range ? `range ${best.range.name}` : 'general space',
    };
  }

  /** Check an explicitly requested slot. With a unit, the block rules apply (a planner may still override ranges). */
  async resolve(tx: Tx, facilityId: string, position: string, unitId?: string): Promise<Allocation> {
    const blockCode = position.split('-')[0];
    const b = await tx.one<{ id: string; code: string; block_type: string }>(
      `SELECT b.id, b.code, b.block_type FROM yard_blocks b JOIN yards y ON y.id = b.yard_id
        WHERE y.facility_id = $1 AND b.code = $2 FOR UPDATE OF b`,
      [facilityId, blockCode],
    );
    if (!b) throw ApiError.invalid(`Unknown yard block in position ${position}`);
    const taken = await tx.one<{ unit_ref: string }>(
      `SELECT unit_ref FROM units WHERE facility_id = $1 AND yard_position = $2 AND state = 'IN_YARD' AND ($3::uuid IS NULL OR id <> $3)`,
      [facilityId, position, unitId ?? null],
    );
    if (taken) throw ApiError.conflict('slot_occupied', `${position} is occupied by ${taken.unit_ref}`);
    if (b.block_type === 'CONTAINER_STACK') {
      const slot = parseSlot(position);
      if (!slot) throw ApiError.invalid(`${position} is not <block>-<bay>-<row>-<tier>, e.g. ${b.code}-03-02-1`);
      if (unitId) {
        const ctx = await this.yardContext(tx, facilityId, b.code);
        const problem = slotProblem(ctx.blocks[0], ctx.unitsByBlock.get(b.id) ?? [], profileOf(await this.unit(tx, unitId)), slot.bay, slot.row, slot.tier, ctx.flags);
        if (problem) throw ApiError.conflict('slot_not_allowed', `${position}: ${problem}`);
      }
    }
    return { blockId: b.id, blockCode: b.code, position, reason: 'requested' };
  }

  private async unit(tx: Tx, unitId: string): Promise<UnitRow> {
    return tx.must<UnitRow>(
      `SELECT ${UNIT_COLS}, CASE WHEN u.state = 'IN_YARD' THEN u.yard_block_id END AS yard_block_id,
              CASE WHEN u.state = 'IN_YARD' THEN u.yard_position END AS yard_position
         FROM units u LEFT JOIN partners p ON p.id = u.line_operator_id WHERE u.id = $1`, [unitId], 'Unit',
    );
  }

  private async yardContext(tx: Tx, facilityId: string, onlyBlock?: string) {
    const all = await tx.many<{ id: string; code: string; bays: number; rows_count: number; tiers: number; allowed_sizes: string[]; max_stack_kg: number | null; reefer_plugs: number; dg_classes: string[] }>(
      `SELECT b.id, b.code, b.bays, b.rows_count, b.tiers, b.allowed_sizes, b.max_stack_kg, b.reefer_plugs, b.dg_classes
         FROM yard_blocks b JOIN yards y ON y.id = b.yard_id
        WHERE y.facility_id = $1 AND b.block_type = 'CONTAINER_STACK'
        ORDER BY y.code, b.code FOR UPDATE OF b`,
      [facilityId],
    );
    const flags: FacilityFlags = {
      hasReeferBlocks: all.some((b) => b.reefer_plugs > 0),
      hasDgBlocks: all.some((b) => b.dg_classes.length > 0),
    };
    const blocks: BlockInfo[] = all
      .filter((b) => !onlyBlock || b.code === onlyBlock)
      .map((b) => ({
        id: b.id, code: b.code, bays: b.bays, rows: b.rows_count, tiers: b.tiers, allowedSizes: b.allowed_sizes,
        maxStackKg: b.max_stack_kg, reeferPlugs: b.reefer_plugs, dgClasses: b.dg_classes,
      }));
    if (onlyBlock && !blocks.length) throw ApiError.invalid(`Unknown container block ${onlyBlock}`);
    const inYard = await tx.many<UnitRow>(
      `SELECT ${UNIT_COLS}, u.yard_block_id, u.yard_position FROM units u LEFT JOIN partners p ON p.id = u.line_operator_id
        WHERE u.facility_id = $1 AND u.state = 'IN_YARD' AND u.cargo_kind = 'CONTAINER' AND u.yard_block_id IS NOT NULL`,
      [facilityId],
    );
    const unitsByBlock = new Map<string, YardUnit[]>();
    for (const r of inYard) {
      const s = r.yard_position ? parseSlot(r.yard_position) : null;
      if (!s) continue;
      const p = profileOf(r);
      const list = unitsByBlock.get(r.yard_block_id!) ?? [];
      list.push({ id: r.id, bay: s.bay, row: s.row, tier: s.tier, size: p.size, weightKg: p.weightKg, isReefer: p.isReefer, group: groupOf(p) });
      unitsByBlock.set(r.yard_block_id!, list);
    }
    const ranges = (await tx.many<{ id: string; name: string; block_id: string; bay_from: number; bay_to: number; row_from: number; row_to: number; priority: number; purpose: RangeRule['purpose']; visit_id: string | null; pod: string | null; line_code: string | null; size: string | null; weight_class: WeightClass | null; reefer: boolean | null }>(
      `SELECT id, name, block_id, bay_from, bay_to, row_from, row_to, priority, purpose, visit_id, pod, line_code, size, weight_class, reefer
         FROM yard_ranges WHERE facility_id = $1 AND active ORDER BY priority, created_at`,
      [facilityId],
    )).map((r): RangeRule => ({
      id: r.id, name: r.name, blockId: r.block_id, bayFrom: r.bay_from, bayTo: r.bay_to, rowFrom: r.row_from, rowTo: r.row_to,
      priority: r.priority, purpose: r.purpose, visitId: r.visit_id, pod: r.pod, line: r.line_code, size: r.size,
      weightClass: r.weight_class, reefer: r.reefer,
    }));
    return { blocks, unitsByBlock, ranges, flags };
  }

  private async allocateArea(tx: Tx, facilityId: string, cargoKind: string, preferredBlock?: string): Promise<Allocation> {
    const blockType = BLOCK_FOR_KIND[cargoKind];
    const blocks = await tx.many<{ id: string; code: string; capacity: string | null }>(
      `SELECT b.id, b.code, b.capacity FROM yard_blocks b JOIN yards y ON y.id = b.yard_id
        WHERE y.facility_id = $1 AND b.block_type = $2 AND ($3::text IS NULL OR b.code = $3)
        ORDER BY y.code, b.code FOR UPDATE OF b`,
      [facilityId, blockType, preferredBlock ?? null],
    );
    for (const b of blocks) {
      const used = new Set(
        (await tx.many<{ yard_position: string }>(
          `SELECT yard_position FROM units WHERE yard_block_id = $1 AND state = 'IN_YARD' AND yard_position IS NOT NULL`, [b.id],
        )).map((r) => r.yard_position),
      );
      const cap = b.capacity ? Number(b.capacity) : Number.MAX_SAFE_INTEGER;
      for (let i = 1; i <= cap; i++) {
        const pos = `${b.code}-${String(i).padStart(4, '0')}`;
        if (!used.has(pos)) return { blockId: b.id, blockCode: b.code, position: pos, reason: 'first free place' };
      }
    }
    throw ApiError.conflict('yard_full', `No free ${blockType} space${preferredBlock ? ` in block ${preferredBlock}` : ''}`);
  }
}
