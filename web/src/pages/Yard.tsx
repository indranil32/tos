import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { CategoryLegend, DwellLegend, FlagPill } from '../components/Badges';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { CATEGORY_DOMAINS, dwellBand, FLAGS, lineColors, textOn, TONES } from '../theme/colors';
import { YardBlock, YardRange, YardUnit } from '../types';

type ColourBy = 'category' | 'line' | 'dwell' | 'handling';

const COLOUR_BY: { key: ColourBy; label: string }[] = [
  { key: 'category', label: 'Category' },
  { key: 'line', label: 'Line' },
  { key: 'dwell', label: 'Dwell time' },
  { key: 'handling', label: 'Holds & special cargo' },
];

const days = (u: YardUnit) => (u.timeIn ? Math.floor((Date.now() - Date.parse(u.timeIn)) / 86_400_000) : 0);

export function YardView() {
  const { data, error, loading, reload } = useApi<{ blocks: YardBlock[]; ranges: YardRange[] }>('/v1/yard');
  const { roles } = useSession();
  useLive(['unit.', 'yard_range.', 'work.completed'], reload, 1000);
  const [by, setBy] = useState<ColourBy>(() => (localStorage.getItem('tos.yard.colourBy') as ColourBy) ?? 'category');
  const lines = useMemo(() => lineColors((data?.blocks ?? []).flatMap((b) => b.units.map((u) => u.lineOperator ?? ''))), [data]);
  const choose = (k: ColourBy) => { setBy(k); localStorage.setItem('tos.yard.colourBy', k); };

  /** Fill for one unit under the chosen colouring. The same rules as the colour guide. */
  const fill = (u: YardUnit): string => {
    switch (by) {
      case 'category': return CATEGORY_DOMAINS.category.values[u.category as keyof typeof CATEGORY_DOMAINS.category.values]?.color ?? '#999999';
      case 'line': return lines[u.lineOperator ?? ''] ?? '#999999';
      case 'dwell': return dwellBand(days(u)).color;
      case 'handling':
        if (u.activeHolds) return TONES.blocked.solid;
        if (u.dgClass) return FLAGS.DG.border;
        if (u.isReefer) return FLAGS.REEFER.border;
        return '#E6E9EE';
    }
  };

  const legend = by === 'category' ? <CategoryLegend domain="category" />
    : by === 'dwell' ? <DwellLegend />
    : by === 'line' ? <div className="legend">{Object.entries(lines).map(([code, c]) => <span key={code} className="legend-swatch"><i style={{ background: c }} />{code}</span>)}</div>
    : <div className="legend"><FlagPill flag="HOLD" /><FlagPill flag="DG" /><FlagPill flag="REEFER" /><span className="legend-swatch"><i style={{ background: '#E6E9EE' }} />No special handling</span></div>;

  if (loading && !data) return <p className="muted">Loading…</p>;
  if (error) return <p className="error">{error}</p>;
  const total = (data?.blocks ?? []).reduce((n, b) => n + b.slots, 0);
  const used = (data?.blocks ?? []).reduce((n, b) => n + b.occupied, 0);
  return (
    <>
      <div className="detail-head">
        <h1>Yard</h1>
        <span className="muted">{used} of {total} slots used ({total ? Math.round((used / total) * 100) : 0}%)</span>
      </div>
      <div className="toolbar" role="radiogroup" aria-label="Colour by">
        <span>Colour by</span>
        {COLOUR_BY.map((c) => <button key={c.key} className={by === c.key ? 'on' : ''} aria-checked={by === c.key} role="radio" onClick={() => choose(c.key)}>{c.label}</button>)}
      </div>
      <div className="grid-legend">{legend}</div>
      <div className="yard">
        {(data?.blocks ?? []).map((b) => <Block key={b.id} block={b} fill={fill} ranges={(data?.ranges ?? []).filter((r) => r.block === b.code)} />)}
      </div>
      <RangesPanel ranges={data?.ranges ?? []} blocks={(data?.blocks ?? []).filter((b) => b.blockType === 'CONTAINER_STACK')}
        canEdit={can(roles, 'tos:planner')} onChange={reload} />
    </>
  );
}

