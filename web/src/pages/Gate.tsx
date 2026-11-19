import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { StatusBadge, StatusLegend } from '../components/Badges';
import { DataGrid, GridColumn } from '../grid/DataGrid';
import { category, date, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { statusOf } from '../theme/colors';
import { GateTx } from '../types';

const columns: GridColumn<GateTx>[] = [
  date('createdAt', 'Time', (r) => r.createdAt),
  category('direction', 'Direction', 'direction', (r) => r.direction),
  text('unitRef', 'Unit', (r) => r.unitRef, { render: (r) => <span className="mono">{r.unitRef}</span> }),
  category('cargoKind', 'Cargo', 'cargoKind', (r) => r.cargoKind),
  category('category', 'Category', 'category', (r) => r.category),
  text('truck', 'Truck', (r) => r.truckPlate),
  text('haulier', 'Haulier', (r) => r.haulier, { hiddenByDefault: true }),
  status('status', 'Status', 'gateStatus', (r) => r.status),
  text('reason', 'Reject reason', (r) => r.rejectReason),
];

export function Gate() {
  const list = useApi<GateTx[]>('/v1/gate/transactions');
  const { roles } = useSession();
  return (
    <>
      <h1>Gate</h1>
      {can(roles, 'tos:gate') && <GateForm onDone={list.reload} />}
      <DataGrid id="gate" rows={list.data} loading={list.loading} error={list.error} columns={columns} rowKey={(r) => r.id}
        quickFilters={['status', 'direction']} defaultSort={[{ columnId: 'createdAt', dir: 'desc' }]}
        rowAccent={(r) => statusOf('gateStatus', r.status)?.tone.solid} legend={<StatusLegend domain="gateStatus" />} />
    </>
  );
}

function GateForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ direction: 'OUT', unitRef: '', truckPlate: '', vgmKg: '' });
  const [last, setLast] = useState<GateTx | null>(null);
  const { busy, error, run } = useAction();
  const submit = () => run(async () => {
    const r = await api.post<GateTx & { position?: string }>('/v1/gate/transactions', {
      direction: f.direction, unitRef: f.unitRef.trim().toUpperCase(), truckPlate: f.truckPlate || undefined,
      vgm: f.direction === 'IN' && f.vgmKg ? { vgmKg: Number(f.vgmKg) } : undefined,
    });
    setLast(r);
    setF({ ...f, unitRef: '', truckPlate: '', vgmKg: '' });
    onDone();
  });
  return (
    <form className="card form-row" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <h3>Process a truck</h3>
      <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} aria-label="Direction">
        <option value="IN">Gate in</option><option value="OUT">Gate out</option>
      </select>
      <input required placeholder="Unit (container no. / VIN / lot)" value={f.unitRef} onChange={(e) => setF({ ...f, unitRef: e.target.value })} />
      <input placeholder="Truck plate" value={f.truckPlate} onChange={(e) => setF({ ...f, truckPlate: e.target.value })} />
      {f.direction === 'IN' && <input type="number" placeholder="VGM kg (exports)" value={f.vgmKg} onChange={(e) => setF({ ...f, vgmKg: e.target.value })} />}
      <button className="primary" disabled={busy}>Submit</button>
      {last && (
        <span className="result">
          <StatusBadge domain="gateStatus" value={last.status} /> {last.unitRef}{last.rejectReason ? ` · ${last.rejectReason}` : ''}
        </span>
      )}
      {error && <span className="error">{error}</span>}
    </form>
  );
}
