import { useEffect, useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { StatusLegend } from '../components/Badges';
import { DataGrid, GridColumn } from '../grid/DataGrid';
import { bool, date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { STATUS_DOMAINS, statusOf } from '../theme/colors';
import { Equipment } from '../types';

export const EQUIPMENT_KINDS: Record<string, string> = {
  QC: 'Quay crane', MHC: 'Mobile harbour crane', RTG: 'Rubber-tyred gantry', RMG: 'Rail-mounted gantry', RS: 'Reach stacker',
  ECH: 'Empty handler', SC: 'Straddle carrier', TT: 'Terminal truck', FLT: 'Forklift', MAFI: 'Mafi / roll trailer',
  RAIL_CRANE: 'Rail crane', PUMP: 'Pump / manifold',
};

const columns: GridColumn<Equipment>[] = [
  text('code', 'Machine', (r) => r.code, { render: (r) => <span className="mono">{r.code}</span> }),
  enumCol('kind', 'Kind', (r) => r.kind, Object.keys(EQUIPMENT_KINDS), { render: (r) => <span title={EQUIPMENT_KINDS[r.kind]}>{r.kind}</span> }),
  text('pool', 'Pool', (r) => r.pool),
  status('status', 'Status', 'equipmentStatus', (r) => r.status),
  text('operator', 'Operator', (r) => r.operator),
  text('position', 'Last position', (r) => r.position, { render: (r) => <span className="mono">{r.position}</span> }),
  num('openJobs', 'Open jobs', (r) => r.openJobs),
  date('statusSince', 'Since', (r) => r.statusSince),
  text('reason', 'Reason', (r) => r.statusReason),
  num('maxWeight', 'Max kg', (r) => r.maxWeightKg, { hiddenByDefault: true }),
  bool('twin', 'Twin lift', (r) => r.twinLift, { hiddenByDefault: true }),
];

export function EquipmentPage() {
  const list = useApi<Equipment[]>('/v1/equipment');
  const { roles } = useSession();
  const [selected, setSelected] = useState<Equipment | null>(null);
  useLive(['equipment.', 'work.'], list.reload);
  return (
    <>
      <h1>Equipment</h1>
      <p className="muted">Machines, their status and who is on them. Updates live as operators log on, take jobs or report a breakdown.</p>
      {can(roles, 'tos:operator', 'tos:planner') && (
        <StatusForm machines={list.data ?? []} selected={selected} onDone={list.reload} />
      )}
      <DataGrid id="equipment" rows={list.data} loading={list.loading} error={list.error} columns={columns} rowKey={(r) => r.id}
        quickFilters={['status', 'kind']} defaultSort={[{ columnId: 'kind', dir: 'asc' }, { columnId: 'code', dir: 'asc' }]}
        onRowClick={setSelected}
        rowAccent={(r) => statusOf('equipmentStatus', r.status)?.tone.solid}
        legend={<StatusLegend domain="equipmentStatus" />}
        actions={can(roles, 'tos:admin') && <NewMachine onDone={list.reload} />} />
    </>
  );
}

function StatusForm({ machines, selected, onDone }: { machines: Equipment[]; selected: Equipment | null; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [st, setSt] = useState('IDLE');
  const [operator, setOperator] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  useEffect(() => {
    if (selected) setCode(selected.code);
  }, [selected]);
  const machine = code;
  const submit = () => run(async () => {
    const r = await api.post<Equipment & { releasedJobs: number }>(`/v1/equipment/${encodeURIComponent(machine)}/status`, {
      status: st, operator: operator || undefined, reason: reason || undefined,
    });
    setReason('');
    onDone();
    return r;
  });
  return (
    <form className="card form-row" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h3>Change status</h3>
      <select required value={machine} onChange={(e) => setCode(e.target.value)} aria-label="Machine">
        <option value="" disabled>Machine…</option>
        {machines.map((m) => <option key={m.code} value={m.code}>{m.code} · {m.kind}</option>)}
      </select>
      <select value={st} onChange={(e) => setSt(e.target.value)} aria-label="New status">
        {Object.entries(STATUS_DOMAINS.equipmentStatus.values).filter(([k]) => k !== 'WORKING').map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      {st === 'IDLE' && <input placeholder="Operator" value={operator} onChange={(e) => setOperator(e.target.value)} />}
      {(st === 'BREAKDOWN' || st === 'MAINTENANCE') && <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />}
      <button className="primary" disabled={busy || !machine}>Apply</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

function NewMachine({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ code: '', kind: 'RTG', pool: '' });
  const { busy, error, run } = useAction();
  if (!open) return <button onClick={() => setOpen(true)}>Add machine</button>;
  return (
    <form className="form-row inline" onSubmit={(e) => { e.preventDefault(); run(async () => {
      await api.post('/v1/equipment', { code: f.code.trim(), kind: f.kind, pool: f.pool || undefined });
      setOpen(false); setF({ code: '', kind: f.kind, pool: f.pool }); onDone();
    }); }}>
      <input required placeholder="Code, e.g. RTG07" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
      <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">
        {Object.entries(EQUIPMENT_KINDS).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}
      </select>
      <input placeholder="Pool (optional)" value={f.pool} onChange={(e) => setF({ ...f, pool: e.target.value })} />
      <button className="primary" disabled={busy}>Save</button>
      <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}