function Block({ block, fill, ranges }: { block: YardBlock; fill: (u: YardUnit) => string; ranges: YardRange[] }) {
  const pct = block.slots ? Math.round((block.occupied / block.slots) * 100) : 0;
  const head = (
    <header>
      <strong>{block.code}</strong> <span className="muted">{block.blockType.replace('_', ' ').toLowerCase()} · {block.yard}</span>
      <span className="spacer" />
      <span className="occ" title={`${block.occupied} of ${block.slots}`}><i style={{ width: `${pct}%`, background: pct > 85 ? TONES.attention.solid : TONES.active.solid }} /></span>
      <span className="muted">{pct}%</span>
    </header>
  );
  if (block.blockType !== 'CONTAINER_STACK') {
    return (
      <section className="block card">
        {head}
        <div className="area">
          {block.units.sort((a, b) => a.position.localeCompare(b.position)).map((u) => <UnitCell key={u.id} unit={u} fill={fill(u)} label={u.unitRef} />)}
          {!block.units.length && <span className="muted">Empty</span>}
        </div>
      </section>
    );
  }
  // Top view: bays across, rows down; each cell shows the top tier and the stack height.
  const stacks = new Map<string, YardUnit[]>();
  for (const u of block.units) {
    const [, bay, row] = u.position.split('-');
    const key = `${Number(bay)}-${Number(row)}`;
    stacks.set(key, [...(stacks.get(key) ?? []), u].sort((a, b) => Number(b.position.split('-')[3]) - Number(a.position.split('-')[3])));
  }
  return (
    <section className="block card">
      {head}
      <div className="stack-grid" style={{ gridTemplateColumns: `2.2em repeat(${block.bays}, minmax(2.6em, 1fr))` }}>
        <span />
        {Array.from({ length: block.bays }, (_, i) => <span key={i} className="axis">{String(i + 1).padStart(2, '0')}</span>)}
        {Array.from({ length: block.rows }, (_, r) => (
          <Row key={r} r={r + 1} bays={block.bays} tiers={block.tiers} stacks={stacks} fill={fill} ranges={ranges} />
        ))}
      </div>
    </section>
  );
}

function Row({ r, bays, tiers, stacks, fill, ranges }: { r: number; bays: number; tiers: number; stacks: Map<string, YardUnit[]>; fill: (u: YardUnit) => string; ranges: YardRange[] }) {
  return (
    <>
      <span className="axis">{String(r).padStart(2, '0')}</span>
      {Array.from({ length: bays }, (_, b) => {
        const stack = stacks.get(`${b + 1}-${r}`) ?? [];
        const top = stack[0];
        const range = ranges.find((x) => b + 1 >= x.bayFrom && b + 1 <= x.bayTo && r >= x.rowFrom && r <= x.rowTo);
        const reserved = range ? `\nReserved: ${range.name}` : '';
        if (!top) return <span key={b} className={range ? 'slot empty reserved' : 'slot empty'} title={`Bay ${b + 1} row ${r}: empty${reserved}`} />;
        return <UnitCell key={b} unit={top} fill={fill(top)} label={`${stack.length}/${tiers}`}
          title={stack.map((u) => `${u.position} ${u.unitRef}`).join('\n') + reserved} />;
      })}
    </>
  );
}

function UnitCell({ unit, fill, label, title }: { unit: YardUnit; fill: string; label: string; title?: string }) {
  return (
    <Link to={`/units/${unit.id}`} className="slot" style={{ background: fill, color: textOn(fill) }}
      title={title ?? `${unit.position} ${unit.unitRef}${unit.activeHolds ? ' · ON HOLD' : ''}${unit.dgClass ? ` · DG ${unit.dgClass}` : ''}${unit.isReefer ? ' · reefer' : ''}`}>
      {label}
      {unit.activeHolds > 0 && <span className="corner" aria-label="on hold">⛔</span>}
    </Link>
  );
}

const PURPOSES = ['EXPORT', 'IMPORT', 'EMPTY', 'TRANSSHIP', 'ANY'];

function describe(r: YardRange) {
  return [r.purpose === 'ANY' ? null : r.purpose.toLowerCase(), r.visitRef, r.pod, r.line, r.size ? `${r.size}'` : null,
    r.weightClass ? { L: 'light', M: 'medium', H: 'heavy' }[r.weightClass] : null, r.reefer === true ? 'reefers' : r.reefer === false ? 'no reefers' : null]
    .filter(Boolean).join(' · ') || 'any cargo';
}

