import { cellsClash, cellSizeProblem, craneSplit, findRestows, parseCell, PlannedMove, sequenceHatch, StowItem } from '../src/vessel/stowage';

const c = (s: string) => parseCell(s)!;

describe('stowage rules', () => {
  it('parses 6 and 7 digit cells', () => {
    expect(parseCell('0120682')).toMatchObject({ cell: '0120682', bay: 12, row: 6, tier: 82, deck: true, hatch: 2 });
    expect(parseCell('030204')).toMatchObject({ cell: '0030204', bay: 3, row: 2, tier: 4, deck: false, hatch: 0 });
    expect(parseCell('ABC')).toBeNull();
    expect(parseCell('0000000')).toBeNull();
  });

  it('groups bays into hatches: 01/02/03, 05/06/07, 09/10/11', () => {
    expect([1, 2, 3, 5, 6, 7, 9].map((b) => c(`${String(b).padStart(3, '0')}0282`).hatch)).toEqual([0, 0, 0, 1, 1, 1, 2]);
  });

  it('checks unit size against bay parity', () => {
    expect(cellSizeProblem(c('0010282'), '22G1')).toBeNull();
    expect(cellSizeProblem(c('0020282'), '22G1')).toMatch(/odd bay/);
    expect(cellSizeProblem(c('0010282'), '45G1')).toMatch(/even bay/);
    expect(cellSizeProblem(c('0020282'), 'L5G1')).toBeNull();
  });

  it('detects clashes between a 40 and the 20s under it', () => {
    expect(cellsClash(c('0020282'), c('0010282'))).toBe(true);
    expect(cellsClash(c('0020282'), c('0030282'))).toBe(true);
    expect(cellsClash(c('0020282'), c('0050282'))).toBe(false);
    expect(cellsClash(c('0020282'), c('0010284'))).toBe(false);
  });

  it('flags restows above discharges and deck cargo over a hold discharge', () => {
    const items: StowItem[] = [
      { cell: c('0010282'), unitRef: 'A', pod: 'HERE', disposition: 'DISCHARGE' },
      { cell: c('0010284'), unitRef: 'B', pod: 'NEXT', disposition: 'ROB' }, // on top of A -> restow
      { cell: c('0010482'), unitRef: 'C', pod: 'NEXT', disposition: 'ROB' }, // other row -> stays
      { cell: c('0060206'), unitRef: 'D', pod: 'HERE', disposition: 'DISCHARGE' }, // hold, hatch 1
      { cell: c('0050282'), unitRef: 'E', pod: 'NEXT', disposition: 'ROB' }, // deck of hatch 1 -> hatch cover restow
      { cell: c('0060204'), unitRef: 'F', pod: 'NEXT', disposition: 'ROB' }, // below D -> stays
      { cell: c('0090282'), unitRef: 'G', pod: 'NEXT', disposition: 'ROB' }, // hatch 2 -> stays
    ];
    expect([...findRestows(items)].sort()).toEqual(['0010284', '0050282']);
  });

  it('sequences a hatch: discharge deck then hold top-down, load hold then deck bottom-up', () => {
    const m = (id: string, kind: PlannedMove['kind'], cell: string): PlannedMove => ({ id, kind, cell: c(cell) });
    const order = sequenceHatch([
      m('l-deck', 'LOAD', '0010282'), m('d-hold-low', 'DISCHARGE', '0010202'), m('l-hold', 'LOAD', '0010204'),
      m('d-deck', 'DISCHARGE', '0010282'), m('d-hold-high', 'DISCHARGE', '0010206'), m('r', 'RESTOW', '0010284'),
    ]).map((x) => x.id);
    expect(order).toEqual(['r', 'd-deck', 'd-hold-high', 'd-hold-low', 'l-hold', 'l-deck']);
  });

  it('splits hatches into contiguous ranges minimising the busiest crane', () => {
    const loads = [30, 10, 10, 10, 40, 20].map((load, hatch) => ({ hatch, load, bayFrom: hatch * 4 + 1, bayTo: hatch * 4 + 3 }));
    const split = craneSplit(['QC1', 'QC2', 'QC3'], loads);
    // Best possible busiest crane is 50 (e.g. 30+10+10 | 10+40 | 20); no split does better.
    expect(Math.max(...split.map((s) => s.moves))).toBe(50);
    expect(split.every((s) => s.moves > 0)).toBe(true);
    expect(split[0]).toMatchObject({ bayFrom: 1 });
    // ranges are contiguous and cover every hatch in order
    expect(split.flatMap((s) => s.hatches)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(split.reduce((n, s) => n + s.moves, 0)).toBe(120);
  });

  it('leaves extra cranes idle when there are fewer hatches than cranes', () => {
    const split = craneSplit(['QC1', 'QC2', 'QC3'], [{ hatch: 4, load: 12, bayFrom: 17, bayTo: 19 }]);
    expect(split.filter((s) => s.moves > 0)).toHaveLength(1);
    expect(split.find((s) => s.moves > 0)).toMatchObject({ bayFrom: 17, bayTo: 19, moves: 12 });
  });
});
