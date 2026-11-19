import { DataGrid, GridColumn } from '../grid/DataGrid';
import { date, enumCol, num, text } from '../grid/columns';
import { useApi } from '../hooks';
import { DomainEventRow } from '../types';

const TYPES = ['vessel-call.updated', 'vessel.arrived', 'vessel.departed', 'loadlist.updated', 'unit.discharged', 'unit.loaded',
  'unit.gated-in', 'unit.gated-out', 'unit.vgm-set', 'hold.applied', 'hold.released', 'invoice.issued'];

const summary = (p: Record<string, unknown>) =>
  Object.entries(p).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(' · ');

const columns: GridColumn<DomainEventRow>[] = [
  num('id', '#', (r) => r.id),
  date('at', 'Time', (r) => r.occurred_at),
  enumCol('type', 'Event', (r) => r.type, TYPES),
  enumCol('aggregate', 'About', (r) => r.aggregate_type, ['unit', 'vessel_visit', 'invoice']),
  text('payload', 'Details', (r) => summary(r.payload)),
  text('actor', 'By', (r) => r.actor),
  text('facility', 'Terminal', (r) => r.facility, { hiddenByDefault: true }),
];

export function Events() {
  const { data, loading, error } = useApi<{ events: DomainEventRow[] }>('/v1/events');
  return (
    <>
      <h1>Events</h1>
      <p className="muted">Every change in the terminal, in order. API and webhook consumers read the same feed.</p>
      <DataGrid id="events" rows={data?.events} loading={loading} error={error} columns={columns} rowKey={(r) => String(r.id)}
        quickFilters={['type']} defaultSort={[{ columnId: 'id', dir: 'desc' }]} />
    </>
  );
}
