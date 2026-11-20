/**
 * Yard allocation rules for container stacks, free of database code.
 *
 * Hard rules (a slot that breaks one is never chosen, and an explicit slot that breaks one is refused):
 *  - the block allows the unit's size, and a stack holds one size only;
 *  - no floating units: tier t needs tier t-1 occupied;
 *  - a reefer needs a free reefer plug in the block (when the facility has reefer blocks at all);
 *  - a dangerous-goods unit goes only to a block that allows its IMDG class (when the facility has DG blocks at all);
 *  - the stack's weight stays within the block's limit.
 * Soft rules (scored): matching planner ranges first by priority; continue stacks of the same group
 * (export: vessel + POD + size + weight class); keep heavy units below lighter ones; keep plain units
 * out of reefer and DG blocks; space reserved by another range is never used.
 */

export type WeightClass = 'L' | 'M' | 'H';
export type Intent = 'EXPORT' | 'IMPORT' | 'EMPTY' | 'TRANSSHIP';

export interface UnitProfile {
  id: string;
  size: '20' | '40' | '45' | null;
  weightKg: number | null;
  isReefer: boolean;
  dgClass: string | null;
  intent: Intent;
  line: string | null;
  pod: string | null;
  visitOutId: string | null;
}

export interface BlockInfo {
  id: string;
  code: string;
  bays: number;
  rows: number;
  tiers: number;
  allowedSizes: string[];
  maxStackKg: number | null;
  reeferPlugs: number;
  dgClasses: string[];
}

export interface YardUnit {
  id: string;
  bay: number;
  row: number;
  tier: number;
  size: string | null;
  weightKg: number | null;
  isReefer: boolean;
  group: string;
}

export interface RangeRule {
  id: string;
  name: string;
  blockId: string;
  bayFrom: number;
  bayTo: number;
  rowFrom: number;
  rowTo: number;
  priority: number;
  purpose: Intent | 'ANY';
  visitId: string | null;
  pod: string | null;
  line: string | null;
  size: string | null;
  weightClass: WeightClass | null;
  reefer: boolean | null;
}

export interface Candidate {
  block: BlockInfo;
  bay: number;
  row: number;
  tier: number;
  score: number;
  range: RangeRule | null;
}

export function weightClass(kg: number | null): WeightClass | null {
  if (kg === null || Number.isNaN(kg)) return null;
  if (kg < 10_000) return 'L';
  if (kg <= 20_000) return 'M';
  return 'H';
}

const CLASS_RANK: Record<WeightClass, number> = { L: 0, M: 1, H: 2 };

/** Units that stack together well: same intent and the same downstream move. */
export function groupOf(u: UnitProfile): string {
  switch (u.intent) {
    case 'EXPORT':
      return `EXP|${u.visitOutId ?? '-'}|${u.pod ?? '-'}|${u.size ?? '-'}|${weightClass(u.weightKg) ?? '-'}`;
    case 'TRANSSHIP':
      return `TS|${u.visitOutId ?? '-'}|${u.pod ?? '-'}|${u.size ?? '-'}`;
    case 'EMPTY':
      return `MTY|${u.line ?? '-'}|${u.size ?? '-'}`;
    default:
      return `IMP|${u.line ?? '-'}|${u.size ?? '-'}`;
  }
}

export function rangeMatches(r: RangeRule, u: UnitProfile): boolean {
  if (r.purpose !== 'ANY' && r.purpose !== u.intent) return false;
  if (r.visitId && r.visitId !== u.visitOutId) return false;
  if (r.pod && r.pod !== u.pod) return false;
  if (r.line && r.line !== u.line) return false;
  if (r.size && r.size !== u.size) return false;
  if (r.weightClass && r.weightClass !== weightClass(u.weightKg)) return false;
  if (r.reefer !== null && r.reefer !== u.isReefer) return false;
  return true;
}

function inRange(r: RangeRule, blockId: string, bay: number, row: number) {
  return r.blockId === blockId && bay >= r.bayFrom && bay <= r.bayTo && row >= r.rowFrom && row <= r.rowTo;
}

export function dgAllowed(blockClasses: string[], dgClass: string): boolean {
  const main = dgClass.split('.')[0];
  return blockClasses.some((c) => c === dgClass || c === main);
}

export interface FacilityFlags {
  /** Some block has reefer plugs: reefers must go to one. */
  hasReeferBlocks: boolean;
  /** Some block lists DG classes: DG units must go to one that allows theirs. */
  hasDgBlocks: boolean;
}

