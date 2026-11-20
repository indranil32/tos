import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { CategoryChip, StatusBadge, StatusLegend } from '../components/Badges';
import { DataGrid, GridColumn } from '../grid/DataGrid';
import { category, date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { useLive } from '../live';
import { statusOf } from '../theme/colors';
import { Equipment, WorkInstruction, WorkQueue } from '../types';

const POW_KINDS = ['VESSEL', 'YARD', 'RAIL', 'GATE', 'HOUSEKEEPING', 'CFS', 'DEPOT'];
const MOVE_KINDS = ['DISCHARGE', 'LOAD', 'RESTOW', 'YARD_SHIFT', 'HOUSEKEEPING', 'GATE_IN', 'GATE_OUT', 'RAIL_DISCHARGE', 'RAIL_LOAD'];

const queueColumns: GridColumn<WorkQueue>[] = [
  text('code', 'Queue', (r) => r.code, { render: (r) => <Link to={`/work/${encodeURIComponent(r.code)}`} onClick={(e) => e.stopPropagation()}>{r.code}</Link> }),
  text('name', 'Name', (r) => r.name),
  enumCol('powKind', 'Point of work', (r) => r.powKind, POW_KINDS),
  status('status', 'Status', 'queueStatus', (r) => r.status),
  num('priority', 'Priority (1 = first)', (r) => r.priority),
  text('machine', 'Machine / pool', (r) => r.equipment ?? (r.pool ? `pool ${r.pool}` : null)),
  text('visit', 'Visit', (r) => r.visitRef),
  num('planned', 'Planned', (r) => r.planned),
  num('active', 'With machines', (r) => r.active),
  num('completed', 'Done', (r) => r.completed),
  date('created', 'Created', (r) => r.createdAt, { hiddenByDefault: true }),
];

export function WorkQueues() {
  const list = useApi<WorkQueue[]>('/v1/work-queues');
  const navigate = useNavigate();
  const { roles } = useSession();
  const [creating, setCreating] = useState(false);
  useLive(['work'], list.reload);
  return (
    <>
      <h1>Work queues</h1>
      <p className="muted">Each queue is an ordered list of moves for one point of work. Machines take the head of the most urgent queue they serve.</p>
      {creating && <NewQueue onDone={(code) => { setCreating(false); navigate(`/work/${encodeURIComponent(code)}`); }} onCancel={() => setCreating(false)} />}
      <DataGrid id="work-queues" rows={list.data} loading={list.loading} error={list.error} columns={queueColumns} rowKey={(r) => r.id}
        quickFilters={['status', 'powKind']} defaultSort={[{ columnId: 'status', dir: 'asc' }, { columnId: 'priority', dir: 'asc' }]}
        onRowClick={(r) => navigate(`/work/${encodeURIComponent(r.code)}`)}
        rowAccent={(r) => statusOf('queueStatus', r.status)?.tone.solid}
        legend={<StatusLegend domain="queueStatus" />}
        actions={can(roles, 'tos:planner') && <button className="primary" onClick={() => setCreating(true)}>New queue</button>} />
      <MachineConsole />
    </>
  );
}

function NewQueue({ onDone, onCancel }: { onDone: (code: string) => void; onCancel: () => void }) {
  const [f, setF] = useState({ code: '', name: '', powKind: 'HOUSEKEEPING', target: '', priority: '50' });
  const machines = useApi<Equipment[]>('/v1/equipment');
  const pools = useApi<{ code: string; name: string; machines: number }[]>('/v1/equipment-pools');
  const visits = useApi<{ id: string; visitRef: string; phase: string }[]>('/v1/visits');
  const [visitId, setVisitId] = useState('');
  const { busy, error, run } = useAction();
  const submit = () => run(async () => {
    const [kind, code] = f.target.split(':');
    await api.post('/v1/work-queues', {
      code: f.code.trim(), name: f.name.trim(), powKind: f.powKind, priority: Number(f.priority),
      equipment: kind === 'eq' ? code : undefined, pool: kind === 'pool' ? code : undefined,
      visitId: f.powKind === 'VESSEL' ? visitId : undefined,
    });
    onDone(f.code.trim());
  });
  return (
    <form className="card form-row" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h3>New work queue</h3>
      <input required placeholder="Code, e.g. HK-A" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
      <input required placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <select value={f.powKind} onChange={(e) => setF({ ...f, powKind: e.target.value })} aria-label="Point of work">
        {POW_KINDS.map((k) => <option key={k}>{k}</option>)}
      </select>
      {f.powKind === 'VESSEL' && (
        <select required value={visitId} onChange={(e) => setVisitId(e.target.value)} aria-label="Visit">
          <option value="" disabled>Visit…</option>
          {(visits.data ?? []).filter((v) => !['DEPARTED', 'CANCELLED'].includes(v.phase)).map((v) => <option key={v.id} value={v.id}>{v.visitRef}</option>)}
        </select>
      )}
      <select required value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} aria-label="Machine or pool">
        <option value="" disabled>Machine or pool…</option>
        <optgroup label="Pools">{(pools.data ?? []).map((p) => <option key={p.code} value={`pool:${p.code}`}>{p.code} · {p.name} ({p.machines})</option>)}</optgroup>
        <optgroup label="Dedicated machine">{(machines.data ?? []).map((m) => <option key={m.code} value={`eq:${m.code}`}>{m.code} · {m.kind}</option>)}</optgroup>
      </select>
      <label>Priority <input type="number" min={1} max={100} value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })} style={{ width: 70 }} /></label>
      <button className="primary" disabled={busy}>Create</button>
      <button type="button" className="link" onClick={onCancel}>Cancel</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

