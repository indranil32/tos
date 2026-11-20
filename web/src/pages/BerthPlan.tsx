import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { StatusBadge, StatusLegend } from '../components/Badges';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { statusOf, textOn } from '../theme/colors';
import { BerthPlanVisit } from '../types';

interface PlanData {
  from: string;
  to: string;
  berths: { code: string; name: string; berthKind: string; startMarkM: number; lengthM: number; depthM: number | null }[];
  visits: BerthPlanVisit[];
}

const DAY = 864e5;

/**
 * Berth plan: time runs left to right, the quay top to bottom (metre marks). Each placed visit is a box from
 * berthing to departure over the quay metres it occupies, coloured by phase. Visits not yet placed are listed below.
 */
export function BerthPlanPage() {
  const [start, setStart] = useState(() => new Date(Math.floor((Date.now() - DAY) / DAY) * DAY));
  const days = 10;
  const to = new Date(start.getTime() + days * DAY);
  const plan = useApi<PlanData>(`/v1/berth-plan?from=${start.toISOString()}&to=${to.toISOString()}`);
  const navigate = useNavigate();
  const { roles } = useSession();
  const [placing, setPlacing] = useState<BerthPlanVisit | null>(null);
  useLive(['vessel-call.', 'unit.discharged', 'unit.loaded'], plan.reload, 800);
  const d = plan.data;
  const placed = (d?.visits ?? []).filter((v) => v.quayFromM !== null && v.loaM);
  const waiting = (d?.visits ?? []).filter((v) => v.quayFromM === null && !['DEPARTED'].includes(v.phase));
  const shift = (n: number) => setStart(new Date(start.getTime() + n * DAY));
  return (
    <>
      <h1>Berth plan</h1>
      <div className="toolbar">
        <button onClick={() => shift(-3)}>← 3 days</button>
        <button onClick={() => setStart(new Date(Math.floor((Date.now() - DAY) / DAY) * DAY))}>Today</button>
        <button onClick={() => shift(3)}>3 days →</button>
        <span className="muted">{start.toLocaleDateString()} – {to.toLocaleDateString()}</span>
        <span className="spacer" />
        <StatusLegend domain="visitPhase" />
      </div>
      {plan.error && <p className="error">{plan.error}</p>}
      {d && <Chart data={d} start={start} days={days} visits={placed} onOpen={(v) => navigate(`/visits/${v.id}`)} onMove={can(roles, 'tos:planner') ? setPlacing : undefined} />}
      {can(roles, 'tos:planner') && d && d.visits.some((v) => v.phase !== 'DEPARTED') && (
        <PlaceForm key={placing?.id ?? 'new'} berths={d.berths} visits={d.visits.filter((v) => v.phase !== 'DEPARTED')}
          initial={placing} onDone={() => { setPlacing(null); plan.reload(); }} />
      )}
      {waiting.length > 0 && (
        <div className="card">
          <h3>Waiting for a berth</h3>
          <table className="grid compact">
            <thead><tr><th>Visit</th><th>Vessel</th><th>LOA</th><th>ETA</th><th>Phase</th><th /></tr></thead>
            <tbody>
              {waiting.map((v) => (
                <tr key={v.id}>
                  <td><Link to={`/visits/${v.id}`}>{v.visitRef}</Link></td>
                  <td>{v.vesselName}</td>
                  <td>{v.loaM ? `${v.loaM} m` : <span className="error">no LOA</span>}</td>
                  <td>{v.eta ? new Date(v.eta).toLocaleString() : '–'}</td>
                  <td><StatusBadge domain="visitPhase" value={v.phase} /></td>
                  <td>{can(roles, 'tos:planner') && <button className="link" onClick={() => setPlacing(v)}>Place</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Chart({ data, start, days, visits, onOpen, onMove }: {
  data: PlanData; start: Date; days: number; visits: BerthPlanVisit[];
  onOpen: (v: BerthPlanVisit) => void; onMove?: (v: BerthPlanVisit) => void;
}) {
  const left = 90;
  const W = 1100;
  const quayEnd = Math.max(1, ...data.berths.map((b) => b.startMarkM + b.lengthM), ...visits.map((v) => (v.quayFromM ?? 0) + (v.loaM ?? 0)));
  const H = Math.max(160, Math.min(560, quayEnd * 0.9));
  const top = 28;
  const x = (t: string | Date) => left + ((new Date(t).getTime() - start.getTime()) / (days * DAY)) * (W - left - 10);
  const y = (m: number) => top + (m / quayEnd) * (H - top - 8);
  const now = Date.now();
  const ticks = useMemo(() => Array.from({ length: days + 1 }, (_, i) => new Date(start.getTime() + i * DAY)), [start, days]);
  if (!data.berths.length) return <p className="muted">No berths recorded. Add them on the Terminal page.</p>;
  return (
    <figure className="card berth-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Berth plan">
        {data.berths.map((b, i) => (
          <g key={b.code}>
            <rect x={left} y={y(b.startMarkM)} width={W - left - 10} height={y(b.startMarkM + b.lengthM) - y(b.startMarkM)} fill={i % 2 ? '#F4F6F9' : '#FFFFFF'} stroke="#E1E5EB" />
            <text x={8} y={y(b.startMarkM) + 16} className="sk-name">{b.code}</text>
            <text x={8} y={y(b.startMarkM) + 32} className="sk-small muted-fill">{b.startMarkM}–{b.startMarkM + b.lengthM} m</text>
            {b.depthM && <text x={8} y={y(b.startMarkM) + 46} className="sk-small muted-fill">{b.depthM} m deep</text>}
          </g>
        ))}
        {ticks.map((t) => (
          <g key={t.toISOString()}>
            <line x1={x(t)} x2={x(t)} y1={top - 6} y2={H - 8} stroke="#E1E5EB" />
            <text x={x(t) + 4} y={16} className="sk-small muted-fill">{t.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</text>
          </g>
        ))}
        {now > start.getTime() && now < start.getTime() + days * DAY && (
          <line x1={x(new Date(now))} x2={x(new Date(now))} y1={top - 6} y2={H - 8} stroke="#D23A2F" strokeDasharray="4 3" />
        )}
        {visits.map((v) => {
          const from = v.ata ?? v.etb ?? v.eta!;
          // A vessel still alongside after its planned departure is drawn up to now (overstay).
          const alongside = ['ARRIVED', 'WORKING'].includes(v.phase);
          const until = v.atd ?? (alongside && Date.parse(v.etd!) < now ? new Date(now).toISOString() : v.etd!);
          const overstay = alongside && Date.parse(v.etd!) < now;
          const x0 = Math.max(left, x(from));
          const x1 = Math.min(W - 10, x(until));
          if (x1 <= left || x0 >= W - 10) return null;
          const tone = statusOf('visitPhase', v.phase)?.tone;
          const bg = tone?.solid ?? '#9AA7B8';
          const y0 = y(v.quayFromM!);
          const h = y(v.quayFromM! + v.loaM!) - y0;
          const done = v.openMoves + v.doneMoves ? v.doneMoves / (v.openMoves + v.doneMoves) : 0;
          return (
            <g key={v.id} className="bp-visit" onClick={() => onOpen(v)} onContextMenu={(e) => { if (onMove) { e.preventDefault(); onMove(v); } }}>
              <title>{`${v.visitRef} ${v.vesselName} (${v.loaM} m) · ${v.berth} ${v.quayFromM}–${v.quayFromM! + v.loaM!} m\n${new Date(from).toLocaleString()} → ${new Date(until).toLocaleString()}\n${v.doneMoves} of ${v.openMoves + v.doneMoves} moves done${overstay ? '\nStill alongside after planned departure' : ''}`}</title>
              <rect x={x0} y={y0 + 1} width={Math.max(4, x1 - x0)} height={Math.max(6, h - 2)} rx={6} fill={bg} stroke={tone?.border} strokeDasharray={tone?.borderStyle === 'dashed' ? '5 3' : undefined} />
              <rect x={x0} y={y0 + h - 6} width={Math.max(0, (x1 - x0) * done)} height={4} fill="rgba(255,255,255,0.8)" />
              {overstay && <line x1={Math.max(left, x(v.etd!))} x2={Math.max(left, x(v.etd!))} y1={y0 + 2} y2={y0 + h - 2} stroke="#FFFFFF" strokeWidth={2} strokeDasharray="3 2" />}
              <text x={x0 + 8} y={y0 + 18} fill={textOn(bg)} className="sk-name">{v.visitRef}</text>
              {h > 34 && <text x={x0 + 8} y={y0 + 34} fill={textOn(bg)} className="sk-small">{v.vesselName}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="muted small">Click a vessel to open it{onMove ? '; right-click to move it' : ''}. The white bar shows moves done.</figcaption>
    </figure>
  );
}

function toLocalInput(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function PlaceForm({ berths, visits, initial, onDone }: { berths: PlanData['berths']; visits: BerthPlanVisit[]; initial: BerthPlanVisit | null; onDone: () => void }) {
  const [visitId, setVisitId] = useState(initial?.id ?? '');
  const v = visits.find((x) => x.id === visitId);
  const [f, setF] = useState({
    berth: initial?.berth ?? berths[0]?.code ?? '', quayFromM: initial?.quayFromM?.toString() ?? '',
    etb: toLocalInput(initial?.etb ?? initial?.eta), etd: toLocalInput(initial?.etd),
  });
  const { busy, error, run } = useAction();
  const pick = (id: string) => {
    setVisitId(id);
    const x = visits.find((y) => y.id === id);
    if (x) setF({ berth: x.berth ?? f.berth, quayFromM: x.quayFromM?.toString() ?? '', etb: toLocalInput(x.etb ?? x.eta), etd: toLocalInput(x.etd) });
  };
  return (
    <form className="card form-row" onSubmit={(e) => { e.preventDefault(); run(async () => {
      await api.put(`/v1/visits/${visitId}/berth-plan`, {
        berth: f.berth, quayFromM: f.quayFromM ? Number(f.quayFromM) : undefined,
        etb: new Date(f.etb).toISOString(), etd: new Date(f.etd).toISOString(),
      });
      onDone();
    }); }}>
      <h3>Place or move a visit</h3>
      <select required value={visitId} onChange={(e) => pick(e.target.value)} aria-label="Visit">
        <option value="" disabled>Visit…</option>
        {visits.map((x) => <option key={x.id} value={x.id}>{x.visitRef} · {x.vesselName}{x.loaM ? ` (${x.loaM} m)` : ''}</option>)}
      </select>
      <select value={f.berth} onChange={(e) => setF({ ...f, berth: e.target.value, quayFromM: '' })} aria-label="Berth">
        {berths.map((b) => <option key={b.code} value={b.code}>{b.code} · {b.startMarkM}–{b.startMarkM + b.lengthM} m</option>)}
      </select>
      <input type="number" min={0} placeholder="From m (berth start)" value={f.quayFromM} onChange={(e) => setF({ ...f, quayFromM: e.target.value })} style={{ width: 150 }} />
      <label>Berthing <input required type="datetime-local" value={f.etb} onChange={(e) => setF({ ...f, etb: e.target.value })} /></label>
      <label>Departure <input required type="datetime-local" value={f.etd} onChange={(e) => setF({ ...f, etd: e.target.value })} /></label>
      <button className="primary" disabled={busy || !visitId || (v && !v.loaM)}>Place</button>
      {v && !v.loaM && <span className="error">Set the vessel's length overall first.</span>}
      {error && <span className="error">{error}</span>}
    </form>
  );
}
