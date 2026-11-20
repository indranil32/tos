/**
 * Stowage and crane-split rules, free of database code so they can be tested on their own.
 *
 * Cells follow ISO 9711 / BAPLIE LOC+147: bay (3) row (2) tier (2), e.g. 0120682 = bay 12, row 06, tier 82.
 * Odd bays hold 20' units, even bays hold 40'/45' units spanning the two odd bays around them (02 = 01 + 03).
 * Tiers 02..78 are in the hold, 80 and above on deck.
 */

export interface Cell {
  cell: string;
  bay: number;
  row: number;
  tier: number;
  deck: boolean;
  /** Hatch group: the 40' bay pair a cell belongs to (01, 02, 03 -> 0; 05, 06, 07 -> 1 ...). */
  hatch: number;
}

export function parseCell(raw: string): Cell | null {
  const s = raw.trim();
  if (!/^[0-9]{6,7}$/.test(s)) return null;
  const c = s.padStart(7, '0');
  const bay = Number(c.slice(0, 3));
  const row = Number(c.slice(3, 5));
  const tier = Number(c.slice(5, 7));
  if (bay < 1 || tier < 1) return null;
  return { cell: c, bay, row, tier, deck: tier >= 80, hatch: hatchOf(bay) };
}

export function hatchOf(bay: number): number {
  return Math.floor((bay - 1) / 4);
}

/** Odd bay numbers a cell physically occupies (a 40' in bay 02 occupies 01 and 03). */
export function physicalBays(bay: number): number[] {
  return bay % 2 === 0 ? [bay - 1, bay + 1] : [bay];
}

export function sizeOfIso(isoType?: string | null): '20' | '40' | '45' | null {
  if (!isoType) return null;
  const c = isoType[0];
  if (c === '2') return '20';
  if (c === '4') return '40';
  if (c === 'L' || c === 'M') return '45';
  return null;
}

/** Why a unit of this size cannot go in this cell, or null when it fits. */
export function cellSizeProblem(cell: Cell, isoType?: string | null): string | null {
  const size = sizeOfIso(isoType);
  if (!size) return null;
  if (size === '20' && cell.bay % 2 === 0) return `a 20' unit needs an odd bay; ${cell.cell} is in 40' bay ${cell.bay}`;
  if (size !== '20' && cell.bay % 2 === 1) return `a ${size}' unit needs an even bay; ${cell.cell} is in 20' bay ${cell.bay}`;
  return null;
}

/** Two cells clash when they share a stack position (row and tier) in overlapping physical bays. */
export function cellsClash(a: Cell, b: Cell): boolean {
  if (a.row !== b.row || a.tier !== b.tier) return false;
  const pa = physicalBays(a.bay);
  return physicalBays(b.bay).some((x) => pa.includes(x));
}

export interface StowItem {
  cell: Cell;
  unitRef: string | null;
  pod: string | null;
  disposition: 'ROB' | 'DISCHARGE' | 'RESTOW';
}

/**
 * Remain-on-board units that must come off and go back on so this port's discharges can be reached:
 * - above a discharge unit in the same stack (same row, same deck/hold, overlapping bays, higher tier);
 * - on deck in the same hatch as a discharge unit in the hold (the hatch cover has to be lifted).
 * Returns the cells to flag as RESTOW.
 */
export function findRestows(items: StowItem[]): Set<string> {
  const discharges = items.filter((i) => i.disposition === 'DISCHARGE');
  const out = new Set<string>();
  for (const i of items) {
    if (i.disposition !== 'ROB') continue;
    const blocks = discharges.some((d) => {
      if (d.cell.hatch !== i.cell.hatch) return false;
      if (!d.cell.deck && i.cell.deck) return true; // hatch cover
      if (d.cell.deck !== i.cell.deck || d.cell.row !== i.cell.row || i.cell.tier <= d.cell.tier) return false;
      const pd = physicalBays(d.cell.bay);
      return physicalBays(i.cell.bay).some((x) => pd.includes(x));
    });
    if (blocks) out.add(i.cell.cell);
  }
  return out;
}

export interface PlannedMove {
  id: string;
  kind: 'DISCHARGE' | 'LOAD' | 'RESTOW';
  cell: Cell;
}

/**
 * Crane work order inside one hatch: discharge deck top-down, discharge hold top-down, then load hold
 * bottom-up and load deck bottom-up. Restows come off with the discharges and go back on with the loads,
 * so they count as two moves.
 */
export function sequenceHatch(moves: PlannedMove[]): PlannedMove[] {
  const rank = (m: PlannedMove) => {
    const off = m.kind === 'DISCHARGE' || m.kind === 'RESTOW';
    if (off) return m.cell.deck ? 0 : 1;
    return m.cell.deck ? 3 : 2;
  };
  return [...moves].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r) return r;
    const off = rank(a) < 2;
    const t = off ? b.cell.tier - a.cell.tier : a.cell.tier - b.cell.tier;
    if (t) return t;
    return a.cell.bay - b.cell.bay || a.cell.row - b.cell.row;
  });
}

export function workload(moves: PlannedMove[]): number {
  return moves.reduce((n, m) => n + (m.kind === 'RESTOW' ? 2 : 1), 0);
}

export interface CraneAssignment {
  crane: string;
  hatches: number[];
  bayFrom: number | null;
  bayTo: number | null;
  moves: number;
}

/**
 * Split hatches between cranes as contiguous ranges (cranes on one rail cannot pass each other),
 * minimising the busiest crane's workload. Cranes are given in quay order, matching bay order
 * (bay 01 at the bow). Exact linear-partition dynamic programme: O(k * n^2), n = hatches.
 */
export function craneSplit(cranes: string[], hatchLoads: { hatch: number; load: number; bayFrom: number; bayTo: number }[]): CraneAssignment[] {
  const hs = [...hatchLoads].filter((h) => h.load > 0).sort((a, b) => a.hatch - b.hatch);
  const n = hs.length;
  const k = Math.min(cranes.length, Math.max(n, 1));
  const prefix = [0];
  for (const h of hs) prefix.push(prefix[prefix.length - 1] + h.load);
  const sum = (i: number, j: number) => prefix[j] - prefix[i]; // hatches i..j-1

  // best[c][j]: minimal max load splitting the first j hatches over c cranes; cut[c][j]: start of the last range.
  const best: number[][] = Array.from({ length: k + 1 }, () => Array(n + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: k + 1 }, () => Array(n + 1).fill(0));
  best[0][0] = 0;
  for (let c = 1; c <= k; c++) {
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= j; i++) {
        const v = Math.max(best[c - 1][i], sum(i, j));
        // Prefer later cuts on ties so the bow cranes are not left idle.
        if (v < best[c][j] || (v === best[c][j] && i > cut[c][j])) {
          best[c][j] = v;
          cut[c][j] = i;
        }
      }
    }
  }
  const ranges: [number, number][] = [];
  let j = n;
  for (let c = k; c >= 1; c--) {
    const i = cut[c][j];
    ranges.unshift([i, j]);
    j = i;
  }
  return cranes.map((crane, idx) => {
    const r = ranges[idx];
    const part = r ? hs.slice(r[0], r[1]) : [];
    return {
      crane,
      hatches: part.map((h) => h.hatch),
      bayFrom: part.length ? Math.min(...part.map((h) => h.bayFrom)) : null,
      bayTo: part.length ? Math.max(...part.map((h) => h.bayTo)) : null,
      moves: part.reduce((s, h) => s + h.load, 0),
    };
  });
}