const instructionColumns: GridColumn<WorkInstruction>[] = [
  num('seq', '#', (r) => r.sequence),
  text('unitRef', 'Unit', (r) => r.unitRef, { render: (r) => <span className="mono">{r.unitRef}</span> }),
  category('cargoKind', 'Cargo', 'cargoKind', (r) => r.cargoKind, { hiddenByDefault: true }),
  enumCol('moveKind', 'Move', (r) => r.moveKind, MOVE_KINDS),
  status('status', 'Status', 'moveStatus', (r) => r.status),
  text('from', 'From', (r) => r.fromPosition, { render: (r) => <span className="mono">{r.fromPosition}</span> }),
  text('target', 'Planned to', (r) => r.plannedPosition, { render: (r) => <span className="mono">{r.plannedPosition}</span> }),
  text('to', 'Put to', (r) => r.toPosition, { render: (r) => <span className="mono">{r.toPosition}</span> }),
  text('equipment', 'Machine', (r) => r.equipment),
  text('visit', 'Visit', (r) => r.visitRef, { hiddenByDefault: true }),
  date('dispatched', 'Dispatched', (r) => r.dispatchedAt, { hiddenByDefault: true }),
  date('completed', 'Completed', (r) => r.completedAt),
];

export function WorkQueueDetail() {
  const { code = '' } = useParams();
  const q = useApi<WorkQueue & { instructions: WorkInstruction[] }>(`/v1/work-queues/${encodeURIComponent(code)}`);
  const { roles } = useSession();
  const { busy, error, run } = useAction();
  useLive(['work', 'unit.'], q.reload);
  const setStatus = (st: string) => run(async () => { await api.post(`/v1/work-queues/${encodeURIComponent(code)}/status`, { status: st }); q.reload(); });
  const planned = (q.data?.instructions ?? []).filter((i) => i.status === 'PLANNED');
  const move = (id: string, delta: number) => run(async () => {
    const ids = planned.map((i) => i.id);
    const at = ids.indexOf(id);
    const to = at + delta;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    await api.put(`/v1/work-queues/${encodeURIComponent(code)}/sequence`, { instructionIds: ids });
    q.reload();
  });
  const d = q.data;
  const planner = can(roles, 'tos:planner');
  const columns = planner
    ? [...instructionColumns, text('order', 'Order', () => null, {
        render: (r: WorkInstruction) => r.status === 'PLANNED' ? (
          <span className="row-actions" onClick={(e) => e.stopPropagation()}>
            <button className="link" title="Earlier" disabled={busy} onClick={() => move(r.id, -1)}>▲</button>
            <button className="link" title="Later" disabled={busy} onClick={() => move(r.id, 1)}>▼</button>
          </span>
        ) : null,
      })]
    : instructionColumns;
  return (
    <>
      <p><Link to="/work">← Work queues</Link></p>
      <h1>{code} {d && <StatusBadge domain="queueStatus" value={d.status} />}</h1>
      {d && (
        <div className="card kv">
          <span><b>{d.name}</b></span>
          <span>Point of work: {d.powKind}</span>
          <span>{d.equipment ? `Machine ${d.equipment}` : `Pool ${d.pool}`}</span>
          {d.visitRef && <span>Visit {d.visitRef}</span>}
          <span>Priority {d.priority}</span>
          <span>{d.planned} planned · {d.active} with machines · {d.completed} done</span>
          {can(roles, 'tos:planner', 'tos:operator') && (
            <span className="spacer-left">
              {d.status !== 'ACTIVE' && d.status !== 'CLOSED' && <button disabled={busy} onClick={() => setStatus('ACTIVE')}>Resume</button>}
              {d.status === 'ACTIVE' && <button disabled={busy} onClick={() => setStatus('SUSPENDED')}>Suspend</button>}
              {d.status !== 'CLOSED' && <button disabled={busy} onClick={() => setStatus('CLOSED')}>Close</button>}
            </span>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {planner && d && d.status !== 'CLOSED' && <AddMoves queue={code} powKind={d.powKind} onDone={q.reload} />}
      <DataGrid id="work-instructions" rows={d?.instructions} loading={q.loading} error={q.error} columns={columns} rowKey={(r) => r.id}
        quickFilters={['status', 'moveKind']}
        rowAccent={(r) => statusOf('moveStatus', r.status)?.tone.solid}
        legend={<StatusLegend domain="moveStatus" />} />
    </>
  );
}

function AddMoves({ queue, powKind, onDone }: { queue: string; powKind: string; onDone: () => void }) {
  const [units, setUnits] = useState('');
  const [target, setTarget] = useState('');
  const unassigned = useApi<WorkInstruction[]>(powKind === 'VESSEL' ? '/v1/work-instructions?status=PLANNED&unassigned=true' : null);
  const { busy, error, run } = useAction();
  if (powKind === 'VESSEL') {
    const rows = unassigned.data ?? [];
    return (
      <div className="card form-row">
        <h3>Add vessel moves</h3>
        <span className="muted">{rows.length} planned move(s) not in a queue yet.</span>
        <button className="primary" disabled={busy || !rows.length} onClick={() => run(async () => {
          await api.post(`/v1/work-queues/${encodeURIComponent(queue)}/instructions`, { instructionIds: rows.map((r) => r.id) });
          unassigned.reload(); onDone();
        })}>Add all to this queue</button>
        {error && <span className="error">{error}</span>}
      </div>
    );
  }
  return (
    <form className="card form-row" onSubmit={(e) => { e.preventDefault(); run(async () => {
      const refs = units.split(/[\s,;]+/).map((u) => u.trim().toUpperCase()).filter(Boolean);
      await api.post(`/v1/work-queues/${encodeURIComponent(queue)}/instructions`, {
        moves: refs.map((unitRef) => ({
          unitRef, moveKind: powKind === 'HOUSEKEEPING' ? 'HOUSEKEEPING' : 'YARD_SHIFT', toPosition: refs.length === 1 && target ? target : undefined,
        })),
      });
      setUnits(''); setTarget(''); onDone();
    }); }}>
      <h3>Plan yard moves</h3>
      <input required placeholder="Unit numbers (space or comma separated)" value={units} onChange={(e) => setUnits(e.target.value)} style={{ minWidth: 320 }} />
      <input placeholder="Target slot (one unit only), e.g. A1-02-01-1" value={target} onChange={(e) => setTarget(e.target.value)} />
      <button className="primary" disabled={busy}>Add</button>
      <span className="muted">No target: the yard allocator picks a free slot when the move is done.</span>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

/**
 * Machine console: what an operator's vehicle or hand-held terminal does (ask for a job, start, complete, reject).
 * Useful for supervisors and for testing a plan before devices are rolled out.
 */
function MachineConsole() {
  const { roles } = useSession();
  const machines = useApi<Equipment[]>('/v1/equipment');
  const [code, setCode] = useState('');
  const [job, setJob] = useState<WorkInstruction | null | undefined>(undefined);
  const [toPosition, setToPosition] = useState('');
  const [stow, setStow] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  useLive(['equipment.', 'work.'], machines.reload);
  if (!can(roles, 'tos:operator')) return null;
  const me = machines.data?.find((m) => m.code === code);
  const call = (path: string, body: Record<string, unknown> = {}) => run(async () => {
    const r = await api.post<WorkInstruction>(path, { equipment: code, version: job?.version, ...body });
    setJob(r.status === 'COMPLETED' || r.status === 'PLANNED' ? null : r);
    setToPosition(''); setStow('');
  });
  return (
    <section className="card console">
      <h2>Machine console</h2>
      <div className="form-row">
        <select value={code} onChange={(e) => { setCode(e.target.value); setJob(undefined); }} aria-label="Machine">
          <option value="">Choose a machine…</option>
          {(machines.data ?? []).map((m) => <option key={m.code} value={m.code}>{m.code} · {m.kind}</option>)}
        </select>
        {me && <StatusBadge domain="equipmentStatus" value={me.status} />}
        {me && ['OFFLINE', 'BREAKDOWN', 'MAINTENANCE'].includes(me.status) && (
          <button disabled={busy} onClick={() => run(async () => { await api.post(`/v1/equipment/${encodeURIComponent(code)}/status`, { status: 'IDLE' }); machines.reload(); })}>Log on</button>
        )}
        {code && <button className="primary" disabled={busy} onClick={() => run(async () => {
          const r = await api.post<{ job: WorkInstruction | null }>('/v1/dispatch/next', { equipment: code });
          setJob(r.job);
        })}>Next job</button>}
      </div>
      {job === null && <p className="muted">No job waiting for {code}.</p>}
      {job && (
        <div className="job">
          <div className="job-head">
            <span className="mono big">{job.unitRef}</span>
            <StatusBadge domain="moveStatus" value={job.status} />
            <CategoryChip domain="cargoKind" value={job.cargoKind} />
            <span>{job.moveKind}{job.queue ? ` · ${job.queue}` : ''}</span>
          </div>
          <div className="job-route mono">{job.fromPosition ?? '?'} → {job.plannedPosition ?? (job.moveKind === 'LOAD' ? 'VESSEL' : 'yard (allocator)')}</div>
          <div className="form-row">
            {job.status === 'DISPATCHED' && <button disabled={busy} onClick={() => call(`/v1/work-instructions/${job.id}/start`)}>Start</button>}
            {job.moveKind === 'LOAD'
              ? <input placeholder="Stow cell, e.g. 0120682" value={stow} onChange={(e) => setStow(e.target.value)} />
              : <input placeholder={`Put to (default ${job.plannedPosition ?? 'allocator'})`} value={toPosition} onChange={(e) => setToPosition(e.target.value)} />}
            <button className="primary" disabled={busy} onClick={() => call(`/v1/work-instructions/${job.id}/complete`, {
              toPosition: toPosition || undefined, stowPosition: stow || undefined,
            })}>Complete</button>
            <input placeholder="Reason to hand back" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={busy || !reason.trim()} onClick={() => { void call(`/v1/work-instructions/${job.id}/reject`, { reason: reason.trim() }); setReason(''); }}>Hand back</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