/** Why the unit may not go in this slot, or null when it may. Ranges are not checked here (a planner may override them). */
export function slotProblem(
  block: BlockInfo, units: YardUnit[], u: UnitProfile, bay: number, row: number, tier: number, flags: FacilityFlags,
): string | null {
  if (bay < 1 || bay > block.bays || row < 1 || row > block.rows || tier < 1 || tier > block.tiers) {
    return `${block.code} has ${block.bays} bays, ${block.rows} rows and ${block.tiers} tiers`;
  }
  if (u.size && !block.allowedSizes.includes(u.size)) return `${block.code} takes ${block.allowedSizes.join('/')}' units, not ${u.size}'`;
  const stack = units.filter((x) => x.bay === bay && x.row === row && x.id !== u.id).sort((a, b) => a.tier - b.tier);
  if (stack.some((x) => x.tier === tier)) return 'slot is occupied';
  if (stack.some((x) => x.tier > tier)) return 'a unit would be put under another one';
  const height = stack.length ? stack[stack.length - 1].tier : 0;
  if (tier !== height + 1) return `tier ${tier} would float: the stack is ${height} high`;
  if (u.size && stack.some((x) => x.size && x.size !== u.size)) return `the stack holds ${stack.find((x) => x.size)!.size}' units`;
  if (u.isReefer && flags.hasReeferBlocks) {
    if (block.reeferPlugs === 0) return `${block.code} has no reefer plugs`;
    const plugged = units.filter((x) => x.isReefer && x.id !== u.id).length;
    if (plugged >= block.reeferPlugs) return `all ${block.reeferPlugs} reefer plugs in ${block.code} are taken`;
  }
  if (u.dgClass && flags.hasDgBlocks && !dgAllowed(block.dgClasses, u.dgClass)) {
    return `${block.code} does not take IMDG class ${u.dgClass}`;
  }
  if (block.maxStackKg && u.weightKg) {
    const total = stack.reduce((s, x) => s + (x.weightKg ?? 0), 0) + u.weightKg;
    if (total > block.maxStackKg) return `stack would weigh ${Math.round(total)} kg, over the ${block.maxStackKg} kg limit`;
  }
  return null;
}

/**
 * Best slot for the unit, or null when the yard has none that follows the rules.
 * Lower score wins; ties go to the lowest block, bay and row so results are repeatable.
 */
export function chooseSlot(
  blocks: BlockInfo[], unitsByBlock: Map<string, YardUnit[]>, ranges: RangeRule[], u: UnitProfile, flags: FacilityFlags,
  /** For a move inside the yard: the slot the unit is in now, which is never the answer. */
  avoid?: { blockId: string; bay: number; row: number; tier: number },
): Candidate | null {
  const group = groupOf(u);
  const matching = ranges.filter((r) => rangeMatches(r, u)).sort((a, b) => a.priority - b.priority);
  const others = ranges.filter((r) => !matching.includes(r));
  const wc = weightClass(u.weightKg);
  let best: Candidate | null = null;

  for (const block of blocks) {
    const units = unitsByBlock.get(block.id) ?? [];
    for (let bay = 1; bay <= block.bays; bay++) {
      for (let row = 1; row <= block.rows; row++) {
        const range = matching.find((r) => inRange(r, block.id, bay, row)) ?? null;
        if (!range && others.some((r) => inRange(r, block.id, bay, row))) continue; // reserved for other cargo
        const stack = units.filter((x) => x.bay === bay && x.row === row && x.id !== u.id).sort((a, b) => a.tier - b.tier);
        const tier = (stack.length ? stack[stack.length - 1].tier : 0) + 1;
        if (tier > block.tiers) continue;
        if (avoid && avoid.blockId === block.id && avoid.bay === bay && avoid.row === row && avoid.tier === tier) continue;
        if (slotProblem(block, units, u, bay, row, tier, flags)) continue;

        let score = range ? matching.indexOf(range) * 1000 : 100_000;
        if (stack.length === 0) score += 20;
        else if (stack.every((x) => x.group === group)) score -= 30 - tier; // continue a stack of the same group
        else score += 200; // mixing groups means re-handles later
        const top = stack[stack.length - 1];
        if (top && u.intent === 'EXPORT' && wc && CLASS_RANK[wc] > CLASS_RANK[weightClass(top.weightKg) ?? 'M']) score += 100; // heavy on light
        if (!u.isReefer && block.reeferPlugs > 0) score += 300;
        if (!u.dgClass && block.dgClasses.length > 0) score += 5000;
        if (!best || score < best.score) best = { block, bay, row, tier, score, range };
      }
    }
  }
  return best;
}

export function slotCode(block: string, bay: number, row: number, tier: number) {
  return `${block}-${String(bay).padStart(2, '0')}-${String(row).padStart(2, '0')}-${tier}`;
}

export function parseSlot(position: string): { block: string; bay: number; row: number; tier: number } | null {
  const m = /^(.+)-(\d{2})-(\d{2})-(\d{1,2})$/.exec(position);
  return m ? { block: m[1], bay: Number(m[2]), row: Number(m[3]), tier: Number(m[4]) } : null;
}
