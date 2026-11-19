import { Link } from 'react-router-dom';
import { CategoryChip, FlagPill, StatusBadge } from '../components/Badges';
import { formatDate } from '../grid/DataGrid';
import { useApi } from '../hooks';
import { CATEGORY_DOMAINS, TONES, ToneKey } from '../theme/colors';
import { GateTx, Unit, Visit, YardBlock } from '../types';

function Tile({ label, value, tone, to, note }: { label: string; value: number | string; tone: ToneKey; to: string; note?: string }) {
  return (
    <Link to={to} className="tile" style={{ borderTopColor: TONES[tone].solid }}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {note && <span className="tile-note">{note}</span>}
    </Link>
  );
}

export function Dashboard() {
  const visits = useApi<Visit[]>('/v1/visits');
  const units = useApi<Unit[]>('/v1/units');
  const yard = useApi<{ blocks: YardBlock[] }>('/v1/yard');
  const gate = useApi<GateTx[]>('/v1/gate/transactions');

  const v = visits.data ?? [];
  const u = units.data ?? [];
  const inYard = u.filter((x) => x.state === 'IN_YARD');
  const onHold = u.filter((x) => x.activeHolds > 0 && x.state !== 'DEPARTED');
  const today = new Date().toISOString().slice(0, 10);
  const gateToday = (gate.data ?? []).filter((g) => g.createdAt.slice(0, 10) === today);
  const rejectedToday = gateToday.filter((g) => g.status === 'REJECTED').length;
  const slots = (yard.data?.blocks ?? []).reduce((n, b) => n + b.slots, 0);
  const used = (yard.data?.blocks ?? []).reduce((n, b) => n + b.occupied, 0);
  const occ = slots ? Math.round((used / slots) * 100) : 0;
  const atBerth = v.filter((x) => ['ARRIVED', 'WORKING'].includes(x.phase));
  const expected = v.filter((x) => x.phase === 'PLANNED');

  return (
    <>
      <h1>Dashboard</h1>
      <div className="tiles">
        <Tile label="Vessels at berth" value={atBerth.length} tone="active" to="/visits" note={`${expected.length} expected`} />
        <Tile label="Units in yard" value={inYard.length} tone="active" to="/units" />
        <Tile label="Units on hold" value={onHold.length} tone={onHold.length ? 'blocked' : 'done'} to="/units" />
        <Tile label="Yard occupancy" value={`${occ}%`} tone={occ > 85 ? 'attention' : 'active'} to="/yard" note={`${used} of ${slots} slots`} />
        <Tile label="Gate today" value={gateToday.length} tone="done" to="/gate" note={rejectedToday ? `${rejectedToday} rejected` : 'no rejections'} />
      </div>

      <div className="two-col">
        <section className="card">
          <h3>Vessels at berth and expected</h3>
          <table className="grid small">
            <thead><tr><th>Visit</th><th>Vessel</th><th>Phase</th><th>ETA / ATA</th><th>Moves</th></tr></thead>
            <tbody>
              {[...atBerth, ...expected].slice(0, 10).map((x) => (
                <tr key={x.id}>
                  <td><Link to={`/visits/${x.id}`}>{x.visitRef}</Link></td>
                  <td>{x.vesselName}</td>
                  <td><StatusBadge domain="visitPhase" value={x.phase} /></td>
                  <td>{formatDate(x.ata ?? x.eta)}</td>
                  <td>{x.completedMoves}/{x.completedMoves + x.plannedMoves}</td>
                </tr>
              ))}
              {!atBerth.length && !expected.length && <tr><td colSpan={5} className="muted">No vessels at berth or expected.</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>Yard by category</h3>
          {Object.entries(CATEGORY_DOMAINS.category.values).map(([k, c]) => {
            const n = inYard.filter((x) => x.category === k).length;
            const pct = inYard.length ? (n / inYard.length) * 100 : 0;
            return (
              <div key={k} className="bar-row">
                <CategoryChip domain="category" value={k} />
                <span className="bar"><i style={{ width: `${pct}%`, background: c.color }} /></span>
                <span className="num">{n}</span>
              </div>
            );
          })}
          <h3>Units on hold</h3>
          {onHold.slice(0, 8).map((x) => (
            <div key={x.id} className="hold-row"><Link className="mono" to={`/units/${x.id}`}>{x.unitRef}</Link> <FlagPill flag="HOLD" detail={`Hold: ${(x.holdTypes ?? '').toLowerCase()}`} /></div>
          ))}
          {!onHold.length && <p className="muted">None.</p>}
        </section>
      </div>
    </>
  );
}
