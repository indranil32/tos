import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { CategoryChip, CategoryLegend, StatusBadge, StatusLegend, UnitFlags } from '../components/Badges';
import { DataGrid, formatDate, GridColumn } from '../grid/DataGrid';
import { bool, category, date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { statusOf, TONES } from '../theme/colors';
import { Unit } from '../types';

export const dwellDays = (u: Pick<Unit, 'timeIn' | 'timeOut'>) =>
  u.timeIn ? Math.max(0, Math.floor(((u.timeOut ? Date.parse(u.timeOut) : Date.now()) - Date.parse(u.timeIn)) / 86_400_000)) : null;

/** Row accent: holds win (blocked), otherwise the unit state tone. Same rule on every unit list. */
export const unitAccent = (u: Unit) => (u.activeHolds ? TONES.blocked.solid : statusOf('unitState', u.state)?.tone.solid);

const columns: GridColumn<Unit>[] = [
  text('unitRef', 'Unit', (r) => r.unitRef, { render: (r) => <Link to={`/units/${r.id}`} onClick={(e) => e.stopPropagation()} className="mono">{r.unitRef}</Link> }),
  category('cargoKind', 'Cargo', 'cargoKind', (r) => r.cargoKind),
  text('isoType', 'ISO type', (r) => r.isoType),
  category('category', 'Category', 'category', (r) => r.category),
  enumCol('freightKind', 'Freight', (r) => r.freightKind, ['FCL', 'LCL', 'MTY', 'NA']),
  status('state', 'State', 'unitState', (r) => r.state),
  text('flags', 'Flags', (r) => [r.activeHolds ? `hold ${r.holdTypes}` : '', r.dgClass ? `dg ${r.dgClass}` : '', r.isReefer ? 'reefer' : ''].filter(Boolean).join(' '),
    { render: (r) => <UnitFlags unit={r} /> }),
  num('activeHolds', 'Active holds', (r) => r.activeHolds, { hiddenByDefault: true }),
  bool('reefer', 'Reefer', (r) => r.isReefer, { hiddenByDefault: true }),
  text('dgClass', 'IMDG class', (r) => r.dgClass, { hiddenByDefault: true }),
  text('position', 'Yard position', (r) => r.yardPosition, { render: (r) => <span className="mono">{r.yardPosition ?? '–'}</span> }),
  text('line', 'Line', (r) => r.lineOperator),
  text('visitIn', 'Visit in', (r) => r.visitIn),
  text('visitOut', 'Visit out', (r) => r.visitOut),
  text('pol', 'POL', (r) => r.pol, { hiddenByDefault: true }),
  text('pod', 'POD', (r) => r.pod),
  num('weight', 'Gross (kg)', (r) => r.grossWeightKg),
  num('vgm', 'VGM (kg)', (r) => r.vgmKg, { hiddenByDefault: true }),
  num('quantity', 'Quantity', (r) => r.quantity, { hiddenByDefault: true }),
  date('timeIn', 'Time in', (r) => r.timeIn),
  date('timeOut', 'Time out', (r) => r.timeOut, { hiddenByDefault: true }),
  num('dwell', 'Dwell (days)', (r) => dwellDays(r)),
  text('stow', 'Stow cell', (r) => r.stowPosition, { hiddenByDefault: true }),
];

export function Units() {
  const { data, loading, error } = useApi<Unit[]>('/v1/units');
  const navigate = useNavigate();
  return (
    <>
      <h1>Units</h1>
      <DataGrid id="units" rows={data} loading={loading} error={error} columns={columns} rowKey={(r) => r.id}
        quickFilters={['state', 'category', 'cargoKind']} defaultSort={[{ columnId: 'state', dir: 'asc' }, { columnId: 'timeIn', dir: 'desc' }]}
        onRowClick={(r) => navigate(`/units/${r.id}`)} rowAccent={unitAccent}
        legend={<><StatusLegend domain="unitState" /><CategoryLegend domain="category" /></>} />
    </>
  );
}

export function UnitDetail() {
  const { id } = useParams();
  const { roles } = useSession();
  const unit = useApi<Unit>(`/v1/units/${id}`);
  const act = useAction();
  const [holdType, setHoldType] = useState('CUSTOMS');
  const [reference, setReference] = useState('');
  const [vgm, setVgm] = useState({ vgmKg: '', method: 'SM1', verifiedBy: '' });
  const u = unit.data;
  if (!u) return <p className="muted">{unit.error ?? 'Loading…'}</p>;
  const canHold = can(roles, 'tos:operator', 'tos:planner', 'tos:edi');
  return (
    <>
      <p><Link to="/units">← Units</Link></p>
      <div className="detail-head">
        <h1 className="mono">{u.unitRef}</h1>
        <StatusBadge domain="unitState" value={u.state} />
        <CategoryChip domain="cargoKind" value={u.cargoKind} />
        <CategoryChip domain="category" value={u.category} />
        <UnitFlags unit={u} />
      </div>
      <dl className="facts">
        <div><dt>ISO type</dt><dd>{u.isoType ?? '–'}</dd></div>
        <div><dt>Freight</dt><dd>{u.freightKind}</dd></div>
        <div><dt>Line</dt><dd>{u.lineOperator ?? '–'}</dd></div>
        <div><dt>Yard position</dt><dd className="mono">{u.yardPosition ?? '–'}</dd></div>
        <div><dt>Stow cell</dt><dd className="mono">{u.stowPosition ?? '–'}</dd></div>
        <div><dt>Visit in / out</dt><dd>{u.visitIn ?? '–'} / {u.visitOut ?? '–'}</dd></div>
        <div><dt>POL / POD</dt><dd>{u.pol ?? '–'} / {u.pod ?? '–'}</dd></div>
        <div><dt>Gross / VGM</dt><dd>{u.grossWeightKg ?? '–'} / {u.vgmKg ? `${u.vgmKg} kg (${u.vgmMethod ?? '?'})` : '–'}</dd></div>
        <div><dt>Quantity</dt><dd>{u.quantity} {u.quantityUom}</dd></div>
        <div><dt>Time in / out</dt><dd>{formatDate(u.timeIn)} / {formatDate(u.timeOut)}</dd></div>
        <div><dt>Dwell</dt><dd>{dwellDays(u) ?? '–'} days</dd></div>
      </dl>

      <section className="card">
        <h3>Holds</h3>
        <table className="grid small">
          <thead><tr><th>Type</th><th>Reference</th><th>State</th><th>Applied</th><th>Released</th><th /></tr></thead>
          <tbody>
            {(u.holds ?? []).map((h) => (
              <tr key={h.id}>
                <td>{h.holdType}</td>
                <td>{h.reference ?? '–'}</td>
                <td><StatusBadge domain="holdState" value={h.releasedAt ? 'RELEASED' : 'ACTIVE'} /></td>
                <td>{formatDate(h.appliedAt)} · {h.appliedBy}</td>
                <td>{h.releasedAt ? `${formatDate(h.releasedAt)} · ${h.releasedBy}` : '–'}</td>
                <td>{!h.releasedAt && canHold && (
                  <button disabled={act.busy} onClick={() => act.run(() => api.post(`/v1/units/${id}/holds/${h.id}/release`)).then(unit.reload)}>Release</button>
                )}</td>
              </tr>
            ))}
            {!u.holds?.length && <tr><td colSpan={6} className="muted">No holds.</td></tr>}
          </tbody>
        </table>
        {canHold && u.state !== 'DEPARTED' && (
          <div className="form-row">
            <select value={holdType} onChange={(e) => setHoldType(e.target.value)} aria-label="Hold type">
              {['CUSTOMS', 'LINE', 'TERMINAL', 'DG', 'INSPECTION'].map((t) => <option key={t}>{t}</option>)}
            </select>
            <input placeholder="Reference (e.g. declaration no.)" value={reference} onChange={(e) => setReference(e.target.value)} />
            <button disabled={act.busy} onClick={() => act.run(() => api.post(`/v1/units/${id}/holds`, { holdType, reference: reference || undefined })).then(() => { setReference(''); unit.reload(); })}>Apply hold</button>
          </div>
        )}
      </section>

      {u.cargoKind === 'CONTAINER' && !['LOADED', 'DEPARTED'].includes(u.state) && can(roles, 'tos:operator', 'tos:gate', 'tos:edi', 'tos:planner') && (
        <section className="card">
          <h3>Verified gross mass (SOLAS)</h3>
          <div className="form-row">
            <input type="number" placeholder="VGM kg" value={vgm.vgmKg} onChange={(e) => setVgm({ ...vgm, vgmKg: e.target.value })} />
            <select value={vgm.method} onChange={(e) => setVgm({ ...vgm, method: e.target.value })} aria-label="Method"><option>SM1</option><option>SM2</option></select>
            <input placeholder="Verified by" value={vgm.verifiedBy} onChange={(e) => setVgm({ ...vgm, verifiedBy: e.target.value })} />
            <button disabled={!vgm.vgmKg || act.busy} onClick={() => act.run(() => api.put(`/v1/units/${id}/vgm`, { vgmKg: Number(vgm.vgmKg), method: vgm.method, verifiedBy: vgm.verifiedBy || undefined })).then(unit.reload)}>Record VGM</button>
          </div>
        </section>
      )}
      {act.error && <p className="error">{act.error}</p>}
    </>
  );
}
