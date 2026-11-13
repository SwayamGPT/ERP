import { toCsv, type Permission } from '@hisaab/core';
import { BarChart3, Download } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Input, Loading, Segmented, Tabs } from '../../components/ui';
import { downloadCsv } from '../../lib/download';
import { fmtDate, fmtQty, inr, monthStart, shiftDate, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useApi } from '../../lib/useApi';

type Tab = 'pnl' | 'sales' | 'purchases' | 'profit' | 'bills' | 'stock' | 'expiry' | 'daybook' | 'cashbook' | 'outstanding';
const TABS: Array<{ value: Tab; label: string; perm: Permission }> = [
  { value: 'pnl', label: 'Profit & loss', perm: 'report.profit' },
  { value: 'sales', label: 'Sales register', perm: 'report.view' },
  { value: 'purchases', label: 'Purchase register', perm: 'purchase.view' },
  { value: 'profit', label: 'Item profit', perm: 'report.profit' },
  { value: 'bills', label: 'Bill profit', perm: 'report.profit' },
  { value: 'stock', label: 'Stock summary', perm: 'item.view' },
  { value: 'expiry', label: 'Expiry', perm: 'item.view' },
  { value: 'daybook', label: 'Day book', perm: 'report.view' },
  { value: 'cashbook', label: 'Cash & bank book', perm: 'report.view' },
  { value: 'outstanding', label: 'Outstanding', perm: 'party.view' },
];

interface Col<T> {
  key: string;
  label: string;
  money?: boolean;
  right?: boolean;
  render?: (r: T) => ReactNode;
  csv?: (r: T) => unknown;
}

export function ReportsPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => canDo(t.perm));
  const tab = (params.get('tab') as Tab) ?? tabs[0]?.value;
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [day, setDay] = useState(today());
  const [acct, setAcct] = useState<'CASH' | 'BANK'>('CASH');
  const [outKind, setOutKind] = useState<'customer' | 'supplier'>('customer');

  return (
    <div className="animate-slide-up">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary"><BarChart3 className="h-5 w-5" /></div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Reports</h1>
            <p className="text-sm text-muted">Every report exports to CSV for Excel or your CA.</p>
          </div>
        </div>
        {['pnl', 'sales', 'purchases', 'profit', 'bills', 'cashbook'].includes(tab) && (
          <div className="flex items-center gap-2">
            <Segmented size="sm" value="" onChange={(v) => { if (v === 'today') (setFrom(today()), setTo(today())); if (v === 'month') (setFrom(monthStart()), setTo(today())); if (v === '30') (setFrom(shiftDate(today(), -29)), setTo(today())); }} options={[{ value: 'today', label: 'Today' }, { value: 'month', label: 'This month' }, { value: '30', label: '30 days' }]} />
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
            <span className="text-muted">to</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </div>
        )}
        {tab === 'daybook' && <Input type="date" value={day} onChange={(e) => setDay(e.target.value)} className="w-44" />}
      </div>
      <div className="mb-4"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} /></div>
      {tab === 'pnl' && <ProfitLoss from={from} to={to} />}
      {tab === 'sales' && <Register kind="sale" from={from} to={to} />}
      {tab === 'purchases' && <Register kind="purchase" from={from} to={to} />}
      {tab === 'profit' && <ItemProfit from={from} to={to} />}
      {tab === 'bills' && <BillProfit from={from} to={to} />}
      {tab === 'stock' && <StockSummary />}
      {tab === 'expiry' && <Expiry />}
      {tab === 'daybook' && <DayBook date={day} />}
      {tab === 'cashbook' && <CashBook from={from} to={to} acct={acct} setAcct={setAcct} />}
      {tab === 'outstanding' && <Outstanding kind={outKind} setKind={setOutKind} />}
    </div>
  );
}

