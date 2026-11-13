import { toCsv } from '@hisaab/core';
import { Download, Plus, ScrollText, Search, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Input, Loading, Money, PageHeader, Segmented } from '../../components/ui';
import { downloadCsv } from '../../lib/download';
import { fmtDate, monthStart, shiftDate, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useApi } from '../../lib/useApi';

type Range = 'today' | '7d' | 'month' | 'all';
const rangeFrom = (r: Range) => (r === 'today' ? today() : r === '7d' ? shiftDate(today(), -6) : r === 'month' ? monthStart() : undefined);

export function InvoiceList({ kind }: { kind: 'sales_all' | 'purchases_all' }) {
  const isSale = kind === 'sales_all';
  const navigate = useNavigate();
  const canDo = useCan();
  const [q, setQ] = useState('');
  const [range, setRange] = useState<Range>('month');
  const [unpaid, setUnpaid] = useState(false);
  const list = useApi('invoices.list', { kind, q, from: rangeFrom(range), status: unpaid ? 'unpaid' : undefined, limit: 500 });
  const rows = list.data ?? [];
  const sign = (k: string) => (k.endsWith('return') ? -1 : 1);
  const live = rows.filter((r) => r.status === 'final');
  const total = live.reduce((s, r) => s + sign(r.kind) * r.total, 0);
  const due = live.reduce((s, r) => s + (r.kind.endsWith('return') ? 0 : r.total - r.paid), 0);
  const base = isSale ? '/sales' : '/purchases';

  const exportCsv = () =>
    downloadCsv(
      toCsv(
        rows.map((r) => ({ date: r.date, number: r.number, type: r.kind, party: r.party_name, gstin: r.party_gstin ?? '', taxable: r.taxable / 100, cgst: r.cgst / 100, sgst: r.sgst / 100, igst: r.igst / 100, total: r.total / 100, paid: r.paid / 100, status: r.status })),
      ),
      `${isSale ? 'sales' : 'purchases'}-${today()}.csv`,
    );

  return (
    <div className="animate-slide-up">
      <PageHeader
        icon={isSale ? <ScrollText className="h-5 w-5" /> : <ShoppingBag className="h-5 w-5" />}
        title={isSale ? 'Sales & returns' : 'Purchases'}
        subtitle={`${live.length} bills · ${isSale ? 'net sales' : 'net purchases'} ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(total / 100)}${due > 0 ? ` · ${new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(due / 100)} unpaid` : ''}`}
        actions={
          <>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export CSV</Button>
            {isSale ? (
              canDo('sale.create') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/pos')} kbd="Alt+N">New bill</Button>
            ) : (
              canDo('purchase.create') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/purchases/new')} kbd="Alt+P">New purchase</Button>
            )}
          </>
        }
      />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Bill no., party, phone…" value={q} onChange={(e) => setQ(e.target.value)} className="w-72" />
          <Segmented size="sm" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: '7d', label: '7 days' }, { value: 'month', label: 'This month' }, { value: 'all', label: 'All' }]} />
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={unpaid} onChange={(e) => setUnpaid(e.target.checked)} className="accent-[rgb(var(--primary))]" /> Unpaid only
          </label>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon={<ScrollText />} title="No bills here" body="Try a different date range or search." />
        ) : (
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            <table className="table-base" data-testid="invoice-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Number</th>
                  <th>{isSale ? 'Customer' : 'Supplier'}</th>
                  <th>Mode</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => navigate(`${base}/${r.id}`)}>
                    <td className="whitespace-nowrap text-muted">{fmtDate(r.date)}</td>
                    <td className="font-mono text-xs">
                      {r.number}
                      {r.supplier_bill_no && <span className="ml-2 text-faint">({r.supplier_bill_no})</span>}
                    </td>
                    <td>
                      {r.party_name}
                      {r.kind.endsWith('return') && <Badge tone="bad" className="ml-2">{isSale ? 'Credit note' : 'Debit note'}</Badge>}
                      {r.status === 'cancelled' && <Badge tone="neutral" className="ml-2">Cancelled</Badge>}
                    </td>
                    <td><Badge tone={r.payment_mode === 'credit' ? 'warn' : 'neutral'}>{r.payment_mode}</Badge></td>
                    <td className={`text-right font-medium ${r.status === 'cancelled' ? 'text-faint line-through' : ''}`}><Money value={sign(r.kind) * r.total} /></td>
                    <td className="text-right">{r.status === 'final' && !r.kind.endsWith('return') && r.total - r.paid > 0 ? <Money value={r.total - r.paid} className="text-bad" /> : <span className="text-faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
