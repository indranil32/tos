import { describe, expect, it } from 'vitest';
import { ColumnSpec, defaultState, FilterGroup, GridState, moveColumn, processRows, toCsv, toggleSort, visibleColumns } from './engine';

interface Row { ref: string; state: string; weight: number | null; timeIn: string | null; reefer: boolean; line: string }
const rows: Row[] = [
  { ref: 'MSCU1000017', state: 'IN_YARD', weight: 21000, timeIn: '2026-11-10T08:00:00Z', reefer: false, line: 'MSC' },
  { ref: 'MSCU1000022', state: 'ADVISED', weight: 28000, timeIn: null, reefer: true, line: 'MSC' },
  { ref: 'CMAU5000014', state: 'IN_YARD', weight: null, timeIn: '2026-11-17T10:00:00Z', reefer: true, line: 'CMA' },
  { ref: 'HLXU3000012', state: 'DEPARTED', weight: 18000, timeIn: '2026-11-01T00:00:00Z', reefer: false, line: 'HLC' },
];
const cols: ColumnSpec<Row>[] = [
  { id: 'ref', header: 'Unit', type: 'text', value: (r) => r.ref },
  { id: 'state', header: 'State', type: 'enum', value: (r) => r.state, enumOptions: [{ value: 'IN_YARD', label: 'In yard' }], enumOrder: ['ADVISED', 'IN_YARD', 'LOADED', 'DEPARTED'] },
  { id: 'weight', header: 'Weight', type: 'number', value: (r) => r.weight },
  { id: 'timeIn', header: 'Time in', type: 'date', value: (r) => r.timeIn },
  { id: 'reefer', header: 'Reefer', type: 'boolean', value: (r) => r.reefer },
  { id: 'line', header: 'Line', type: 'text', value: (r) => r.line, hiddenByDefault: true },
];
const now = Date.parse('2026-11-19T12:00:00Z');
const run = (patch: Partial<GridState>) => processRows(rows, cols, { ...defaultState(cols), ...patch }, now).map((r) => r.ref);
const group = (combinator: 'AND' | 'OR', rules: FilterGroup['rules']): FilterGroup => ({ kind: 'group', id: 'g', combinator, rules });

describe('grid engine: simple filters', () => {
  it('quick search matches all terms, case-insensitive, including enum labels', () => {
    expect(run({ search: 'mscu' })).toEqual(['MSCU1000017', 'MSCU1000022']);
    expect(run({ search: 'in yard cmau' })).toEqual(['CMAU5000014']);
  });
  it('quick filter chips restrict to selected enum values', () => {
    expect(run({ quick: { state: ['IN_YARD'] } })).toEqual(['MSCU1000017', 'CMAU5000014']);
    expect(run({ quick: { state: [] } })).toHaveLength(4);
  });
});

describe('grid engine: advanced filters', () => {
  it('AND of number and boolean rules', () => {
    const advanced = group('AND', [
      { kind: 'rule', id: '1', columnId: 'weight', op: 'gte', value: '20000' },
      { kind: 'rule', id: '2', columnId: 'reefer', op: 'isTrue' },
    ]);
    expect(run({ advanced })).toEqual(['MSCU1000022']);
  });
  it('OR with a nested AND group', () => {
    const advanced = group('OR', [
      { kind: 'rule', id: '1', columnId: 'state', op: 'in', values: ['DEPARTED'] },
      group('AND', [
        { kind: 'rule', id: '2', columnId: 'ref', op: 'startsWith', value: 'cma' },
        { kind: 'rule', id: '3', columnId: 'weight', op: 'isEmpty' },
      ]),
    ]);
    expect(run({ advanced })).toEqual(['CMAU5000014', 'HLXU3000012']);
  });
  it('date operators: between, last N days, empty', () => {
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'timeIn', op: 'between', value: '2026-11-05', value2: '2026-11-17' }]) }))
      .toEqual(['MSCU1000017', 'CMAU5000014']);
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'timeIn', op: 'lastDays', value: '7' }]) })).toEqual(['CMAU5000014']);
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'timeIn', op: 'isEmpty' }]) })).toEqual(['MSCU1000022']);
  });
  it('enum none-of and text does-not-contain', () => {
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'state', op: 'notIn', values: ['IN_YARD', 'ADVISED'] }]) })).toEqual(['HLXU3000012']);
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'ref', op: 'notContains', value: 'u1' }]) })).toEqual(['CMAU5000014', 'HLXU3000012']);
  });
  it('ignores incomplete rules instead of hiding everything', () => {
    expect(run({ advanced: group('AND', [{ kind: 'rule', id: '1', columnId: 'weight', op: 'gt', value: '' }]) })).toHaveLength(4);
  });
});

describe('grid engine: sorting', () => {
  it('multi-level sort with enum life-cycle order and stable ties', () => {
    expect(run({ sort: [{ columnId: 'state', dir: 'asc' }, { columnId: 'weight', dir: 'desc' }] }))
      .toEqual(['MSCU1000022', 'MSCU1000017', 'CMAU5000014', 'HLXU3000012']);
  });
  it('blanks go last in both directions', () => {
    expect(run({ sort: [{ columnId: 'weight', dir: 'asc' }] }).at(-1)).toBe('CMAU5000014');
    expect(run({ sort: [{ columnId: 'weight', dir: 'desc' }] }).at(-1)).toBe('CMAU5000014');
  });
  it('header click cycles asc → desc → off; shift-click builds levels', () => {
    let s = toggleSort([], 'weight', false);
    expect(s).toEqual([{ columnId: 'weight', dir: 'asc' }]);
    s = toggleSort(s, 'weight', false);
    expect(s).toEqual([{ columnId: 'weight', dir: 'desc' }]);
    expect(toggleSort(s, 'weight', false)).toEqual([]);
    s = toggleSort([{ columnId: 'state', dir: 'asc' }], 'weight', true);
    expect(s).toEqual([{ columnId: 'state', dir: 'asc' }, { columnId: 'weight', dir: 'asc' }]);
    expect(toggleSort(s, 'ref', false)).toEqual([{ columnId: 'ref', dir: 'asc' }]);
  });
});

describe('grid engine: columns and export', () => {
  it('respects hidden-by-default, order and moves', () => {
    const st = defaultState(cols);
    expect(visibleColumns(cols, st).map((c) => c.id)).toEqual(['ref', 'state', 'weight', 'timeIn', 'reefer']);
    const order = moveColumn(st.columnOrder, 'weight', -2);
    expect(visibleColumns(cols, { ...st, columnOrder: order, hidden: ['reefer'] }).map((c) => c.id)).toEqual(['weight', 'ref', 'state', 'timeIn', 'line']);
  });
  it('CSV escapes quotes and neutralises formulas', () => {
    const csv = toCsv([{ a: '=1+1', b: 'say "hi", ok' }], [
      { id: 'a', header: 'A', type: 'text', value: (r: any) => r.a },
      { id: 'b', header: 'B', type: 'text', value: (r: any) => r.b },
    ]);
    expect(csv).toBe(`A,B\n'=1+1,"say ""hi"", ok"`);
  });
});
