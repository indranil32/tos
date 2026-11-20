import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { TONES } from '../theme/colors';
import { BayPlan, CraneSplitResult, Equipment } from '../types';
import { BayPlanView } from './BayPlan';
import { StatusBadge } from './Badges';

/** Bay plan with click-to-stow for load units. */
export function BayPlanPanel({ visitId }: { visitId: string }) {
  const plan = useApi<BayPlan>(`/v1/visits/${visitId}/bay-plan`);
  const { roles } = useSession();
  const [picking, setPicking] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  useLive(['unit.', 'work.', 'bayplan.', 'stowplan.', 'crane_split.'], plan.reload, 600);
  const planner = can(roles, 'tos:planner');
  const stow = (unitRef: string, cell: string | null) => run(async () => {
    await api.put(`/v1/visits/${visitId}/stow-plan`, { assignments: [{ unitRef, cell }] });
    setPicking(null);
    plan.reload();
  });
  if (!plan.data) return <p className="muted">{plan.error ?? 'Loading bay plan…'}</p>;
  const p = plan.data;
  return (
    <>
      {planner && p.unplannedLoads.length > 0 && (
        <div className="card form-row">
          <h3>Loads without a cell ({p.unplannedLoads.length})</h3>
          <span className="muted">Pick a unit, then click an empty cell.</span>
          <div className="flags wrap">
            {p.unplannedLoads.map((u) => (
              <button key={u.unitRef} className={picking === u.unitRef ? 'toggle active' : 'toggle'} onClick={() => setPicking(picking === u.unitRef ? null : u.unitRef)}
                title={`${u.isoType ?? ''} · POD ${u.pod ?? '?'}${u.weightKg ? ` · ${Math.round(u.weightKg / 100) / 10} t` : ''}`}>
                <span className="mono">{u.unitRef}</span> {u.isoType?.[0] === '2' ? '20′' : u.isoType ? '40′' : ''}
              </button>
            ))}
          </div>
          {error && <span className="error">{error}</span>}
        </div>
      )}
      {busy && <p className="muted">Saving…</p>}
      <BayPlanView plan={p} picking={picking} onPickCell={planner ? (cell) => picking && stow(picking, cell) : undefined} />
    </>
  );
}

/** Crane split: choose cranes in quay order, run the split, see the resulting crane queues. */
export function CraneSplitPanel({ visitId }: { visitId: string }) {
  const { roles } = useSession();
  const cranes = useApi<Equipment[]>('/v1/equipment');
  const current = useApi<{ movesPerHour: number | null; queues: { queue: string; crane: string; craneStatus: string; status: string; bayFrom: number | null; bayTo: number | null; planned: number; active: number; completed: number }[] }>(`/v1/visits/${visitId}/crane-split`);
  const [chosen, setChosen] = useState<string[]>([]);
  const [rate, setRate] = useState('25');
  const [result, setResult] = useState<CraneSplitResult | null>(null);
  const { busy, error, run } = useAction();
  useLive(['work.', 'crane_split.', 'equipment.'], current.reload, 600);
  const quayCranes = (cranes.data ?? []).filter((e) => ['QC', 'MHC'].includes(e.kind));
  const toggle = (code: string) => setChosen(chosen.includes(code) ? chosen.filter((c) => c !== code) : [...chosen, code].sort((a, b) =>
    quayCranes.findIndex((q) => q.code === a) - quayCranes.findIndex((q) => q.code === b)));
  const live = (current.data?.queues ?? []).filter((q) => q.status !== 'CLOSED');
  return (
    <>
      {can(roles, 'tos:planner') && (
        <div className="card form-row">
          <h3>Split the work</h3>
          <span className="muted">Cranes in quay order (first crane takes the lowest bays):</span>
          {quayCranes.map((q) => (
            <label key={q.code} className="chip-check">
              <input type="checkbox" checked={chosen.includes(q.code)} onChange={() => toggle(q.code)} /> {q.code} <StatusBadge domain="equipmentStatus" value={q.status} />
            </label>
          ))}
          {!quayCranes.length && <span className="muted">No quay cranes recorded (Equipment page).</span>}
          <label>Moves/hour <input type="number" min={1} max={80} value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 70 }} /></label>
          <button className="primary" disabled={busy || !chosen.length} onClick={() => run(async () => {
            setResult(await api.post<CraneSplitResult>(`/v1/visits/${visitId}/crane-split`, { cranes: chosen, movesPerHour: Number(rate) }));
            current.reload();
          })}>Split</button>
          {error && <span className="error">{error}</span>}
        </div>
      )}
      {result && (
        <p className="ok">Split {result.totalMoves} moves at {result.movesPerHour}/h: the vessel needs about {result.vesselHours} h with {result.cranes.filter((c) => c.moves).length} crane(s).
          {result.withoutCell.length > 0 && <span className="error"> {result.withoutCell.length} load(s) have no cell yet and are not in any queue; stow them and split again.</span>}</p>
      )}
      <div className="card">
        <h3>Crane queues</h3>
        {live.length === 0 ? <p className="muted">No crane split yet.</p> : (
          <table className="grid compact">
            <thead><tr><th>Crane</th><th>Bays</th><th>Queue</th><th>Status</th><th>Planned</th><th>Working</th><th>Done</th><th>Progress</th><th>Hours left</th></tr></thead>
            <tbody>
              {live.map((q) => {
                const total = q.planned + q.active + q.completed;
                const pct = total ? Math.round((100 * q.completed) / total) : 0;
                return (
                  <tr key={q.queue}>
                    <td>{q.crane} <StatusBadge domain="equipmentStatus" value={q.craneStatus} /></td>
                    <td className="mono">{q.bayFrom !== null ? `${String(q.bayFrom).padStart(2, '0')}–${String(q.bayTo).padStart(2, '0')}` : '–'}</td>
                    <td><Link to={`/work/${encodeURIComponent(q.queue)}`}>{q.queue}</Link></td>
                    <td><StatusBadge domain="queueStatus" value={q.status} /></td>
                    <td className="num">{q.planned}</td>
                    <td className="num">{q.active}</td>
                    <td className="num">{q.completed}</td>
                    <td><span className="occ" title={`${pct}%`}><i style={{ width: `${pct}%`, background: TONES.active.solid }} /></span> {pct}%</td>
                    <td className="num">{current.data?.movesPerHour ? Math.round(((q.planned + q.active) / current.data.movesPerHour) * 10) / 10 : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
