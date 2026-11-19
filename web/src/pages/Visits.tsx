import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { CategoryChip, StatusBadge, StatusLegend } from '../components/Badges';
import { DataGrid, formatDate, GridColumn } from '../grid/DataGrid';
import { category, date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { statusOf } from '../theme/colors';
import { Move, Visit } from '../types';

const visitColumns: GridColumn<Visit>[] = [
  text('visitRef', 'Visit', (r) => r.visitRef, { render: (r) => <Link to={`/visits/${r.id}`} onClick={(e) => e.stopPropagation()}>{r.visitRef}</Link> }),
  text('vessel', 'Vessel', (r) => r.vesselName),
  text('imo', 'IMO', (r) => r.imo, { hiddenByDefault: true }),
  enumCol('vesselType', 'Vessel type', (r) => r.vesselType, ['CONTAINER', 'GENERAL_CARGO', 'RORO', 'TANKER', 'BULK', 'CRUISE', 'OTHER'], { hiddenByDefault: true }),
  status('phase', 'Phase', 'visitPhase', (r) => r.phase),
  text('line', 'Line', (r) => r.lineOperator),
  text('voyageIn', 'Voyage in', (r) => r.voyageIn),
  text('voyageOut', 'Voyage out', (r) => r.voyageOut, { hiddenByDefault: true }),
  text('berth', 'Berth', (r) => r.berth),
  date('eta', 'ETA', (r) => r.eta),
  date('ata', 'ATA', (r) => r.ata),
  date('etd', 'ETD', (r) => r.etd, { hiddenByDefault: true }),
  date('atd', 'ATD', (r) => r.atd, { hiddenByDefault: true }),
  num('planned', 'Planned moves', (r) => r.plannedMoves),
  num('completed', 'Done moves', (r) => r.completedMoves),
  num('discharged', 'Discharged', (r) => r.discharged, { hiddenByDefault: true }),
  num('loaded', 'Loaded', (r) => r.loaded, { hiddenByDefault: true }),
];

export function Visits() {
  const { data, loading, error, reload } = useApi<Visit[]>('/v1/visits');
  const navigate = useNavigate();
  const { roles } = useSession();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <h1>Vessel visits</h1>
      {creating && <NewVisit onDone={() => { setCreating(false); reload(); }} onCancel={() => setCreating(false)} />}
      <DataGrid id="visits" rows={data} loading={loading} error={error} columns={visitColumns} rowKey={(r) => r.id}
        quickFilters={['phase']} defaultSort={[{ columnId: 'eta', dir: 'desc' }]}
        onRowClick={(r) => navigate(`/visits/${r.id}`)}
        rowAccent={(r) => statusOf('visitPhase', r.phase)?.tone.solid}
        legend={<StatusLegend domain="visitPhase" />}
        actions={can(roles, 'tos:planner') && <button className="primary" onClick={() => setCreating(true)}>New visit</button>} />
    </>
  );
}

function NewVisit({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ visitRef: '', imo: '', vesselName: '', lineOperator: '', voyageIn: '', voyageOut: '', berth: '', eta: '' });
  const { busy, error, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = () => run(async () => {
    if (f.vesselName) await api.post('/v1/vessels', { imo: f.imo, name: f.vesselName }).catch((e) => { if (e.status !== 409) throw e; });
    await api.post('/v1/visits', {
      visitRef: f.visitRef, imo: f.imo, lineOperator: f.lineOperator || undefined, voyageIn: f.voyageIn || undefined,
      voyageOut: f.voyageOut || undefined, berth: f.berth || undefined, eta: f.eta ? new Date(f.eta).toISOString() : undefined,
    });
    onDone();
  });
  return (
    <form className="card form-grid" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h3>New vessel visit</h3>
      <label>Visit ref<input required value={f.visitRef} onChange={set('visitRef')} /></label>
      <label>IMO<input required pattern="[0-9]{7}" value={f.imo} onChange={set('imo')} /></label>
      <label>Vessel name (new vessels)<input value={f.vesselName} onChange={set('vesselName')} /></label>
      <label>Line<input value={f.lineOperator} onChange={set('lineOperator')} /></label>
      <label>Voyage in<input value={f.voyageIn} onChange={set('voyageIn')} /></label>
      <label>Voyage out<input value={f.voyageOut} onChange={set('voyageOut')} /></label>
      <label>Berth<input value={f.berth} onChange={set('berth')} /></label>
      <label>ETA<input type="datetime-local" value={f.eta} onChange={set('eta')} /></label>
      <div className="form-actions">
        <button className="primary" disabled={busy}>Create</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {error && <span className="error">{error}</span>}
      </div>
    </form>
  );
}

