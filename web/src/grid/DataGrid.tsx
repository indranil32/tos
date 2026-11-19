import { ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ColumnSpec, countActiveFilters, defaultState, emptyGroup, FilterGroup, FilterRule, GridState, moveColumn, OPERATORS, processRows,
  SortSpec, toCsv, toggleSort, visibleColumns,
} from './engine';

export interface GridColumn<T> extends ColumnSpec<T> {
  /** Full custom cell. */
  render?: (row: T) => ReactNode;
  /** Renders a single value (badges); used for cells and for quick-filter chips so both look identical. */
  renderValue?: (value: any) => ReactNode;
  width?: number;
  align?: 'left' | 'right' | 'center';
}

interface Props<T> {
  /** Stable id: the layout, filters and sort are saved per grid in this browser. */
  id: string;
  title?: string;
  columns: GridColumn<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: string | null;
  /** Enum column ids shown as one-click filter chips with counts. */
  quickFilters?: string[];
  defaultSort?: SortSpec[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Colour bar on the left of each row (tone solid colour), matching the row's main status. */
  rowAccent?: (row: T) => string | undefined;
  actions?: ReactNode;
  legend?: ReactNode;
}

const STORAGE_PREFIX = 'tos.grid.v1.';
let ruleSeq = 0;
const newId = () => `r${Date.now().toString(36)}${(ruleSeq++).toString(36)}`;

function usePersistentGridState<T>(id: string, columns: ColumnSpec<T>[], defaultSort: SortSpec[]) {
  const initial = useMemo(() => defaultState(columns, defaultSort), [columns, defaultSort]);
  const [state, setState] = useState<GridState>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_PREFIX + id);
      return saved ? { ...initial, ...JSON.parse(saved), search: '' } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify({ ...state, search: '' }));
    } catch {
      /* storage unavailable */
    }
  }, [id, state]);
  return [state, setState, initial] as const;
}

