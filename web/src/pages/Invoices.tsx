import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { can } from '../auth';
import { StatusBadge } from '../components/Badges';
import { DataGrid, formatDate, GridColumn } from '../grid/DataGrid';
import { date, enumCol, num, status, text } from '../grid/columns';
import { useAction, useApi } from '../hooks';
import { statusOf, TONES } from '../theme/colors';
import { Charge, Invoice, InvoiceLine, Partner } from '../types';

const money = (v: string | number, cur?: string) => `${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur ? ` ${cur}` : ''}`;

const invoiceColumns: GridColumn<Invoice>[] = [
  text('invoiceNo', 'Invoice', (r) => r.invoiceNo, { render: (r) => <Link to={`/invoices/${r.id}`} onClick={(e) => e.stopPropagation()} className="mono">{r.invoiceNo}</Link> }),
  text('customer', 'Customer', (r) => r.customer),
  text('customerName', 'Customer name', (r) => r.customerName, { hiddenByDefault: true }),
  num('total', 'Total', (r) => r.total, { render: (r) => money(r.total) }),
  text('currency', 'Currency', (r) => r.currency),
  num('lines', 'Lines', (r) => (typeof r.lines === 'number' ? r.lines : r.lines.length)),
  status('status', 'Status', 'invoiceStatus', (r) => r.status),
  status('erp', 'ERP export', 'erpExportStatus', (r) => r.erpExportStatus),
  date('issuedAt', 'Issued', (r) => r.issuedAt),
];

const chargeColumns: GridColumn<Charge>[] = [
  text('customer', 'Customer', (r) => r.customer),
  text('unitRef', 'Unit', (r) => r.unitRef, { render: (r) => <span className="mono">{r.unitRef}</span> }),
  text('chargeCode', 'Charge', (r) => r.chargeCode),
  enumCol('event', 'Triggered by', (r) => r.eventType, ['unit.discharged', 'unit.loaded', 'unit.gated-in', 'unit.gated-out', 'storage']),
  num('quantity', 'Qty', (r) => r.quantity),
  num('rate', 'Rate', (r) => r.rate),
  num('amount', 'Amount', (r) => r.amount, { render: (r) => money(r.amount) }),
  text('currency', 'Currency', (r) => r.currency),
  date('eventAt', 'Event time', (r) => r.eventAt),
];

export function Invoices() {
  const { roles } = useSession();
  const invoices = useApi<Invoice[]>('/v1/invoices');
  const charges = useApi<Charge[]>('/v1/charges?uninvoiced=true');
  const partners = useApi<Partner[]>('/v1/partners');
  const [customer, setCustomer] = useState('');
  const act = useAction();
  const navigate = useNavigate();
  const billing = can(roles, 'tos:billing');
  if (!billing) return <><h1>Invoices</h1><p className="muted">You need the billing role to see invoices.</p></>;
  const issue = () => act.run(async () => {
    const r = await api.post<{ invoices: Invoice[] }>('/v1/invoices', { customer });
    invoices.reload();
    charges.reload();
    if (r.invoices.length === 1) navigate(`/invoices/${r.invoices[0].id}`);
  });
  return (
    <>
      <h1>Invoices</h1>
      <DataGrid id="invoices" rows={invoices.data} loading={invoices.loading} error={invoices.error} columns={invoiceColumns}
        rowKey={(r) => r.id} quickFilters={['status', 'erp']} defaultSort={[{ columnId: 'issuedAt', dir: 'desc' }]}
        onRowClick={(r) => navigate(`/invoices/${r.id}`)} rowAccent={(r) => statusOf('erpExportStatus', r.erpExportStatus)?.tone.solid}
        actions={
          <span className="form-row inline">
            <select value={customer} onChange={(e) => setCustomer(e.target.value)} aria-label="Customer">
              <option value="">Customer…</option>
              {(partners.data ?? []).map((p) => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
            </select>
            <button className="primary" disabled={!customer || act.busy} onClick={issue}>Issue invoice</button>
          </span>
        } />
      {act.error && <p className="error">{act.error}</p>}
      <DataGrid id="charges-open" title="Uninvoiced charges" rows={charges.data} loading={charges.loading} error={charges.error}
        columns={chargeColumns} rowKey={(r) => r.id} quickFilters={['customer', 'chargeCode']} defaultSort={[{ columnId: 'eventAt', dir: 'desc' }]}
        rowAccent={() => TONES.attention.solid} />
    </>
  );
}

export function InvoiceDetail() {
  const { id } = useParams();
  const inv = useApi<Invoice>(`/v1/invoices/${id}`);
  const i = inv.data;
  if (!i) return <p className="muted">{inv.error ?? 'Loading…'}</p>;
  const lines = Array.isArray(i.lines) ? (i.lines as InvoiceLine[]) : [];
  return (
    <>
      <p><Link to="/invoices">← Invoices</Link></p>
      <div className="detail-head">
        <h1 className="mono">{i.invoiceNo}</h1>
        <StatusBadge domain="invoiceStatus" value={i.status} />
        <StatusBadge domain="erpExportStatus" value={i.erpExportStatus} />
      </div>
      <dl className="facts">
        <div><dt>Customer</dt><dd>{i.customer}</dd></div>
        <div><dt>Issued</dt><dd>{formatDate(i.issuedAt)}</dd></div>
        <div><dt>Total</dt><dd><strong>{money(i.total, i.currency)}</strong></dd></div>
      </dl>
      <table className="grid card">
        <thead><tr><th>Unit</th><th>Charge</th><th>Description</th><th>Triggered by</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Rate</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
        <tbody>
          {lines.map((l, k) => (
            <tr key={k}>
              <td className="mono">{l.unitRef}</td><td>{l.chargeCode}</td><td>{l.description}</td><td>{l.eventType}</td>
              <td style={{ textAlign: 'right' }}>{Number(l.quantity)}</td><td style={{ textAlign: 'right' }}>{money(l.rate)}</td>
              <td style={{ textAlign: 'right' }}>{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot><tr><td colSpan={6}><strong>Total</strong></td><td style={{ textAlign: 'right' }}><strong>{money(i.total, i.currency)}</strong></td></tr></tfoot>
      </table>
    </>
  );
}