function ReportTable<T extends Record<string, unknown>>({ rows, cols, name, totals, onRow, loading, extra }: { rows: T[] | undefined; cols: Col<T>[]; name: string; totals?: string[]; onRow?: (r: T) => void; loading?: boolean; extra?: ReactNode }) {
  const sums = useMemo(() => Object.fromEntries((totals ?? []).map((k) => [k, (rows ?? []).reduce((s, r) => s + Number(r[k] ?? 0), 0)])), [rows, totals]);
  if (loading || !rows) return <Loading />;
  const exportCsv = () => downloadCsv(toCsv(rows.map((r) => Object.fromEntries(cols.map((c) => [c.label, c.csv ? c.csv(r) : c.money ? Number(r[c.key] ?? 0) / 100 : r[c.key]])))), `${name}-${today()}.csv`);
  return (
    <Card padded={false} title={<span className="text-muted">{rows.length} rows</span>} action={<div className="flex items-center gap-2">{extra}<Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} disabled={!rows.length}>CSV</Button></div>}>
      {!rows.length ? (
        <EmptyState icon={<BarChart3 />} title="Nothing in this period" />
      ) : (
        <div className="max-h-[calc(100vh-300px)] overflow-auto">
          <table className="table-base" data-testid={`report-${name}`}>
            <thead><tr>{cols.map((c) => <th key={c.key} className={c.money || c.right ? 'text-right' : ''}>{c.label}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={onRow ? 'cursor-pointer' : ''} onClick={() => onRow?.(r)}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.money || c.right ? 'text-right tnum' : ''}>{c.render ? c.render(r) : c.money ? inr(Number(r[c.key] ?? 0)) : String(r[c.key] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="bg-surface-2 font-semibold">
                  {cols.map((c, i) => <td key={c.key} className={c.money || c.right ? 'text-right tnum' : ''}>{i === 0 ? 'Total' : c.key in sums ? (c.money ? inr(sums[c.key]) : fmtQty(sums[c.key])) : ''}</td>)}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </Card>
  );
}

type R = Record<string, unknown>;
const date = (k = 'date'): Col<R> => ({ key: k, label: 'Date', render: (r) => fmtDate(r[k] as string), csv: (r) => r[k] });

function Register({ kind, from, to }: { kind: 'sale' | 'purchase'; from: string; to: string }) {
  const nav = useNavigate();
  const q = useApi('reports.register', { kind, from, to });
  return (
    <ReportTable
      name={`${kind}-register`}
      rows={q.data as R[] | undefined}
      onRow={(r) => nav(`/${kind === 'sale' ? 'sales' : 'purchases'}/${r.id}`)}
      totals={['taxable', 'cgst', 'sgst', 'igst', 'total']}
      cols={[
        date(),
        { key: 'number', label: 'Number', render: (r) => <span className="font-mono text-xs">{String(r.number)}{String(r.kind).endsWith('return') && <Badge tone="bad" className="ml-1.5">return</Badge>}</span>, csv: (r) => r.number },
        { key: 'party_name', label: 'Party' },
        { key: 'party_gstin', label: 'GSTIN', render: (r) => <span className="font-mono text-xs">{String(r.party_gstin ?? '—')}</span>, csv: (r) => r.party_gstin ?? '' },
        { key: 'taxable', label: 'Taxable', money: true },
        { key: 'cgst', label: 'CGST', money: true },
        { key: 'sgst', label: 'SGST', money: true },
        { key: 'igst', label: 'IGST', money: true },
        { key: 'total', label: 'Total', money: true },
      ]}
    />
  );
}

function ItemProfit({ from, to }: { from: string; to: string }) {
  const q = useApi('reports.itemProfit', { from, to });
  return (
    <ReportTable
      name="item-profit"
      rows={q.data as R[] | undefined}
      totals={['sales', 'cost', 'profit']}
      cols={[
        { key: 'name', label: 'Item' },
        { key: 'qty', label: 'Qty sold', right: true, render: (r) => fmtQty(Number(r.qty)) },
        { key: 'sales', label: 'Sales (excl. GST)', money: true },
        { key: 'cost', label: 'Cost (FIFO)', money: true },
        { key: 'profit', label: 'Profit', money: true, render: (r) => <span className={Number(r.profit) < 0 ? 'text-bad' : 'text-good'}>{inr(Number(r.profit))}</span> },
        { key: 'margin', label: 'Margin', right: true, render: (r) => `${r.margin ?? 0}%` },
      ]}
    />
  );
}

function BillProfit({ from, to }: { from: string; to: string }) {
  const nav = useNavigate();
  const q = useApi('reports.billProfit', { from, to });
  return (
    <ReportTable
      name="bill-profit"
      rows={q.data as R[] | undefined}
      onRow={(r) => nav(`/sales/${r.id}`)}
      totals={['taxable', 'cost', 'profit']}
      cols={[date(), { key: 'number', label: 'Bill' }, { key: 'party_name', label: 'Customer' }, { key: 'taxable', label: 'Sales (excl. GST)', money: true }, { key: 'cost', label: 'Cost', money: true }, { key: 'profit', label: 'Profit', money: true }, { key: 'margin', label: 'Margin', right: true, render: (r) => `${r.margin ?? 0}%` }]}
    />
  );
}

function StockSummary() {
  const canDo = useCan();
  const q = useApi('reports.stock');
  const cols: Col<R>[] = [
    { key: 'name', label: 'Item' },
    { key: 'category', label: 'Category' },
    { key: 'stock', label: 'Stock', right: true, render: (r) => <span className={Number(r.stock) <= 0 ? 'text-bad' : Number(r.reorder_level) > 0 && Number(r.stock) <= Number(r.reorder_level) ? 'text-warn' : ''}>{fmtQty(Number(r.stock))} {String(r.base_unit)}</span>, csv: (r) => r.stock },
    ...(canDo('cost.view') ? [{ key: 'cost', label: 'Value at cost', money: true } as Col<R>] : []),
    { key: 'value_retail', label: 'Value at selling price', money: true },
  ];
  return <ReportTable name="stock" rows={q.data as R[] | undefined} cols={cols} totals={canDo('cost.view') ? ['cost', 'value_retail'] : ['value_retail']} />;
}

function Expiry() {
  const q = useApi('reports.expiry', { days: 90 });
  const tone = { expired: 'bad', d30: 'warn', d90: 'saffron', ok: 'good', none: 'neutral' } as const;
  const label = { expired: 'Expired', d30: '≤ 30 days', d90: '≤ 90 days', ok: 'OK', none: '' };
  return (
    <ReportTable
      name="expiry"
      rows={q.data as R[] | undefined}
      cols={[
        { key: 'name', label: 'Item' },
        { key: 'batch_no', label: 'Batch' },
        { key: 'expiry', label: 'Expiry', render: (r) => fmtDate(r.expiry as string), csv: (r) => r.expiry },
        { key: 'bucket', label: 'Status', render: (r) => <Badge tone={tone[r.bucket as keyof typeof tone]}>{label[r.bucket as keyof typeof label]}</Badge>, csv: (r) => r.bucket },
        { key: 'qty', label: 'Qty', right: true, render: (r) => `${fmtQty(Number(r.qty))} ${r.base_unit}` },
        { key: 'mrp', label: 'MRP', money: true },
      ]}
    />
  );
}

const VT: Record<string, string> = { sale: 'Sale', purchase: 'Purchase', sale_return: 'Sales return', purchase_return: 'Purchase return', payment: 'Payment', expense: 'Expense', income: 'Income', opening: 'Opening' };
function DayBook({ date: d }: { date: string }) {
  const q = useApi('reports.daybook', { date: d });
  return (
    <ReportTable
      name="daybook"
      rows={q.data as R[] | undefined}
      totals={['debit', 'credit']}
      cols={[
        { key: 'voucher_type', label: 'Voucher', render: (r) => VT[r.voucher_type as string] ?? String(r.voucher_type).replace(/_/g, ' '), csv: (r) => r.voucher_type },
        { key: 'number', label: 'Ref', render: (r) => <span className="font-mono text-xs">{String(r.number ?? '')}</span>, csv: (r) => r.number ?? '' },
        { key: 'account', label: 'Account' },
        { key: 'party_name', label: 'Party' },
        { key: 'debit', label: 'Debit', money: true },
        { key: 'credit', label: 'Credit', money: true },
      ]}
    />
  );
}

function CashBook({ from, to, acct, setAcct }: { from: string; to: string; acct: 'CASH' | 'BANK'; setAcct: (a: 'CASH' | 'BANK') => void }) {
  const q = useApi('reports.cashbook', { from, to, account: acct });
  return (
    <div className="space-y-3">
      {q.data && (
        <div className="flex gap-6 text-sm">
          <span className="text-muted">Opening <b className="text-ink tnum">{inr(q.data.opening)}</b></span>
          <span className="text-muted">Closing <b className="text-ink tnum">{inr(q.data.closing)}</b></span>
        </div>
      )}
      <ReportTable
        name={`${acct.toLowerCase()}book`}
        rows={q.data?.rows as R[] | undefined}
        totals={['debit', 'credit']}
        extra={<Segmented size="sm" value={acct} onChange={setAcct} options={[{ value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank / UPI' }]} />}
        cols={[
          date(),
          { key: 'voucher_type', label: 'Entry', render: (r) => VT[r.voucher_type as string] ?? String(r.voucher_type).replace(/_/g, ' '), csv: (r) => r.voucher_type },
          { key: 'narration', label: 'Details', render: (r) => <span>{String(r.party_name ?? '')}{r.party_name && r.narration ? ' · ' : ''}<span className="text-muted">{String(r.narration ?? '')}</span></span>, csv: (r) => `${r.party_name ?? ''} ${r.narration ?? ''}` },
          { key: 'debit', label: 'In', money: true },
          { key: 'credit', label: 'Out', money: true },
          { key: 'balance', label: 'Balance', money: true },
        ]}
      />
    </div>
  );
}

function Outstanding({ kind, setKind }: { kind: 'customer' | 'supplier'; setKind: (k: 'customer' | 'supplier') => void }) {
  const nav = useNavigate();
  const q = useApi('reports.outstanding', { kind });
  return (
    <ReportTable
      name={`outstanding-${kind}`}
      rows={q.data as R[] | undefined}
      onRow={(r) => nav(`/parties/${r.id}`)}
      totals={['balance']}
      extra={<Segmented size="sm" value={kind} onChange={setKind} options={[{ value: 'customer', label: 'To collect' }, { value: 'supplier', label: 'To pay' }]} />}
      cols={[
        { key: 'name', label: 'Party' },
        { key: 'phone', label: 'Mobile' },
        { key: 'days', label: 'Oldest unpaid', right: true, render: (r) => (Number(r.days) ? <Badge tone={Number(r.days) > 30 ? 'bad' : Number(r.days) > 15 ? 'warn' : 'neutral'}>{String(r.days)} days</Badge> : '—'), csv: (r) => r.days },
        { key: 'credit_limit', label: 'Limit', money: true },
        { key: 'balance', label: 'Balance', money: true },
      ]}
    />
  );
}

function ProfitLoss({ from, to }: { from: string; to: string }) {
  const q = useApi('reports.pnl', { from, to });
  const d = q.data;
  if (!d) return <Loading />;
  const Line = ({ k, v, strong, indent, tone }: { k: ReactNode; v: number; strong?: boolean; indent?: boolean; tone?: 'good' | 'bad' }) => (
    <div className={`flex justify-between py-1.5 ${strong ? 'border-t border-border pt-2.5 text-base font-semibold' : ''} ${indent ? 'pl-5 text-sm text-muted' : ''}`}>
      <span>{k}</span>
      <span className={`tnum ${tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : ''}`}>{v < 0 ? '−' : ''}{inr(Math.abs(v))}</span>
    </div>
  );
  const exportCsv = () =>
    downloadCsv(
      toCsv([
        { line: 'Sales (excl. GST)', amount: d.sales / 100 },
        { line: 'Cost of goods sold', amount: -d.cogs / 100 },
        { line: 'Gross profit', amount: d.grossProfit / 100 },
        ...d.expenses.map((e) => ({ line: `Expense: ${e.category}`, amount: -e.amount / 100 })),
        { line: 'Other income', amount: d.otherIncome / 100 },
        { line: 'Cash short / excess', amount: d.cashDiff / 100 },
        { line: 'Net profit', amount: d.netProfit / 100 },
      ]),
      `profit-loss-${from}-to-${to}.csv`,
    );
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,640px)_1fr]">
      <Card title="Profit & loss" action={<Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>CSV</Button>}>
        <div data-testid="pnl">
          <Line k="Sales (before GST, after returns)" v={d.sales} />
          <Line k="Cost of the goods sold (FIFO)" v={-d.cogs} />
          <Line k={<span>Gross profit <span className="text-xs font-normal text-muted">({d.grossMargin}% margin)</span></span>} v={d.grossProfit} strong />
          <div className="mt-3 text-xs font-semibold uppercase tracking-wider text-faint">Expenses</div>
          {d.expenses.length ? d.expenses.map((e) => <Line key={e.category} k={e.category} v={-e.amount} indent />) : <p className="py-1 text-sm text-muted">No expenses recorded.</p>}
          <Line k="Total expenses" v={-d.totalExpenses} />
          {d.otherIncome !== 0 && <Line k="Other income" v={d.otherIncome} />}
          {d.cashDiff !== 0 && <Line k="Cash short / excess" v={d.cashDiff} />}
          <div className={`mt-2 flex justify-between rounded-xl px-4 py-3 text-lg font-semibold ${d.netProfit >= 0 ? 'bg-good-soft text-good' : 'bg-bad-soft text-bad'}`}>
            <span>{d.netProfit >= 0 ? 'Net profit' : 'Net loss'}</span>
            <span className="tnum">{inr(Math.abs(d.netProfit))}</span>
          </div>
        </div>
      </Card>
      <div className="space-y-3 text-sm text-muted">
        <Card><p>This is your <b className="text-ink">earning</b> for the period: what you sold minus what those goods cost you and what it took to run the shop. Unpaid bills count when they're incurred, not when paid.</p></Card>
        <Card><p>Money the owner takes home is <b className="text-ink">not</b> an expense and isn't shown here. To see actual money movement, open <a className="text-primary hover:underline" href="#/money?tab=flow">Cash flow</a>.</p></Card>
      </div>
    </div>
  );
}
