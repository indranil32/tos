/**
 * Data grid engine: quick search, quick filters, advanced filter groups (AND/OR, nested),
 * single and multi-level sort, column layout. Pure functions, no React, unit tested.
 */

export type ColumnType = 'text' | 'number' | 'date' | 'enum' | 'boolean';

export interface EnumOption {
  value: string;
  label: string;
}

export interface ColumnSpec<T> {
  id: string;
  header: string;
  type: ColumnType;
  /** Raw value used for filtering, sorting and CSV. */
  value: (row: T) => unknown;
  enumOptions?: EnumOption[];
  /** Hidden until the user adds it in the column chooser. */
  hiddenByDefault?: boolean;
  /** Included in the quick search (defaults: text and enum columns). */
  searchable?: boolean;
  /** Natural sort order for enums (e.g. life-cycle order instead of alphabetical). */
  enumOrder?: string[];
}

export type Operator =
  | 'contains' | 'notContains' | 'equals' | 'notEquals' | 'startsWith' | 'endsWith'
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  | 'on' | 'before' | 'after' | 'lastDays' | 'nextDays'
  | 'in' | 'notIn'
  | 'isTrue' | 'isFalse'
  | 'isEmpty' | 'isNotEmpty';

export const OPERATORS: Record<ColumnType, { op: Operator; label: string; arity: 0 | 1 | 2 | 'list' }[]> = {
  text: [
    { op: 'contains', label: 'contains', arity: 1 },
    { op: 'notContains', label: 'does not contain', arity: 1 },
    { op: 'equals', label: 'is', arity: 1 },
    { op: 'notEquals', label: 'is not', arity: 1 },
    { op: 'startsWith', label: 'starts with', arity: 1 },
    { op: 'endsWith', label: 'ends with', arity: 1 },
    { op: 'isEmpty', label: 'is empty', arity: 0 },
    { op: 'isNotEmpty', label: 'is not empty', arity: 0 },
  ],
  number: [
    { op: 'eq', label: '=', arity: 1 },
    { op: 'neq', label: '≠', arity: 1 },
    { op: 'gt', label: '>', arity: 1 },
    { op: 'gte', label: '≥', arity: 1 },
    { op: 'lt', label: '<', arity: 1 },
    { op: 'lte', label: '≤', arity: 1 },
    { op: 'between', label: 'between', arity: 2 },
    { op: 'isEmpty', label: 'is empty', arity: 0 },
    { op: 'isNotEmpty', label: 'is not empty', arity: 0 },
  ],
  date: [
    { op: 'on', label: 'on', arity: 1 },
    { op: 'before', label: 'before', arity: 1 },
    { op: 'after', label: 'after', arity: 1 },
    { op: 'between', label: 'between', arity: 2 },
    { op: 'lastDays', label: 'in the last N days', arity: 1 },
    { op: 'nextDays', label: 'in the next N days', arity: 1 },
    { op: 'isEmpty', label: 'is empty', arity: 0 },
    { op: 'isNotEmpty', label: 'is not empty', arity: 0 },
  ],
  enum: [
    { op: 'in', label: 'is any of', arity: 'list' },
    { op: 'notIn', label: 'is none of', arity: 'list' },
    { op: 'isEmpty', label: 'is empty', arity: 0 },
    { op: 'isNotEmpty', label: 'is not empty', arity: 0 },
  ],
  boolean: [
    { op: 'isTrue', label: 'is yes', arity: 0 },
    { op: 'isFalse', label: 'is no', arity: 0 },
  ],
};

export interface FilterRule {
  kind: 'rule';
  id: string;
  columnId: string;
  op: Operator;
  value?: string;
  value2?: string;
  values?: string[];
}

export interface FilterGroup {
  kind: 'group';
  id: string;
  combinator: 'AND' | 'OR';
  rules: (FilterRule | FilterGroup)[];
}

export interface SortSpec {
  columnId: string;
  dir: 'asc' | 'desc';
}

export interface GridState {
  search: string;
  /** Quick filters: column id -> selected enum values (empty = all). */
  quick: Record<string, string[]>;
  advanced: FilterGroup;
  sort: SortSpec[];
  columnOrder: string[];
  hidden: string[];
  pageSize: number;
}

