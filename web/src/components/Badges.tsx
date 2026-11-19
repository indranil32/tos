import {
  CATEGORY_DOMAINS, CategoryDomainKey, categoryOf, DWELL_RAMP, FLAGS, FlagKey, STATUS_DOMAINS, StatusDomainKey, statusOf, TONES,
} from '../theme/colors';

/** Filled badge with icon: a status (where something is in its life cycle). */
export function StatusBadge({ domain, value }: { domain: StatusDomainKey; value: string | null | undefined }) {
  const s = statusOf(domain, value);
  if (!s) return value ? <span className="badge">{value}</span> : null;
  const t = s.tone;
  return (
    <span
      className="badge"
      title={`${s.value.label}: ${s.value.meaning}`}
      style={{ background: t.bg, color: t.fg, borderColor: t.border, borderStyle: t.borderStyle }}
    >
      <span aria-hidden="true" className="badge-icon">{t.icon}</span>
      {s.value.label}
    </span>
  );
}

/** Outlined chip with a colour bar and icon: a category (what something is). */
export function CategoryChip({ domain, value }: { domain: CategoryDomainKey; value: string | null | undefined }) {
  const c = categoryOf(domain, value);
  if (!c) return value ? <span className="chip">{value}</span> : null;
  return (
    <span className="chip" title={c.meaning} style={{ borderLeftColor: c.color }}>
      <span aria-hidden="true" style={{ color: c.color }}>{c.icon}</span>
      {c.label}
    </span>
  );
}

/** Pill with a symbol: special handling. */
export function FlagPill({ flag, detail }: { flag: FlagKey; detail?: string }) {
  const f = FLAGS[flag];
  return (
    <span className="pill" title={f.meaning} style={{ background: f.bg, color: f.fg, borderColor: f.border }}>
      <span aria-hidden="true">{f.icon}</span>
      {detail ?? f.label}
    </span>
  );
}

interface UnitLike {
  dgClass?: string | null;
  dgUnNumber?: string | null;
  isReefer?: boolean;
  activeHolds?: number;
  holdTypes?: string | null;
  category?: string;
  freightKind?: string;
  cargoKind?: string;
  vgmKg?: string | number | null;
  state?: string;
}

/** The special-handling flags of a unit, in a fixed order, identical on every screen. */
export function UnitFlags({ unit }: { unit: UnitLike }) {
  const noVgm =
    unit.cargoKind === 'CONTAINER' && ['EXPORT', 'TRANSSHIP'].includes(unit.category ?? '') &&
    unit.freightKind !== 'MTY' && !unit.vgmKg && unit.state !== 'LOADED' && unit.state !== 'DEPARTED';
  return (
    <span className="flags">
      {!!unit.activeHolds && <FlagPill flag="HOLD" detail={unit.holdTypes ? `Hold: ${unit.holdTypes.toLowerCase()}` : 'Hold'} />}
      {unit.dgClass && <FlagPill flag="DG" detail={`DG ${unit.dgClass}${unit.dgUnNumber ? ` · UN${unit.dgUnNumber}` : ''}`} />}
      {unit.isReefer && <FlagPill flag="REEFER" />}
      {noVgm && <FlagPill flag="NO_VGM" />}
    </span>
  );
}

export function StatusLegend({ domain }: { domain: StatusDomainKey }) {
  const d = STATUS_DOMAINS[domain];
  return (
    <div className="legend" aria-label={`${d.label} legend`}>
      {Object.keys(d.values).map((k) => <StatusBadge key={k} domain={domain} value={k} />)}
    </div>
  );
}

export function CategoryLegend({ domain }: { domain: CategoryDomainKey }) {
  const d = CATEGORY_DOMAINS[domain];
  return (
    <div className="legend" aria-label={`${d.label} legend`}>
      {Object.entries(d.values).map(([k, v]) => (
        <span key={k} className="legend-swatch"><i style={{ background: v.color }} />{v.icon} {v.label}</span>
      ))}
    </div>
  );
}

export function DwellLegend() {
  return (
    <div className="legend" aria-label="Dwell time legend">
      {DWELL_RAMP.map((b) => <span key={b.label} className="legend-swatch"><i style={{ background: b.color }} />{b.label}</span>)}
    </div>
  );
}

export function ToneSwatch({ tone }: { tone: keyof typeof TONES }) {
  const t = TONES[tone];
  return <span className="badge" style={{ background: t.bg, color: t.fg, borderColor: t.border, borderStyle: t.borderStyle }}><span aria-hidden="true" className="badge-icon">{t.icon}</span>{t.label}</span>;
}