/** Planner ranges: reserved bays for a group of cargo. Units that do not match never go there. */
function RangesPanel({ ranges, blocks, canEdit, onChange }: { ranges: YardRange[]; blocks: YardBlock[]; canEdit: boolean; onChange: () => void }) {
  const visits = useApi<{ id: string; visitRef: string; phase: string }[]>(canEdit ? '/v1/visits' : null);
  const [f, setF] = useState({ name: '', block: '', bayFrom: '1', bayTo: '1', purpose: 'EXPORT', visitId: '', pod: '', line: '', size: '', weightClass: '', priority: '50' });
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <h3>Yard ranges</h3>
      <p className="muted small">Bays reserved for a group of cargo. Matching units fill them first (lowest priority number first); other units never go there. Empty reserved slots are outlined on the blocks above.</p>
      {ranges.length === 0 ? <p className="muted">No ranges: every stack is general space.</p> : (
        <table className="grid compact">
          <thead><tr><th>Name</th><th>Block</th><th>Bays</th><th>Rows</th><th>For</th><th>Priority</th><th>Fill</th><th /></tr></thead>
          <tbody>
            {ranges.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td><td>{r.block}</td>
                <td className="mono">{String(r.bayFrom).padStart(2, '0')}–{String(r.bayTo).padStart(2, '0')}</td>
                <td className="mono">{String(r.rowFrom).padStart(2, '0')}–{String(r.rowTo).padStart(2, '0')}</td>
                <td>{describe(r)}</td>
                <td className="num">{r.priority}</td>
                <td><span className="occ"><i style={{ width: `${r.slots ? Math.round((100 * r.occupied) / r.slots) : 0}%`, background: TONES.active.solid }} /></span> {r.occupied}/{r.slots}</td>
                <td>{canEdit && <button className="link" disabled={busy} onClick={() => run(async () => { await api.post(`/v1/yard/ranges/${r.id}/release`, {}); onChange(); })}>Release</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); run(async () => {
          await api.post('/v1/yard/ranges', {
            name: f.name.trim(), block: f.block, bayFrom: Number(f.bayFrom), bayTo: Number(f.bayTo), purpose: f.purpose, priority: Number(f.priority),
            visitId: f.visitId || undefined, pod: f.pod.trim().toUpperCase() || undefined, line: f.line.trim() || undefined,
            size: f.size || undefined, weightClass: f.weightClass || undefined,
          });
          setF({ ...f, name: '' });
          onChange();
        }); }}>
          <input required placeholder="Name, e.g. GMR exports SGSIN" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <select required value={f.block} onChange={(e) => setF({ ...f, block: e.target.value })} aria-label="Block">
            <option value="" disabled>Block…</option>
            {blocks.map((b) => <option key={b.code} value={b.code}>{b.code} ({b.bays} bays)</option>)}
          </select>
          <label>Bays <input type="number" min={1} value={f.bayFrom} onChange={(e) => setF({ ...f, bayFrom: e.target.value })} style={{ width: 60 }} /> – <input type="number" min={1} value={f.bayTo} onChange={(e) => setF({ ...f, bayTo: e.target.value })} style={{ width: 60 }} /></label>
          <select value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} aria-label="For">{PURPOSES.map((p) => <option key={p}>{p}</option>)}</select>
          {['EXPORT', 'TRANSSHIP'].includes(f.purpose) && (
            <select value={f.visitId} onChange={(e) => setF({ ...f, visitId: e.target.value })} aria-label="Vessel visit">
              <option value="">Any vessel</option>
              {(visits.data ?? []).filter((v) => !['DEPARTED', 'CANCELLED'].includes(v.phase)).map((v) => <option key={v.id} value={v.id}>{v.visitRef}</option>)}
            </select>
          )}
          <input placeholder="POD" value={f.pod} onChange={(e) => setF({ ...f, pod: e.target.value })} style={{ width: 80 }} />
          <input placeholder="Line" value={f.line} onChange={(e) => setF({ ...f, line: e.target.value })} style={{ width: 70 }} />
          <select value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} aria-label="Size"><option value="">Any size</option><option>20</option><option>40</option><option>45</option></select>
          <select value={f.weightClass} onChange={(e) => setF({ ...f, weightClass: e.target.value })} aria-label="Weight class"><option value="">Any weight</option><option value="L">Light &lt;10 t</option><option value="M">Medium 10–20 t</option><option value="H">Heavy &gt;20 t</option></select>
          <label>Priority <input type="number" min={1} max={100} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} style={{ width: 60 }} /></label>
          <button className="primary" disabled={busy}>Reserve</button>
          {error && <span className="error">{error}</span>}
        </form>
      )}
    </div>
  );
}
