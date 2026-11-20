import { BlockInfo, chooseSlot, FacilityFlags, groupOf, RangeRule, slotProblem, UnitProfile, weightClass, YardUnit } from '../src/inventory/allocation';

const block = (over: Partial<BlockInfo> = {}): BlockInfo => ({
  id: 'b1', code: 'A1', bays: 3, rows: 2, tiers: 3, allowedSizes: ['20', '40', '45'], maxStackKg: null, reeferPlugs: 0, dgClasses: [], ...over,
});
const unit = (over: Partial<UnitProfile> = {}): UnitProfile => ({
  id: 'u', size: '20', weightKg: 15000, isReefer: false, dgClass: null, intent: 'IMPORT', line: 'MSC', pod: null, visitOutId: null, ...over,
});
const at = (id: string, bay: number, row: number, tier: number, u: Partial<UnitProfile> = {}): YardUnit => {
  const p = unit({ id, ...u });
  return { id, bay, row, tier, size: p.size, weightKg: p.weightKg, isReefer: p.isReefer, group: groupOf(p) };
};
const range = (over: Partial<RangeRule>): RangeRule => ({
  id: 'r', name: 'R', blockId: 'b1', bayFrom: 1, bayTo: 1, rowFrom: 1, rowTo: 2, priority: 50, purpose: 'ANY',
  visitId: null, pod: null, line: null, size: null, weightClass: null, reefer: null, ...over,
});
const none: FacilityFlags = { hasReeferBlocks: false, hasDgBlocks: false };

describe('yard allocation rules', () => {
  it('classes weights', () => {
    expect([null, 9000, 10000, 20000, 20001].map(weightClass)).toEqual([null, 'L', 'M', 'M', 'H']);
  });

  it('refuses floating units, burying, size mixing and over-weight stacks', () => {
    const b = block({ maxStackKg: 50000 });
    const ys = [at('x', 1, 1, 1, { size: '40' }), at('y', 2, 1, 1, { weightKg: 30000 })];
    expect(slotProblem(b, ys, unit(), 3, 1, 2, none)).toMatch(/float/);
    expect(slotProblem(b, ys, unit(), 1, 1, 1, none)).toMatch(/occupied/);
    expect(slotProblem(b, ys, unit(), 1, 1, 2, none)).toMatch(/holds 40/);
    expect(slotProblem(b, ys, unit({ weightKg: 25000 }), 2, 1, 2, none)).toMatch(/over the 50000 kg/);
    expect(slotProblem(b, ys, unit(), 2, 1, 2, none)).toBeNull();
    expect(slotProblem(b, ys, unit(), 4, 1, 1, none)).toMatch(/3 bays/);
    expect(slotProblem(block({ allowedSizes: ['20'] }), [], unit({ size: '45' }), 1, 1, 1, none)).toMatch(/takes 20/);
  });

  it('puts reefers on plugs and DG units in their zones, once the facility has such blocks', () => {
    const flags = { hasReeferBlocks: true, hasDgBlocks: true };
    expect(slotProblem(block(), [], unit({ isReefer: true }), 1, 1, 1, flags)).toMatch(/no reefer plugs/);
    expect(slotProblem(block({ reeferPlugs: 1 }), [at('r', 2, 1, 1, { isReefer: true })], unit({ isReefer: true }), 1, 1, 1, flags)).toMatch(/plugs .* taken/);
    expect(slotProblem(block({ dgClasses: ['3'] }), [], unit({ dgClass: '8' }), 1, 1, 1, flags)).toMatch(/class 8/);
    expect(slotProblem(block({ dgClasses: ['2'] }), [], unit({ dgClass: '2.1' }), 1, 1, 1, flags)).toBeNull();
    // A yard without reefer or DG blocks still takes them (no rule to apply yet).
    expect(slotProblem(block(), [], unit({ isReefer: true, dgClass: '3' }), 1, 1, 1, none)).toBeNull();
  });

  it('continues stacks of the same group and keeps groups apart', () => {
    const ys = [at('a', 1, 1, 1, { line: 'MSC' }), at('b', 2, 1, 1, { line: 'CMA' })];
    const c = chooseSlot([block()], new Map([['b1', ys]]), [], unit({ line: 'CMA' }), none)!;
    expect([c.bay, c.row, c.tier]).toEqual([2, 1, 2]);
  });

  it('never moves a unit to the slot it is already in', () => {
    const ys = [at('me', 1, 1, 1)];
    const c = chooseSlot([block()], new Map([['b1', ys]]), [], unit({ id: 'me' }), none, { blockId: 'b1', bay: 1, row: 1, tier: 1 })!;
    expect([c.bay, c.row, c.tier]).not.toEqual([1, 1, 1]);
  });

  it('keeps heavy exports below lighter ones', () => {
    const exp = (w: number) => ({ intent: 'EXPORT' as const, visitOutId: 'v', pod: 'SGSIN', weightKg: w });
    // Stack 1 holds a light box of another weight class; a heavy one should start a new stack rather than go on top.
    const ys = [at('l', 1, 1, 1, exp(8000))];
    const c = chooseSlot([block()], new Map([['b1', ys]]), [], unit({ id: 'h', ...exp(25000) }), none)!;
    expect([c.bay, c.row, c.tier]).toEqual([1, 2, 1]);
  });

  it('uses matching ranges first and never another range', () => {
    const ranges = [
      range({ id: 'exp', name: 'Exports V1', purpose: 'EXPORT', visitId: 'v1', bayFrom: 3, bayTo: 3, priority: 10 }),
      range({ id: 'mty', name: 'MSC empties', purpose: 'EMPTY', line: 'MSC', bayFrom: 1, bayTo: 1 }),
    ];
    const ex = chooseSlot([block()], new Map(), ranges, unit({ intent: 'EXPORT', visitOutId: 'v1' }), none)!;
    expect(ex).toMatchObject({ bay: 3, range: { name: 'Exports V1' } });
    // An import may use general space (bay 2) but not the export or empty ranges.
    const imp = chooseSlot([block()], new Map(), ranges, unit(), none)!;
    expect(imp).toMatchObject({ bay: 2, range: null });
    // Once general space is full, imports have nowhere to go.
    const full = [1, 2].flatMap((row) => [1, 2, 3].map((tier) => at(`g${row}${tier}`, 2, row, tier)));
    expect(chooseSlot([block()], new Map([['b1', full]]), ranges, unit({ id: 'new' }), none)).toBeNull();
  });
});
