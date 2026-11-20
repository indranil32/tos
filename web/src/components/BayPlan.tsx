import { useMemo, useState } from 'react';
import { BayCell, BayPlan } from '../types';
import { lineColors, statusOf, textOn } from '../theme/colors';
import { StatusLegend } from './Badges';

type ColourBy = 'state' | 'pod' | 'crane';

const GLYPH: Record<string, string> = { DISCHARGE: '↓', LOAD: '↑', RESTOW: '⟳', DISCHARGED: '✓', LOADED: '✓', RESTOWED: '✓', ROB: '' };

/**
 * Bay plan: one cross-section per 20' bay, as seen from astern (port side left). Deck tiers above the hatch-cover
 * line, hold tiers below. A 40' unit (even bay) is drawn in both 20' bays it spans, marked "40".
 * When onPickCell is set, empty cells are clickable (used to stow a selected load unit).
 */
export function BayPlanView({ plan, onPickCell, picking, pickingIso }: { plan: BayPlan; onPickCell?: (cell: string) => void; picking?: string | null; pickingIso?: string | null }) {
  const [by, setBy] = useState<ColourBy>('state');
  const [onlyUsed, setOnlyUsed] = useState(true);
  const { maxBay, maxRow, holdTiers, deckTiers } = plan.profile;

  const index = useMemo(() => {
    const m = new Map<string, { c: BayCell; is40: boolean }>();
    for (const c of plan.cells) {
      const bays = c.bay % 2 === 0 ? [c.bay - 1, c.bay + 1] : [c.bay];
      for (const b of bays) m.set(`${b}-${c.row}-${c.tier}`, { c, is40: c.bay % 2 === 0 });
    }
    return m;
  }, [plan.cells]);

  const pods = useMemo(() => lineColors(plan.cells.map((c) => c.pod ?? '')), [plan.cells]);
  const cranes = useMemo(() => lineColors(plan.cells.map((c) => c.crane ?? '')), [plan.cells]);
  const fill = (c: BayCell) => {
    if (by === 'pod') return pods[c.pod ?? ''] ?? '#999999';
    if (by === 'crane') return c.crane ? cranes[c.crane] : '#D6DBE2';
    return statusOf('stowState', c.state)?.tone.solid ?? '#999999';
  };

  const evenRows = Array.from({ length: Math.floor(maxRow / 2) }, (_, i) => (Math.floor(maxRow / 2) - i) * 2);
  const hasZero = plan.cells.some((c) => c.row === 0);
  const oddRows = Array.from({ length: Math.ceil(maxRow / 2) }, (_, i) => i * 2 + 1);
  const rows = [...evenRows, ...(hasZero ? [0] : []), ...oddRows];
  const deck = Array.from({ length: deckTiers }, (_, i) => 80 + 2 * (deckTiers - i));
  const hold = Array.from({ length: holdTiers }, (_, i) => 2 * (holdTiers - i));
  const bays = Array.from({ length: Math.ceil(maxBay / 2) }, (_, i) => i * 2 + 1)
    .filter((b) => !onlyUsed || picking || plan.cells.some((c) => c.bay === b || c.bay === b - 1 || c.bay === b + 1));

  const cellView = (bay: number, row: number, tier: number) => {
    const hit = index.get(`${bay}-${row}-${tier}`);
    const code = `${String(bay).padStart(3, '0')}${String(row).padStart(2, '0')}${String(tier).padStart(2, '0')}`;
    if (!hit) {
      // A 40'/45' unit goes in the even bay spanning this 20' bay and its pair (01+03 -> 02).
      const long = !!pickingIso && pickingIso[0] !== '2';
      const target = long ? `${String(bay % 4 === 1 ? bay + 1 : bay - 1).padStart(3, '0')}${code.slice(3)}` : code;
      const pairFree = !long || !index.has(`${bay % 4 === 1 ? bay + 2 : bay - 2}-${row}-${tier}`);
      return picking && onPickCell && pairFree
        ? <button key={code} className="bp-cell empty pick" title={`Stow ${picking} in ${target}`} onClick={() => onPickCell(target)} />
        : <span key={code} className="bp-cell empty" title={code} />;
    }
    const { c, is40 } = hit;
    const bg = fill(c);
    const tip = [
      `${c.cell} · ${c.unitRef ?? ''} ${c.isoType ?? ''}`,
      statusOf('stowState', c.state)?.value.label,
      c.pod ? `POD ${c.pod}` : null, c.weightKg ? `${Math.round(c.weightKg / 100) / 10} t` : null,
      c.dgClass ? `DG ${c.dgClass}` : null, c.isReefer ? 'reefer' : null, c.crane ? `crane ${c.crane}` : null,
    ].filter(Boolean).join('\n');
    return (
      <span key={code} className={`bp-cell${c.state === 'ROB' ? ' rob' : ''}`} style={{ background: bg, color: textOn(bg) }} title={tip}>
        {GLYPH[c.state]}{is40 && <small>40</small>}{c.dgClass && <i className="bp-dg">◆</i>}{c.isReefer && <i className="bp-rf">❄</i>}
      </span>
    );
  };

  return (
    <div className="card bayplan">
      <div className="bp-toolbar">
        <span>Colour by</span>
        {(['state', 'pod', 'crane'] as const).map((k) => (
          <button key={k} className={by === k ? 'toggle active' : 'toggle'} onClick={() => setBy(k)}>{{ state: 'Move', pod: 'Port of discharge', crane: 'Crane' }[k]}</button>
        ))}
        <label className="muted"><input type="checkbox" checked={onlyUsed} onChange={(e) => setOnlyUsed(e.target.checked)} /> Only bays in use</label>
        <span className="spacer" />
        <span className="muted">{Object.entries(plan.counts).map(([k, n]) => `${statusOf('stowState', k)?.value.label ?? k} ${n}`).join(' · ')}</span>
      </div>
      {by === 'state' && <StatusLegend domain="stowState" />}
      {by !== 'state' && (
        <div className="legend">
          {Object.entries(by === 'pod' ? pods : cranes).filter(([k]) => k).map(([k, c]) => <span key={k} className="legend-swatch"><i style={{ background: c }} />{k}</span>)}
        </div>
      )}
      <div className="bp-bays">
        {bays.map((bay) => (
          <section key={bay} className="bp-bay" aria-label={`Bay ${bay}`}>
            <header>Bay {String(bay).padStart(2, '0')} <span className="muted">· 40′ bay {String(bay % 4 === 1 ? bay + 1 : bay - 1).padStart(2, '0')}</span></header>
            <div className="bp-grid" style={{ gridTemplateColumns: `2em repeat(${rows.length}, 1.6em)` }}>
              <span />
              {rows.map((r) => <span key={r} className="bp-axis">{String(r).padStart(2, '0')}</span>)}
              {deck.map((t) => (
                <Row key={t} t={t}>{rows.map((r) => cellView(bay, r, t))}</Row>
              ))}
              <span className="bp-hatch" style={{ gridColumn: `1 / span ${rows.length + 1}` }} />
              {hold.map((t) => (
                <Row key={t} t={t}>{rows.map((r) => cellView(bay, r, t))}</Row>
              ))}
            </div>
          </section>
        ))}
        {!bays.length && <p className="muted">No cells yet. Send the arrival BAPLIE or plan load cells.</p>}
      </div>
    </div>
  );
}

function Row({ t, children }: { t: number; children: React.ReactNode }) {
  return (
    <>
      <span className="bp-axis">{String(t).padStart(2, '0')}</span>
      {children}
    </>
  );
}