const moveColumns: GridColumn<Move>[] = [
  enumCol('kind', 'Move', (r) => r.moveKind, ['DISCHARGE', 'LOAD', 'YARD_SHIFT', 'GATE_IN', 'GATE_OUT']),
  status('status', 'Status', 'moveStatus', (r) => r.status),
  text('unit', 'Unit', (r) => r.unitRef),
  category('cargoKind', 'Cargo', 'cargoKind', (r) => r.cargoKind),
  text('iso', 'ISO type', (r) => r.isoType),
  text('from', 'From', (r) => r.fromPosition),
  text('to', 'To', (r) => r.toPosition),
  text('che', 'Equipment', (r) => r.cheId, { hiddenByDefault: true }),
  num('weight', 'Weight (kg)', (r) => r.grossWeightKg, { hiddenByDefault: true }),
  date('completedAt', 'Completed', (r) => r.completedAt),
];

export function VisitDetail() {
  const { id } = useParams();
  const { roles } = useSession();
  const visit = useApi<Visit>(`/v1/visits/${id}`);
  const moves = useApi<Move[]>(`/v1/visits/${id}/moves`);
  const act = useAction();
  const [unitRef, setUnitRef] = useState('');
  const [target, setTarget] = useState('');
  const v = visit.data;
  const refresh = () => { visit.reload(); moves.reload(); };
  const plannedDischarge = useMemo(() => (moves.data ?? []).filter((m) => m.moveKind === 'DISCHARGE' && m.status === 'PLANNED'), [moves.data]);
  const plannedLoad = useMemo(() => (moves.data ?? []).filter((m) => m.moveKind === 'LOAD' && m.status === 'PLANNED'), [moves.data]);
  const working = v && ['ARRIVED', 'WORKING'].includes(v.phase);
  const download = async (kind: 'DISCHARGE' | 'LOAD') => {
    const text = await act.run(() => api.get<string>(`/v1/edi/outbound/coarri/${id}?kind=${kind}`, { text: true }));
    if (!text) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/edifact' }));
    a.download = `COARRI-${v?.visitRef}-${kind}.edi`;
    a.click();
  };
  if (!v) return <p className="muted">{visit.error ?? 'Loading…'}</p>;
  return (
    <>
      <p><Link to="/visits">← Vessel visits</Link></p>
      <div className="detail-head">
        <h1>{v.visitRef} · {v.vesselName}</h1>
        <StatusBadge domain="visitPhase" value={v.phase} />
      </div>
      <dl className="facts">
        <div><dt>IMO</dt><dd>{v.imo}</dd></div>
        <div><dt>Line</dt><dd>{v.lineOperator ?? '–'}</dd></div>
        <div><dt>Voyage</dt><dd>{v.voyageIn ?? '–'} / {v.voyageOut ?? '–'}</dd></div>
        <div><dt>Berth</dt><dd>{v.berth ?? '–'}</dd></div>
        <div><dt>ETA</dt><dd>{formatDate(v.eta)}</dd></div>
        <div><dt>ATA</dt><dd>{formatDate(v.ata)}</dd></div>
        <div><dt>ATD</dt><dd>{formatDate(v.atd)}</dd></div>
        <div><dt>Moves</dt><dd>{v.completedMoves} done / {v.plannedMoves} planned</dd></div>
      </dl>
      <div className="toolbar">
        {can(roles, 'tos:planner', 'tos:operator') && v.phase === 'PLANNED' && (
          <button className="primary" disabled={act.busy} onClick={() => act.run(() => api.post(`/v1/visits/${id}/arrive`)).then(refresh)}>Arrive</button>
        )}
        {can(roles, 'tos:planner', 'tos:operator') && working && (
          <button disabled={act.busy} onClick={() => confirm('Depart this vessel? Unworked moves will be cancelled.') && act.run(() => api.post(`/v1/visits/${id}/depart`)).then(refresh)}>Depart</button>
        )}
        <button onClick={() => download('DISCHARGE')}>COARRI discharge</button>
        <button onClick={() => download('LOAD')}>COARRI load</button>
        {act.error && <span className="error">{act.error}</span>}
      </div>
      {working && can(roles, 'tos:operator') && (
        <div className="card form-row">
          <h3>Confirm a move</h3>
          <select value={unitRef} onChange={(e) => setUnitRef(e.target.value)} aria-label="Unit">
            <option value="">Choose a unit…</option>
            {plannedDischarge.length > 0 && <optgroup label="Discharge">{plannedDischarge.map((m) => <option key={m.id} value={`D:${m.unitRef}`}>{m.unitRef}</option>)}</optgroup>}
            {plannedLoad.length > 0 && <optgroup label="Load">{plannedLoad.map((m) => <option key={m.id} value={`L:${m.unitRef}`}>{m.unitRef}</option>)}</optgroup>}
          </select>
          <input placeholder={unitRef.startsWith('L:') ? 'Stow cell (e.g. 0120682)' : 'Yard slot (blank = auto)'} value={target} onChange={(e) => setTarget(e.target.value)} />
          <button className="primary" disabled={!unitRef || act.busy} onClick={() => {
            const [kind, ref] = unitRef.split(':');
            const body = kind === 'D' ? { unitRef: ref, position: target || undefined } : { unitRef: ref, stowPosition: target || undefined };
            act.run(() => api.post(`/v1/visits/${id}/${kind === 'D' ? 'discharges' : 'loads'}`, body)).then((r) => { if (r) { setUnitRef(''); setTarget(''); refresh(); } });
          }}>Confirm</button>
        </div>
      )}
      <DataGrid id="visit-moves" title="Moves" rows={moves.data} loading={moves.loading} error={moves.error} columns={moveColumns}
        rowKey={(r) => r.id} quickFilters={['kind', 'status']} defaultSort={[{ columnId: 'status', dir: 'asc' }, { columnId: 'unit', dir: 'asc' }]}
        rowAccent={(r) => statusOf('moveStatus', r.status)?.tone.solid} />
      <LoadListUpload visitId={id!} onDone={refresh} />
      <p className="muted small">Cargo kinds on this visit: {[...new Set((moves.data ?? []).map((m) => m.cargoKind))].map((k) => <CategoryChip key={k} domain="cargoKind" value={k} />)}</p>
    </>
  );
}

