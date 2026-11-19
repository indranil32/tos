import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CategoryLegend, DwellLegend, FlagPill } from '../components/Badges';
import { useApi } from '../hooks';
import { CATEGORY_DOMAINS, dwellBand, FLAGS, lineColors, textOn, TONES } from '../theme/colors';
import { YardBlock, YardUnit } from '../types';

type ColourBy = 'category' | 'line' | 'dwell' | 'handling';

const COLOUR_BY: { key: ColourBy; label: string }[] = [
  { key: 'category', label: 'Category' },
  { key: 'line', label: 'Line' },
  { key: 'dwell', label: 'Dwell time' },
  { key: 'handling', label: 'Holds & special cargo' },
];

const days = (u: YardUnit) => (u.timeIn ? Math.floor((Date.now() - Date.parse(u.timeIn)) / 86_400_000) : 0);

export function YardView() {
  const { data, error, loading } = useApi<{ blocks: YardBlock[] }>('/v1/yard');
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
        {(data?.blocks ?? []).map((b) => <Block key={b.id} block={b} fill={fill} />)}
      </div>
    </>
  );
}

function Block({ block, fill }: { block: YardBlock; fill: (u: YardUnit) => string }) {
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
          <Row key={r} r={r + 1} bays={block.bays} tiers={block.tiers} stacks={stacks} fill={fill} />
        ))}
      </div>
    </section>
  );
}

function Row({ r, bays, tiers, stacks, fill }: { r: number; bays: number; tiers: number; stacks: Map<string, YardUnit[]>; fill: (u: YardUnit) => string }) {
  return (
    <>
      <span className="axis">{String(r).padStart(2, '0')}</span>
      {Array.from({ length: bays }, (_, b) => {
        const stack = stacks.get(`${b + 1}-${r}`) ?? [];
        const top = stack[0];
        if (!top) return <span key={b} className="slot empty" title={`Bay ${b + 1} row ${r}: empty`} />;
        return <UnitCell key={b} unit={top} fill={fill(top)} label={`${stack.length}/${tiers}`}
          title={stack.map((u) => `${u.position} ${u.unitRef}`).join('\n')} />;
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