export const emptyGroup = (): FilterGroup => ({ kind: 'group', id: 'root', combinator: 'AND', rules: [] });

export function defaultState<T>(columns: ColumnSpec<T>[], sort: SortSpec[] = []): GridState {
  return {
    search: '',
    quick: {},
    advanced: emptyGroup(),
    sort,
    columnOrder: columns.map((c) => c.id),
    hidden: columns.filter((c) => c.hiddenByDefault).map((c) => c.id),
    pageSize: 50,
  };
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '';
const str = (v: unknown) => (isBlank(v) ? '' : String(v)).toLowerCase();
const num = (v: unknown) => (isBlank(v) ? NaN : Number(v));
const DAY = 86_400_000;
function dayStart(v: unknown): number {
  const d = new Date(String(v));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function matchRule<T>(row: T, rule: FilterRule, col: ColumnSpec<T> | undefined, now = Date.now()): boolean {
  if (!col) return true;
  const raw = col.value(row);
  switch (rule.op) {
    case 'isEmpty':
      return isBlank(raw);
    case 'isNotEmpty':
      return !isBlank(raw);
    case 'isTrue':
      return raw === true;
    case 'isFalse':
      return raw !== true;
  }
  if (col.type === 'enum') {
    const values = rule.values ?? [];
    if (!values.length) return true; // incomplete rule: ignore
    const hit = values.includes(String(raw ?? ''));
    return rule.op === 'notIn' ? !hit : hit;
  }
  if (rule.value === undefined || rule.value === '') return true; // incomplete rule: ignore
  if (col.type === 'number') {
    const v = num(raw);
    const a = Number(rule.value);
    const b = Number(rule.value2);
    if (Number.isNaN(v)) return rule.op === 'neq';
    switch (rule.op) {
      case 'eq': return v === a;
      case 'neq': return v !== a;
      case 'gt': return v > a;
      case 'gte': return v >= a;
      case 'lt': return v < a;
      case 'lte': return v <= a;
      case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b);
    }
    return true;
  }
  if (col.type === 'date') {
    if (isBlank(raw)) return false;
    const t = new Date(String(raw)).getTime();
    const d = dayStart(raw);
    switch (rule.op) {
      case 'on': return d === dayStart(rule.value);
      case 'before': return d < dayStart(rule.value);
      case 'after': return d > dayStart(rule.value);
      case 'between': {
        const a = dayStart(rule.value);
        const b = dayStart(rule.value2 ?? rule.value);
        return d >= Math.min(a, b) && d <= Math.max(a, b);
      }
      case 'lastDays': return t >= now - Number(rule.value) * DAY && t <= now;
      case 'nextDays': return t >= now && t <= now + Number(rule.value) * DAY;
    }
    return true;
  }
  const v = str(raw);
  const q = rule.value.toLowerCase();
  switch (rule.op) {
    case 'contains': return v.includes(q);
    case 'notContains': return !v.includes(q);
    case 'equals': return v === q;
    case 'notEquals': return v !== q;
    case 'startsWith': return v.startsWith(q);
    case 'endsWith': return v.endsWith(q);
  }
  return true;
}

export function matchGroup<T>(row: T, group: FilterGroup, cols: Map<string, ColumnSpec<T>>, now = Date.now()): boolean {
  if (!group.rules.length) return true;
  const test = (r: FilterRule | FilterGroup) =>
    r.kind === 'group' ? matchGroup(row, r, cols, now) : matchRule(row, r, cols.get(r.columnId), now);
  return group.combinator === 'AND' ? group.rules.every(test) : group.rules.some(test);
}

export function compareValues(a: unknown, b: unknown, type: ColumnType, enumOrder?: string[]): number {
  const ab = isBlank(a);
  const bb = isBlank(b);
  if (ab || bb) return ab && bb ? 0 : ab ? 1 : -1; // blanks last
  switch (type) {
    case 'number': return Number(a) - Number(b);
    case 'date': return new Date(String(a)).getTime() - new Date(String(b)).getTime();
    case 'boolean': return (a === true ? 1 : 0) - (b === true ? 1 : 0);
    case 'enum':
      if (enumOrder) {
        const ia = enumOrder.indexOf(String(a));
        const ib = enumOrder.indexOf(String(b));
        if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      }
      return String(a).localeCompare(String(b));
    default:
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
}

/** Search + quick filters + advanced filter + multi-level sort. */
export function processRows<T>(rows: T[], columns: ColumnSpec<T>[], state: GridState, now = Date.now()): T[] {
  const cols = new Map(columns.map((c) => [c.id, c]));
  const terms = state.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const searchCols = columns.filter((c) => c.searchable ?? (c.type === 'text' || c.type === 'enum'));
  const quick = Object.entries(state.quick).filter(([, v]) => v.length);

  const filtered = rows.filter((row) => {
    if (terms.length) {
      const hay = searchCols.map((c) => {
        const raw = c.value(row);
        const label = c.enumOptions?.find((o) => o.value === raw)?.label;
        return `${str(raw)} ${str(label)}`;
      }).join(' ');
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    for (const [colId, values] of quick) {
      const c = cols.get(colId);
      if (c && !values.includes(String(c.value(row) ?? ''))) return false;
    }
    return matchGroup(row, state.advanced, cols, now);
  });

  const sorts = state.sort.filter((s) => cols.has(s.columnId));
  if (!sorts.length) return filtered;
  return filtered
    .map((row, i) => ({ row, i }))
    .sort((x, y) => {
      for (const s of sorts) {
        const c = cols.get(s.columnId)!;
        const r = compareValues(c.value(x.row), c.value(y.row), c.type, c.enumOrder);
        if (r !== 0) {
          const blanks = isBlank(c.value(x.row)) || isBlank(c.value(y.row));
          return blanks ? r : s.dir === 'asc' ? r : -r; // blanks stay last either way
        }
      }
      return x.i - y.i; // stable
    })
    .map((x) => x.row);
}

/** Header click: plain click sorts by that column only (asc → desc → none); shift-click adds/toggles a level. */
export function toggleSort(sort: SortSpec[], columnId: string, additive: boolean): SortSpec[] {
  const existing = sort.find((s) => s.columnId === columnId);
  if (!additive) {
    if (!existing || sort.length > 1) return [{ columnId, dir: existing?.dir === 'asc' && sort.length === 1 ? 'desc' : 'asc' }];
    return existing.dir === 'asc' ? [{ columnId, dir: 'desc' }] : [];
  }
  if (!existing) return [...sort, { columnId, dir: 'asc' }];
  if (existing.dir === 'asc') return sort.map((s) => (s.columnId === columnId ? { ...s, dir: 'desc' } : s));
  return sort.filter((s) => s.columnId !== columnId);
}

export function visibleColumns<T>(columns: ColumnSpec<T>[], state: GridState): ColumnSpec<T>[] {
  const byId = new Map(columns.map((c) => [c.id, c]));
  const ordered = [...state.columnOrder.filter((id) => byId.has(id)), ...columns.map((c) => c.id).filter((id) => !state.columnOrder.includes(id))];
  return ordered.filter((id) => !state.hidden.includes(id)).map((id) => byId.get(id)!);
}

export function moveColumn(order: string[], id: string, delta: number): string[] {
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  next.splice(i, 1);
  next.splice(j, 0, id);
  return next;
}

export function countActiveFilters(state: GridState): number {
  const countGroup = (g: FilterGroup): number => g.rules.reduce((n, r) => n + (r.kind === 'group' ? countGroup(r) : 1), 0);
  return countGroup(state.advanced) + Object.values(state.quick).filter((v) => v.length).length + (state.search.trim() ? 1 : 0);
}

export function toCsv<T>(rows: T[], columns: ColumnSpec<T>[]): string {
  const esc = (v: unknown) => {
    const s = isBlank(v) ? '' : String(v);
    // Neutralise spreadsheet formula injection, then quote.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [columns.map((c) => esc(c.header)).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\n');
}