function LoadListUpload({ visitId, onDone }: { visitId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('move,unitRef,isoType,cargoKind,grossWeightKg,pol,pod,category\nDISCHARGE,MSCU1234565,22G1,CONTAINER,21000,CNSHA,AEKHL,IMPORT');
  const { busy, error, run } = useAction();
  const [result, setResult] = useState<string | null>(null);
  const { roles } = useSession();
  if (!can(roles, 'tos:planner')) return null;
  const submit = () => run(async () => {
    const [head, ...lines] = csv.trim().split(/\r?\n/);
    const keys = head.split(',').map((k) => k.trim());
    const items = lines.filter(Boolean).map((l) => {
      const vals = l.split(',');
      const o: Record<string, unknown> = {};
      keys.forEach((k, i) => {
        const v = vals[i]?.trim();
        if (!v) return;
        o[k] = ['grossWeightKg', 'vgmKg', 'quantity'].includes(k) ? Number(v) : k === 'isReefer' ? v === 'true' : v;
      });
      return o;
    });
    const r = await api.post<{ created: number; updated: number }>(`/v1/visits/${visitId}/load-lists`, { items });
    setResult(`${r.created} created, ${r.updated} updated`);
    onDone();
  });
  return (
    <details className="card" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Add to the load / discharge list (CSV)</summary>
      <textarea rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} aria-label="Load list CSV" />
      <div className="form-actions">
        <button className="primary" disabled={busy} onClick={submit}>Apply load list</button>
        {result && <span className="ok">{result}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </details>
  );
}