export function DataGrid<T>(props: Props<T>) {
  const { id, columns, rows, quickFilters = [], defaultSort = [], rowKey } = props;
  const [state, setState, initial] = usePersistentGridState(id, columns, defaultSort);
  const [panel, setPanel] = useState<null | 'filter' | 'sort' | 'columns'>(null);
  const [page, setPage] = useState(0);

  const processed = useMemo(() => processRows(rows ?? [], columns, state), [rows, columns, state]);
  const visible = visibleColumns(columns, state);
  const pages = Math.max(1, Math.ceil(processed.length / state.pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = processed.slice(current * state.pageSize, (current + 1) * state.pageSize);
  const activeFilters = countActiveFilters(state);
  const update = (patch: Partial<GridState>) => {
    setState((s) => ({ ...s, ...patch }));
    setPage(0);
  };

  const exportCsv = () => {
    const blob = new Blob([toCsv(processed, visible)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${id}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="grid-card">
      <div className="grid-toolbar">
        {props.title && <h2>{props.title}</h2>}
        <input
          className="search"
          type="search"
          placeholder="Search…"
          aria-label="Quick search"
          value={state.search}
          onChange={(e) => update({ search: e.target.value })}
        />
        <button className={panel === 'filter' ? 'on' : ''} onClick={() => setPanel(panel === 'filter' ? null : 'filter')}>
          Filters{state.advanced.rules.length ? ` (${state.advanced.rules.length})` : ''}
        </button>
        <button className={panel === 'sort' ? 'on' : ''} onClick={() => setPanel(panel === 'sort' ? null : 'sort')}>
          Sort{state.sort.length ? ` (${state.sort.length})` : ''}
        </button>
        <button className={panel === 'columns' ? 'on' : ''} onClick={() => setPanel(panel === 'columns' ? null : 'columns')}>Columns</button>
        <button onClick={exportCsv} title="Download the filtered rows as CSV">CSV</button>
        {activeFilters > 0 && (
          <button className="link" onClick={() => update({ search: '', quick: {}, advanced: emptyGroup() })}>Clear filters</button>
        )}
        <span className="spacer" />
        {props.actions}
      </div>

      {quickFilters.length > 0 && rows && (
        <div className="quick-filters">
          {quickFilters.map((colId) => (
            <QuickFilter key={colId} column={columns.find((c) => c.id === colId)!} rows={rows} selected={state.quick[colId] ?? []}
              onChange={(values) => update({ quick: { ...state.quick, [colId]: values } })} />
          ))}
        </div>
      )}

      {panel === 'filter' && (
        <div className="panel">
          <GroupEditor group={state.advanced} columns={columns} depth={0} onChange={(advanced) => update({ advanced })} />
        </div>
      )}
      {panel === 'sort' && (
        <div className="panel"><SortEditor sort={state.sort} columns={columns} onChange={(sort) => update({ sort })} /></div>
      )}
      {panel === 'columns' && (
        <div className="panel">
          <ColumnEditor columns={columns} state={state} onChange={update}
            onReset={() => update({ columnOrder: initial.columnOrder, hidden: initial.hidden })} />
        </div>
      )}

      {props.legend && <div className="grid-legend">{props.legend}</div>}

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              {visible.map((c) => {
                const idx = state.sort.findIndex((s) => s.columnId === c.id);
                const s = state.sort[idx];
                return (
                  <th key={c.id} style={{ width: (c as GridColumn<T>).width, textAlign: (c as GridColumn<T>).align }}
                    aria-sort={s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className="th-btn" title="Click to sort, Shift+click to add a sort level"
                      onClick={(e) => update({ sort: toggleSort(state.sort, c.id, e.shiftKey) })}>
                      {c.header}
                      {s && <span className="sort-ind">{s.dir === 'asc' ? '▲' : '▼'}{state.sort.length > 1 ? <sup>{idx + 1}</sup> : null}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {props.loading && <tr><td colSpan={visible.length} className="muted">Loading…</td></tr>}
            {props.error && <tr><td colSpan={visible.length} className="error">{props.error}</td></tr>}
            {!props.loading && !props.error && !pageRows.length && (
              <tr><td colSpan={visible.length} className="muted">{rows?.length ? 'No rows match the filters.' : 'Nothing here yet.'}</td></tr>
            )}
            {pageRows.map((row) => {
              const accent = props.rowAccent?.(row);
              return (
                <tr key={rowKey(row)} className={props.onRowClick ? 'clickable' : ''} onClick={() => props.onRowClick?.(row)}
                  style={accent ? { boxShadow: `inset 4px 0 0 ${accent}` } : undefined}>
                  {visible.map((c) => {
                    const gc = c as GridColumn<T>;
                    return <td key={c.id} style={{ textAlign: gc.align }}>
                      {gc.render ? gc.render(row) : gc.renderValue ? gc.renderValue(c.value(row)) : formatCell(c.value(row), c.type)}
                    </td>;
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid-footer">
        <span>{processed.length.toLocaleString()} of {(rows?.length ?? 0).toLocaleString()} rows</span>
        <span className="spacer" />
        <label>Rows per page{' '}
          <select value={state.pageSize} onChange={(e) => update({ pageSize: Number(e.target.value) })}>
            {[25, 50, 100, 250].map((n) => <option key={n}>{n}</option>)}
          </select>
        </label>
        <button disabled={current === 0} onClick={() => setPage(current - 1)} aria-label="Previous page">‹</button>
        <span>{current + 1} / {pages}</span>
        <button disabled={current >= pages - 1} onClick={() => setPage(current + 1)} aria-label="Next page">›</button>
      </div>
    </section>
  );
}

export function formatCell(v: unknown, type: string): ReactNode {
  if (v === null || v === undefined || v === '') return <span className="muted">–</span>;
  if (type === 'date') return formatDate(String(v));
  if (type === 'number') return Number(v).toLocaleString();
  if (type === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

export function formatDate(v: string | null | undefined): string {
  if (!v) return '–';
  const d = new Date(v);
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function QuickFilter<T>({ column, rows, selected, onChange }: { column: GridColumn<T>; rows: T[]; selected: string[]; onChange: (v: string[]) => void }) {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const v = String(column.value(r) ?? '');
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const options = (column.enumOptions ?? [...counts.keys()].filter(Boolean).map((v) => ({ value: v, label: v })))
    .filter((o) => counts.has(o.value));
  return (
    <div className="quick" role="group" aria-label={`Filter by ${column.header}`}>
      <span className="quick-label">{column.header}</span>
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button key={o.value} className={`quick-chip ${on ? 'on' : ''}`} aria-pressed={on}
            onClick={() => onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])}>
            {column.renderValue ? column.renderValue(o.value) : o.label}
            <span className="count">{counts.get(o.value)}</span>
          </button>
        );
      })}
    </div>
  );
}

function GroupEditor<T>({ group, columns, depth, onChange, onRemove }: {
  group: FilterGroup; columns: GridColumn<T>[]; depth: number; onChange: (g: FilterGroup) => void; onRemove?: () => void;
}) {
  const filterable = columns;
  const setRule = (i: number, r: FilterRule | FilterGroup) => onChange({ ...group, rules: group.rules.map((x, j) => (j === i ? r : x)) });
  const removeRule = (i: number) => onChange({ ...group, rules: group.rules.filter((_, j) => j !== i) });
  const addRule = () => {
    const c = filterable[0];
    onChange({ ...group, rules: [...group.rules, { kind: 'rule', id: newId(), columnId: c.id, op: OPERATORS[c.type][0].op }] });
  };
  return (
    <div className={`group depth-${depth}`}>
      <div className="group-head">
        <span>Match</span>
        <select value={group.combinator} onChange={(e) => onChange({ ...group, combinator: e.target.value as 'AND' | 'OR' })} aria-label="Combine conditions">
          <option value="AND">all of these (AND)</option>
          <option value="OR">any of these (OR)</option>
        </select>
        {onRemove && <button className="link" onClick={onRemove}>Remove group</button>}
      </div>
      {group.rules.map((r, i) =>
        r.kind === 'group' ? (
          <GroupEditor key={r.id} group={r} columns={columns} depth={depth + 1} onChange={(g) => setRule(i, g)} onRemove={() => removeRule(i)} />
        ) : (
          <RuleEditor key={r.id} rule={r} columns={filterable} onChange={(nr) => setRule(i, nr)} onRemove={() => removeRule(i)} />
        ),
      )}
      <div className="group-actions">
        <button onClick={addRule}>+ Condition</button>
        {depth === 0 && (
          <button onClick={() => onChange({ ...group, rules: [...group.rules, { kind: 'group', id: newId(), combinator: group.combinator === 'AND' ? 'OR' : 'AND', rules: [] }] })}>
            + Group
          </button>
        )}
        {depth === 0 && group.rules.length > 0 && <button className="link" onClick={() => onChange(emptyGroup())}>Clear all</button>}
      </div>
    </div>
  );
}

function RuleEditor<T>({ rule, columns, onChange, onRemove }: { rule: FilterRule; columns: GridColumn<T>[]; onChange: (r: FilterRule) => void; onRemove: () => void }) {
  const col = columns.find((c) => c.id === rule.columnId) ?? columns[0];
  const ops = OPERATORS[col.type];
  const op = ops.find((o) => o.op === rule.op) ?? ops[0];
  const inputType = col.type === 'number' ? 'number' : col.type === 'date' && rule.op !== 'lastDays' && rule.op !== 'nextDays' ? 'date' : rule.op === 'lastDays' || rule.op === 'nextDays' ? 'number' : 'text';
  return (
    <div className="rule">
      <select aria-label="Column" value={col.id} onChange={(e) => {
        const c = columns.find((x) => x.id === e.target.value)!;
        onChange({ kind: 'rule', id: rule.id, columnId: c.id, op: OPERATORS[c.type][0].op });
      }}>
        {columns.map((c) => <option key={c.id} value={c.id}>{c.header}</option>)}
      </select>
      <select aria-label="Operator" value={op.op} onChange={(e) => onChange({ ...rule, op: e.target.value as FilterRule['op'] })}>
        {ops.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {op.arity === 'list' && (
        <span className="enum-pick">
          {(col.enumOptions ?? []).map((o) => {
            const on = rule.values?.includes(o.value) ?? false;
            return (
              <label key={o.value} className={`enum-opt ${on ? 'on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => onChange({
                  ...rule, values: on ? (rule.values ?? []).filter((v) => v !== o.value) : [...(rule.values ?? []), o.value],
                })} />
                {o.label}
              </label>
            );
          })}
        </span>
      )}
      {(op.arity === 1 || op.arity === 2) && (
        <input aria-label="Value" type={inputType} value={rule.value ?? ''} placeholder={rule.op.endsWith('Days') ? 'days' : 'value'}
          onChange={(e) => onChange({ ...rule, value: e.target.value })} />
      )}
      {op.arity === 2 && (
        <>
          <span className="muted">and</span>
          <input aria-label="Second value" type={inputType} value={rule.value2 ?? ''} onChange={(e) => onChange({ ...rule, value2: e.target.value })} />
        </>
      )}
      <button className="icon" onClick={onRemove} aria-label="Remove condition">✕</button>
    </div>
  );
}

function SortEditor<T>({ sort, columns, onChange }: { sort: SortSpec[]; columns: GridColumn<T>[]; onChange: (s: SortSpec[]) => void }) {
  const unused = columns.filter((c) => !sort.some((s) => s.columnId === c.id));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= sort.length) return;
    const next = [...sort];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  return (
    <div className="sort-editor">
      <p className="hint">Rows are sorted by the first level, then ties by the next. Tip: Shift+click a column header to add a level.</p>
      {sort.map((s, i) => (
        <div key={s.columnId} className="rule">
          <span className="level">{i === 0 ? 'Sort by' : 'then by'}</span>
          <select aria-label="Sort column" value={s.columnId} onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, columnId: e.target.value } : x)))}>
            {[columns.find((c) => c.id === s.columnId)!, ...unused].filter(Boolean).map((c) => <option key={c.id} value={c.id}>{c.header}</option>)}
          </select>
          <select aria-label="Direction" value={s.dir} onChange={(e) => onChange(sort.map((x, j) => (j === i ? { ...x, dir: e.target.value as 'asc' | 'desc' } : x)))}>
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
          <button className="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
          <button className="icon" onClick={() => move(i, 1)} disabled={i === sort.length - 1} aria-label="Move down">↓</button>
          <button className="icon" onClick={() => onChange(sort.filter((_, j) => j !== i))} aria-label="Remove level">✕</button>
        </div>
      ))}
      <div className="group-actions">
        <button disabled={!unused.length} onClick={() => onChange([...sort, { columnId: unused[0].id, dir: 'asc' }])}>+ Sort level</button>
        {sort.length > 0 && <button className="link" onClick={() => onChange([])}>Clear sort</button>}
      </div>
    </div>
  );
}

function ColumnEditor<T>({ columns, state, onChange, onReset }: {
  columns: GridColumn<T>[]; state: GridState; onChange: (p: Partial<GridState>) => void; onReset: () => void;
}) {
  const order = [...state.columnOrder.filter((id) => columns.some((c) => c.id === id)), ...columns.map((c) => c.id).filter((id) => !state.columnOrder.includes(id))];
  return (
    <div className="column-editor">
      <p className="hint">Tick to show, use the arrows to reorder. Saved in this browser.</p>
      <ol>
        {order.map((id, i) => {
          const c = columns.find((x) => x.id === id)!;
          const shown = !state.hidden.includes(id);
          return (
            <li key={id}>
              <label>
                <input type="checkbox" checked={shown}
                  onChange={() => onChange({ hidden: shown ? [...state.hidden, id] : state.hidden.filter((h) => h !== id) })} />
                {c.header}
              </label>
              <button className="icon" disabled={i === 0} onClick={() => onChange({ columnOrder: moveColumn(order, id, -1) })} aria-label={`Move ${c.header} up`}>↑</button>
              <button className="icon" disabled={i === order.length - 1} onClick={() => onChange({ columnOrder: moveColumn(order, id, 1) })} aria-label={`Move ${c.header} down`}>↓</button>
            </li>
          );
        })}
      </ol>
      <button className="link" onClick={onReset}>Reset columns</button>
    </div>
  );
}
