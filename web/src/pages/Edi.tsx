import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { StatusBadge, StatusLegend } from '../components/Badges';
import { DataGrid, formatDate, GridColumn } from '../grid/DataGrid';
import { category, date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { statusOf } from '../theme/colors';
import { EdiMessage } from '../types';

const columns: GridColumn<EdiMessage>[] = [
  date('createdAt', 'Time', (r) => r.createdAt),
  category('direction', 'Direction', 'direction', (r) => r.direction),
  enumCol('type', 'Message', (r) => r.messageType, ['COPRAR', 'COARRI', 'CODECO', 'VERMAS', 'BAPLIE', 'MOVINS', 'UNKNOWN']),
  text('partner', 'Partner', (r) => r.partner),
  text('ref', 'Interchange ref', (r) => r.interchangeRef),
  status('status', 'Status', 'ediStatus', (r) => r.status),
  text('error', 'Error', (r) => r.error),
  num('bytes', 'Size (bytes)', (r) => r.bytes, { hiddenByDefault: true }),
];

export function EdiMessages() {
  const list = useApi<EdiMessage[]>('/v1/edi/messages');
  const { roles } = useSession();
  const [open, setOpen] = useState<EdiMessage | null>(null);
  const act = useAction();
  const show = (m: EdiMessage) => act.run(() => api.get<EdiMessage>(`/v1/edi/messages/${m.id}`)).then((full) => full && setOpen(full));
  return (
    <>
      <h1>EDI messages</h1>
      {can(roles, 'tos:edi') && <EdiUpload onDone={list.reload} />}
      <DataGrid id="edi" rows={list.data} loading={list.loading} error={list.error} columns={columns} rowKey={(r) => r.id}
        quickFilters={['status', 'type', 'direction']} defaultSort={[{ columnId: 'createdAt', dir: 'desc' }]}
        onRowClick={show} rowAccent={(r) => statusOf('ediStatus', r.status)?.tone.solid} legend={<StatusLegend domain="ediStatus" />} />
      {open && (
        <div className="drawer" role="dialog" aria-label="EDI message">
          <header>
            <strong>{open.messageType}</strong> <StatusBadge domain="ediStatus" value={open.status} />
            <span className="muted">{formatDate(open.createdAt)} · {open.partner ?? 'unknown partner'}</span>
            <span className="spacer" />
            <button onClick={() => setOpen(null)} aria-label="Close">✕</button>
          </header>
          {open.error && <p className="error">{open.error}</p>}
          <pre className="edi-raw">{open.raw?.replace(/'(?!\n)/g, "'\n")}</pre>
        </div>
      )}
    </>
  );
}

function EdiUpload({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<{ status: string; messageType: string; error?: string } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <details className="card">
      <summary>Receive an EDIFACT message (COPRAR, VERMAS)</summary>
      <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="UNB+UNOA:2+…'UNH+1+COPRAR:D:00B:UN:SMDG21'…" aria-label="EDIFACT text" />
      <div className="form-actions">
        <button className="primary" disabled={!text.trim() || busy}
          onClick={() => run(async () => { setAnswer(await api.postEdi('/v1/edi/inbound', text)); onDone(); })}>Process</button>
        {answer && <span><StatusBadge domain="ediStatus" value={answer.status} /> {answer.messageType} {answer.error ?? ''}</span>}
        {error && <span className="error">{error}</span>}
      </div>
    </details>
  );
}
