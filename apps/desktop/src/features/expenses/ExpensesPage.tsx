import { toCsv } from '@hisaab/core';
import { AlertTriangle, Ban, CalendarClock, Download, Pencil, Plus, Repeat, Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Approvals, Attachments, PettyCash } from './Extras';
import { Badge, Button, Card, ConfirmDialog, Dialog, Drawer, EmptyState, Field, Input, Loading, MoneyInput, PageHeader, Segmented, Select, Stat, Switch, Tabs, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { PayMode } from '../../db/types';
import type { Recurring } from '../../db/repos/expenses';
import { dueDates } from '../../db/schedule';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { fmtDate, fmtDay, inr, monthStart, relative, thisMonth, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';
import { ExpenseDialog, PayExpenseDialog } from './ExpenseDialog';

type Tab = 'overview' | 'all' | 'due' | 'approvals' | 'petty' | 'recurring' | 'categories';

export function ExpensesPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'overview';
  const openId = params.get('id') ? Number(params.get('id')) : null;
  const adding = params.get('new') === '1';
  const approvals = useApi('expenses.approvals').data ?? [];
  const appStatus = useApi('app.status').data;
  const setP = (patch: Record<string, string | null>) =>
    setParams((p) => {
      for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v);
      return p;
    });
  const ov = useApi('expenses.overview', {});

  return (
    <div className="animate-slide-up">
      <PageHeader
        icon={<Wallet className="h-5 w-5" />}
        title="Expenses"
        subtitle="Rent, bills, salaries and every other rupee the shop spends — linked to your cash and bank."
        actions={
          canDo('expense.create') && (
            <>
              <Button variant="outline" icon={<Repeat className="h-4 w-4" />} onClick={() => setP({ tab: 'recurring', newRecurring: '1' })}>Repeat monthly…</Button>
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setP({ new: '1' })} data-testid="expense-new">Add expense</Button>
            </>
          )
        }
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={(t) => setP({ tab: t })}
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'due', label: 'Bills to pay', count: ov.data?.due.length },
            ...(approvals.length ? [{ value: 'approvals' as const, label: 'Needs approval', count: approvals.length }] : []),
            ...(appStatus?.company?.petty_cash_float ? [{ value: 'petty' as const, label: 'Petty cash' }] : []),
            { value: 'all', label: 'All expenses' },
            { value: 'recurring', label: 'Recurring' },
            { value: 'categories', label: 'Categories & budgets' },
          ]}
        />
      </div>
      {tab === 'overview' && <Overview onOpen={(id) => setP({ id: String(id) })} onTab={(t) => setP({ tab: t })} />}
      {tab === 'due' && <ExpenseList status="due" onOpen={(id) => setP({ id: String(id) })} />}
      {tab === 'approvals' && <Approvals onOpen={(id) => setP({ id: String(id) })} />}
      {tab === 'petty' && <PettyCash onOpen={(id) => setP({ id: String(id) })} />}
      {tab === 'all' && <ExpenseList status="all" onOpen={(id) => setP({ id: String(id) })} />}
      {tab === 'recurring' && <RecurringTab startNew={params.get('newRecurring') === '1'} onDone={() => setP({ newRecurring: null })} />}
      {tab === 'categories' && <Categories />}
      {adding && <ExpenseDialog onClose={() => setP({ new: null })} />}
      {openId && <ExpenseDrawer id={openId} onClose={() => setP({ id: null })} />}
    </div>
  );
}

/* ───────── overview ───────── */

function Overview({ onOpen, onTab }: { onOpen: (id: number) => void; onTab: (t: Tab) => void }) {
  const ov = useApi('expenses.overview', {});
  const cats = useApi('expenses.categories', {});
  const rec = useApi('expenses.recurring');
  const canDo = useCan();
  const [pay, setPay] = useState<null | { id: number; category: string; payee: string | null; amount: number; paid: number; employee_id: number | null }>(null);
  const [payRec, setPayRec] = useState<Recurring | null>(null);
  if (!ov.data) return <Loading />;
  const o = ov.data;
  // Days of one repeating bill (daily rent) show as one line: "4 days due".
  type Due = (typeof o.due)[number] & { days?: number; schedule?: Recurring };
  const due: Due[] = [];
  for (const d of o.due) {
    const r = d.recurring_id ? rec.data?.find((x) => x.id === d.recurring_id) : undefined;
    const g = r && due.find((x) => x.schedule?.id === r.id);
    if (g) {
      g.days = (g.days ?? 1) + 1;
      g.balance += d.balance;
      g.overdue = g.overdue || d.overdue;
      if (d.due_date && (!g.due_date || d.due_date < g.due_date)) g.due_date = d.due_date;
    } else due.push({ ...d, schedule: r && (r.every === 'day' || (r.due_count ?? 0) > 1) ? r : undefined });
  }
  const change = o.previousMonth ? Math.round(((o.spent - o.previousMonth) / o.previousMonth) * 100) : null;
  const used = (cats.data ?? []).filter((c) => (c.spent ?? 0) > 0 || c.monthly_budget > 0).sort((a, b) => (b.spent ?? 0) - (a.spent ?? 0));
  const maxSpent = Math.max(1, ...used.map((c) => Math.max(c.spent ?? 0, c.monthly_budget)));
  const upcoming = (rec.data ?? []).filter((r) => r.active && r.next_due).sort((a, b) => (a.next_due! < b.next_due! ? -1 : 1)).slice(0, 5);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Spent this month" value={inr(o.spent, false)} tone="bad" icon={<Wallet className="h-4 w-4" />} sub={<span>{o.count} entries · last month {inr(o.previousMonth, false)}{change !== null && Math.abs(change) <= 300 && <span className={change > 0 ? 'text-bad' : 'text-good'}> ({change > 0 ? '▲' : '▼'} {Math.abs(change)}%)</span>}</span>} onClick={() => onTab('all')} />
        <Stat label="Bills to pay" value={inr(o.totalDue, false)} tone={o.overdueCount ? 'bad' : 'warn'} icon={<CalendarClock className="h-4 w-4" />} sub={o.overdueCount ? <span className="font-medium text-bad">{o.overdueCount} overdue</span> : `${o.due.length} open bills`} onClick={() => onTab('due')} />
        <Stat label="Cash in drawer" value={inr(o.cash, false)} sub={<Link to="/money" className="text-primary hover:underline">Money log →</Link>} />
        <Stat label="Bank & UPI" value={inr(o.bank, false)} sub={<Link to="/money?tab=flow" className="text-primary hover:underline">Cash flow →</Link>} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
        <Card title="Bills to pay" padded={false} action={<button className="text-xs text-primary hover:underline" onClick={() => onTab('due')}>All</button>}>
          {!o.due.length ? (
            <EmptyState icon={<CalendarClock />} title="Nothing to pay" body="Bills you record as “pay later” and recurring rent or EMIs appear here before they're due." />
          ) : (
            <ul className="divide-y divide-border" data-testid="bills-due">
              {due.slice(0, 8).map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg', d.overdue ? 'bg-bad-soft text-bad' : d.dueSoon ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
                    {d.overdue ? <AlertTriangle className="h-4 w-4" /> : <CalendarClock className="h-4 w-4" />}
                  </span>
                  <button className="min-w-0 flex-1 text-left" onClick={() => onOpen(d.id)}>
                    <span className="block truncate text-sm font-medium">{d.payee ?? d.category}</span>
                    <span className="block text-xs text-muted">
                      {d.category}
                      {d.days && d.days > 1 && <b className="text-warn"> · {d.days} {d.schedule?.every === 'day' ? 'days' : 'bills'} due</b>}
                      {d.due_date && <> · {d.days && d.days > 1 ? 'oldest ' : ''}{d.overdue ? <b className="text-bad">overdue since {fmtDay(d.due_date)}</b> : `due ${fmtDay(d.due_date)} (${relative(d.due_date).toLowerCase()})`}</>}
                    </span>
                  </button>
                  <span className="text-right">
                    <span className="block font-semibold tnum">{inr(d.balance)}</span>
                    {d.paid > 0 && !d.days && <span className="text-[11px] text-muted">of {inr(d.amount)}</span>}
                  </span>
                  {canDo(d.employee_id ? 'payroll.manage' : 'expense.create') && <Button size="sm" variant="outline" onClick={() => (d.schedule ? setPayRec(d.schedule) : setPay(d))} data-testid="due-pay">Pay</Button>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-4">
          <Card title={`Where the money went · ${new Intl.DateTimeFormat('en-IN', { month: 'long' }).format(new Date())}`} padded={false} action={<button className="text-xs text-primary hover:underline" onClick={() => onTab('categories')}>Budgets</button>}>
            {!used.length ? (
              <EmptyState icon={<Wallet />} title="No expenses this month yet" />
            ) : (
              <ul className="space-y-3 p-4" data-testid="category-spend">
                {used.slice(0, 8).map((c) => {
                  const over = c.monthly_budget > 0 && (c.spent ?? 0) > c.monthly_budget;
                  return (
                    <li key={c.id}>
                      <div className="flex justify-between text-sm">
                        <span>{c.name}</span>
                        <span className="tnum">
                          <b className={over ? 'text-bad' : ''}>{inr(c.spent ?? 0, false)}</b>
                          {c.monthly_budget > 0 && <span className="text-muted"> / {inr(c.monthly_budget, false)}</span>}
                        </span>
                      </div>
                      <div className="relative mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
                        <div className={cn('h-full rounded-full', over ? 'bg-bad' : 'bg-primary/70')} style={{ width: `${Math.min(100, ((c.spent ?? 0) / maxSpent) * 100)}%` }} />
                        {c.monthly_budget > 0 && <div className="absolute top-0 h-full w-0.5 bg-ink/50" style={{ left: `${Math.min(100, (c.monthly_budget / maxSpent) * 100)}%` }} title="Budget" />}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Coming up" padded={false} action={<button className="text-xs text-primary hover:underline" onClick={() => onTab('recurring')}>Manage</button>}>
            {!upcoming.length ? (
              <p className="px-4 py-5 text-sm text-muted">Set up rent, internet, EMIs or any repeating bill once — Hisaab adds it to “Bills to pay” a week before it's due.</p>
            ) : (
              <ul className="divide-y divide-border">
                {upcoming.map((r) => (
                  <li key={r.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span><Repeat className="mr-2 inline h-3.5 w-3.5 text-faint" />{r.payee ?? r.category}</span>
                    <span className="text-muted">{fmtDay(r.next_due!)} · <b className="text-ink tnum">{inr(r.amount, false)}</b>{r.auto_pay_mode && <Badge className="ml-1.5">auto-pay</Badge>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {pay && <PayExpenseDialog expense={pay} onClose={() => setPay(null)} />}
      {payRec && <PayRecurringDialog r={payRec} onClose={() => setPayRec(null)} />}
    </div>
  );
}

/* ───────── lists ───────── */

function ExpenseList({ status, onOpen }: { status: 'due' | 'all'; onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const [from, setFrom] = useState(status === 'all' ? monthStart() : '');
  const [to, setTo] = useState(status === 'all' ? today() : '');
  const [categoryId, setCategoryId] = useState(0);
  const cats = useApi('expenses.categories', {});
  const list = useApi('expenses.list', { q, from: from || undefined, to: to || undefined, categoryId: categoryId || undefined, status: status === 'due' ? 'due' : 'all' });
  const rows = list.data ?? [];
  const live = rows.filter((r) => r.status !== 'cancelled');
  const total = live.reduce((s, r) => s + r.amount, 0);
  const balance = live.reduce((s, r) => s + r.amount - r.paid, 0);
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Paid to, bill no., note…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <Select value={categoryId} onChange={(e) => setCategoryId(Number(e.target.value))} className="w-56">
          <option value={0}>All categories</option>
          {cats.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
        {status === 'all' && (
          <>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
            <span className="text-muted">to</span>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
          </>
        )}
        <span className="flex-1" />
        <span className="text-sm text-muted">{status === 'due' ? <>To pay <b className="text-bad tnum">{inr(balance)}</b></> : <>Total <b className="text-ink tnum">{inr(total)}</b></>}</span>
        <Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} disabled={!rows.length} onClick={() => downloadCsv(toCsv(rows.map((r) => ({ date: r.date, category: r.category, paid_to: r.payee ?? '', bill_no: r.bill_no ?? '', note: r.description ?? '', amount: r.amount / 100, gst: (r.cgst + r.sgst + r.igst) / 100, input_credit: r.itc ? 'yes' : 'no', paid: r.paid / 100, status: r.status, due_date: r.due_date ?? '', entered_by: r.created_by_name ?? '' }))), `expenses-${today()}.csv`)}>CSV</Button>
      </div>
      {list.isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <EmptyState icon={<Wallet />} title={status === 'due' ? 'No bills waiting to be paid' : 'No expenses in this period'} />
      ) : (
        <div className="max-h-[calc(100vh-300px)] overflow-y-auto">
          <table className="table-base" data-testid="expense-table">
            <thead>
              <tr><th>Date</th><th>What</th><th>Paid to</th><th>Status</th><th className="text-right">Amount</th><th className="text-right">{status === 'due' ? 'Still to pay' : 'Paid'}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn('cursor-pointer', r.status === 'cancelled' && 'opacity-50')} onClick={() => onOpen(r.id)}>
                  <td className="whitespace-nowrap text-muted">{fmtDate(r.date)}</td>
                  <td>
                    <div className="font-medium">{r.category}</div>
                    <div className="text-xs text-muted">{[r.description, r.bill_no && `Bill ${r.bill_no}`].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td>{r.payee ?? '—'}</td>
                  <td><StatusBadge status={r.status} due={r.due_date} /></td>
                  <td className="text-right font-medium tnum">{inr(r.amount)}{r.itc ? <div className="text-[10px] font-normal text-good">GST credit {inr(r.cgst + r.sgst + r.igst)}</div> : null}</td>
                  <td className="text-right tnum">{status === 'due' ? <b className="text-bad">{inr(r.amount - r.paid)}</b> : inr(r.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status, due }: { status: string; due: string | null }) {
  if (status === 'paid') return <Badge tone="good">Paid</Badge>;
  if (status === 'cancelled') return <Badge>Cancelled</Badge>;
  const overdue = due && due < today();
  return <Badge tone={overdue ? 'bad' : 'warn'}>{status === 'partial' ? 'Part paid' : 'Unpaid'}{due ? ` · ${overdue ? 'overdue' : `due ${fmtDay(due)}`}` : ''}</Badge>;
}

/* ───────── detail drawer ───────── */

export function ExpenseDrawer({ id, onClose }: { id: number; onClose: () => void }) {
  const canDo = useCan();
  const q = useApi('expenses.get', { id });
  const [pay, setPay] = useState(false);
  const [cancel, setCancel] = useState(false);
  const [reason, setReason] = useState('');
  const e = q.data;
  const canEdit = e ? canDo(e.employee_id ? 'payroll.manage' : 'expense.create') : false;
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title={e ? `${e.category}${e.payee ? ` · ${e.payee}` : ''}` : 'Expense'} width="max-w-lg"
      footer={e && canEdit && e.status !== 'cancelled' ? (
        <>
          <Button variant="ghost" icon={<Ban className="h-4 w-4" />} onClick={() => setCancel(true)}>Cancel entry</Button>
          {e.status !== 'paid' && <Button variant="primary" onClick={() => setPay(true)} data-testid="expense-pay">Pay {inr(e.amount - e.paid)}</Button>}
        </>
      ) : undefined}>
      {!e ? <Loading /> : (
        <div className="space-y-4 text-sm">
          <div className="flex items-end justify-between rounded-xl bg-surface-2 p-4">
            <div>
              <div className="text-xs text-muted">Amount</div>
              <div className="text-2xl font-semibold tnum">{inr(e.amount)}</div>
            </div>
            <span className="flex items-center gap-2">
              {(e as { approval?: string | null }).approval === 'pending' && <Badge tone="warn">needs owner approval</Badge>}
              {!!(e as { petty?: number }).petty && <Badge>petty cash</Badge>}
              <StatusBadge status={e.status} due={e.due_date} />
            </span>
          </div>
          <Attachments expenseId={e.id} canEdit={canEdit} />
          <dl className="grid grid-cols-[130px_1fr] gap-y-2">
            <dt className="text-muted">Date</dt><dd>{fmtDate(e.date)}</dd>
            {e.due_date && (<><dt className="text-muted">Due</dt><dd>{fmtDate(e.due_date)}</dd></>)}
            <dt className="text-muted">Category</dt><dd>{e.category} <span className="text-faint">· {e.grp}</span></dd>
            {e.payee && (<><dt className="text-muted">Paid to</dt><dd>{e.payee}</dd></>)}
            {e.bill_no && (<><dt className="text-muted">Bill no.</dt><dd>{e.bill_no}</dd></>)}
            {e.description && (<><dt className="text-muted">Note</dt><dd>{e.description}</dd></>)}
            {e.gst_rate > 0 && (<><dt className="text-muted">GST</dt><dd>{e.gst_rate}% · {inr(e.cgst + e.sgst + e.igst)} {e.itc ? <Badge tone="good">input credit claimed</Badge> : <Badge>no credit</Badge>}{e.payee_gstin && <div className="font-mono text-xs text-muted">{e.payee_gstin}</div>}</dd></>)}
            {e.recurring_id && (<><dt className="text-muted">Repeats</dt><dd><Badge><Repeat className="h-3 w-3" /> recurring</Badge></dd></>)}
            <dt className="text-muted">Entered by</dt><dd>{e.created_by_name ?? '—'} · {e.created_at}</dd>
            {e.cancel_reason && (<><dt className="text-muted">Cancelled</dt><dd className="text-bad">{e.cancel_reason}</dd></>)}
          </dl>
          <div>
            <h4 className="mb-2 font-semibold">Payments</h4>
            {!e.payments?.length ? <p className="text-muted">Not paid yet.</p> : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {e.payments.map((p) => (
                  <li key={`${p.kind}${p.id}`} className={cn('flex items-center justify-between px-3 py-2', p.cancelled && 'line-through opacity-50')}>
                    <span>{fmtDate(p.date)} · <span className="capitalize">{p.kind === 'advance' ? 'from advance' : p.mode}</span> <span className="text-xs text-faint">by {p.by ?? '—'}</span></span>
                    <span className="flex items-center gap-2 font-medium tnum">{inr(p.amount)}
                      {!p.cancelled && p.kind === 'payment' && canEdit && !e.legacy_payment_id && (
                        <button title="Undo this payment" className="text-faint hover:text-bad" onClick={async () => { try { await call('expenses.cancelPayment', { paymentId: p.id }); toast.success('Payment undone'); } catch (x) { toast.error(x); } }}><Ban className="h-3.5 w-3.5" /></button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {pay && <PayExpenseDialog expense={e} advance={0} onClose={() => setPay(false)} />}
          <ConfirmDialog open={cancel} onOpenChange={setCancel} danger title="Cancel this expense?" body="Its payments are reversed and the money goes back to cash / bank in the books. The entry stays in history as cancelled." confirmLabel="Cancel expense"
            onConfirm={async () => { await call('expenses.cancel', { id: e.id, reason }); toast.success('Expense cancelled'); }}>
            <Field label="Reason" className="mt-3"><Input autoFocus value={reason} onChange={(x) => setReason(x.target.value)} placeholder="e.g. Entered twice" /></Field>
          </ConfirmDialog>
        </div>
      )}
    </Drawer>
  );
}

/* ───────── recurring ───────── */

const UNIT: Record<Recurring['every'], [string, string]> = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], quarter: ['quarter', 'quarters'], year: ['year', 'years'] };
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every day except Sun", "Every 15 days", "Every month"… */
export function describeEvery(r: Pick<Recurring, 'every' | 'every_n' | 'skip_weekdays'>) {
  const n = r.every_n || 1;
  const base = n === 1 ? (r.every === 'quarter' ? 'Every 3 months' : `Every ${UNIT[r.every][0]}`) : `Every ${n} ${UNIT[r.every][1]}`;
  const skip = r.skip_weekdays ? r.skip_weekdays.split(',').map((d) => WEEKDAYS[+d]) : [];
  return skip.length ? `${base} except ${skip.join(', ')}` : base;
}

function RecurringTab({ startNew, onDone }: { startNew: boolean; onDone: () => void }) {
  const list = useApi('expenses.recurring');
  const canDo = useCan();
  const [edit, setEdit] = useState<Recurring | 'new' | null>(startNew ? 'new' : null);
  const [pay, setPay] = useState<Recurring | null>(null);
  return (
    <Card padded={false} title="Repeating expenses" action={canDo('expense.create') && <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')} data-testid="recurring-new">New</Button>}>
      {!list.data?.length ? (
        <EmptyState icon={<Repeat />} title="Nothing repeating yet" body="Daily shop rent, monthly rent, internet, insurance, loan EMIs — add them once. Daily bills appear each day; others a week before they're due. Missed days can be paid together." />
      ) : (
        <table className="table-base" data-testid="recurring-table">
          <thead><tr><th>What</th><th>How often</th><th>Due now</th><th>Next</th><th className="text-right">Amount</th><th /></tr></thead>
          <tbody>
            {list.data.map((r) => (
              <tr key={r.id} className={r.active ? '' : 'opacity-50'} data-testid="recurring-row">
                <td><div className="font-medium">{r.payee ?? r.category}</div><div className="text-xs text-muted">{r.category}{r.description ? ` · ${r.description}` : ''}</div></td>
                <td>{describeEvery(r)}{!!r.skips?.length && <span className="block text-xs text-muted">{r.skips.length} closed-day range{r.skips.length > 1 ? 's' : ''}</span>}{r.auto_pay_mode && <Badge className="ml-2">auto-pay · {r.auto_pay_mode}</Badge>}</td>
                <td data-testid="recurring-due">{r.due_count ? <span className="font-medium text-warn">{r.due_count} {r.every === 'day' ? (r.due_count === 1 ? 'day' : 'days') : r.due_count === 1 ? 'bill' : 'bills'} · {inr(r.due_amount ?? 0)}</span> : <span className="text-muted">Nothing due</span>}</td>
                <td>{r.active ? (r.next_due ? fmtDate(r.next_due) : 'Ended') : 'Paused'}</td>
                <td className="text-right font-medium tnum">{inr(r.amount)}{r.every === 'day' && <span className="text-xs text-muted">/day</span>}</td>
                <td className="whitespace-nowrap text-right">
                  {canDo('expense.create') && (r.due_count || r.active) ? <Button size="sm" variant="outline" icon={<Wallet className="h-3.5 w-3.5" />} onClick={() => setPay(r)} data-testid="recurring-pay">Pay</Button> : null}
                  {canDo('expense.create') && <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEdit(r)}>Edit</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <RecurringDialog initial={edit === 'new' ? null : edit} onClose={() => (setEdit(null), onDone())} />}
      {pay && <PayRecurringDialog r={pay} onClose={() => setPay(null)} />}
    </Card>
  );
}

/** Pay several days / bills of a repeating expense together: all due, some of them, an amount, or ahead. */
export function PayRecurringDialog({ r, onClose }: { r: Pick<Recurring, 'id' | 'payee' | 'category' | 'every' | 'amount'>; onClose: () => void }) {
  const st = useApi('expenses.recurringDue', { recurringId: r.id, aheadDays: 31 });
  const [how, setHow] = useState<'days' | 'amount' | 'ahead'>('days');
  const [days, setDays] = useState<number | null>(null);
  const [amount, setAmount] = useState(0);
  const [ahead, setAhead] = useState(7);
  const [mode, setMode] = useState<PayMode>('cash');
  const [date, setDate] = useState(today());
  const pay = useAction('expenses.payRecurring', { success: (x) => `Paid ${inr(x.amount)} · ${x.note}`, onSuccess: onClose });
  const word = r.every === 'day' ? ['day', 'days'] : ['bill', 'bills'];
  if (!st.data) return null;
  const unpaid = st.data.unpaid;
  const n = Math.min(days ?? unpaid.length, unpaid.length);
  // What will be covered, for the preview line.
  let cover: Array<{ date: string; amount: number }> = [];
  if (how === 'days') cover = unpaid.slice(0, n).map((x) => ({ date: x.date, amount: x.due }));
  else if (how === 'amount') {
    let left = amount;
    for (const x of unpaid) {
      if (left <= 0) break;
      cover.push({ date: x.date, amount: Math.min(x.due, left) });
      left -= Math.min(x.due, left);
    }
  } else cover = [...unpaid.map((x) => ({ date: x.date, amount: x.due })), ...st.data.ahead.slice(0, ahead).map((d) => ({ date: d, amount: r.amount }))];
  const total = cover.reduce((a, x) => a + x.amount, 0);
  const span = cover.length ? (cover.length === 1 ? fmtDate(cover[0].date) : `${fmtDate(cover[0].date)} – ${fmtDate(cover[cover.length - 1].date)}`) : '';
  const go = () =>
    pay.mutate({ recurringId: r.id, mode, date, ...(how === 'days' ? { days: n } : how === 'amount' ? { amount } : { ahead }) });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Pay ${r.payee ?? r.category}`} description={unpaid.length ? `${unpaid.length} ${unpaid.length === 1 ? word[0] : word[1]} due · ${inr(st.data.total)}${st.data.lastPaid ? ` · paid up to ${fmtDate(st.data.lastPaid)}` : ''}` : 'Nothing is due right now.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={pay.isPending} disabled={!cover.length || total <= 0} onClick={go} data-testid="rpay-save">Pay {inr(total)}</Button></>}>
      <div className="space-y-4">
        <Segmented value={how} onChange={setHow} options={[{ value: 'days', label: `Choose ${word[1]}` }, { value: 'amount', label: 'Enter amount' }, { value: 'ahead', label: 'Pay in advance' }]} />
        {how === 'days' && (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {unpaid.length > 0 && <Button size="sm" variant={n === 1 ? 'primary' : 'outline'} onClick={() => setDays(1)}>Oldest 1</Button>}
              {unpaid.length > 1 && <Button size="sm" variant={n === unpaid.length ? 'primary' : 'outline'} onClick={() => setDays(unpaid.length)} data-testid="rpay-all">All {unpaid.length} due</Button>}
            </div>
            <Field label={`Number of ${word[1]} (oldest first)`}><Input type="number" min={1} max={unpaid.length} value={n} onChange={(e) => setDays(Math.max(0, Math.min(unpaid.length, Number(e.target.value) || 0)))} data-testid="rpay-days" /></Field>
          </div>
        )}
        {how === 'amount' && <Field label="Amount paid" hint="Settles the oldest days first; the last one can be part-paid."><MoneyInput value={amount} onChange={setAmount} data-testid="rpay-amount" /></Field>}
        {how === 'ahead' && (
          <Field label={`Also pay the next … ${word[1]}`} hint={`Clears everything due now, plus these upcoming ${word[1]}.`}>
            <div className="flex flex-wrap items-center gap-2">
              {[7, 15, 30].filter((x) => x <= st.data!.ahead.length).map((x) => <Button key={x} size="sm" variant={ahead === x ? 'primary' : 'outline'} onClick={() => setAhead(x)}>{x}</Button>)}
              <Input type="number" min={1} max={st.data.ahead.length} value={ahead} onChange={(e) => setAhead(Math.max(1, Math.min(st.data!.ahead.length, Number(e.target.value) || 1)))} className="w-24" data-testid="rpay-ahead" />
            </div>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid by"><Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} /></Field>
          <Field label="Payment date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {cover.length > 0 && (
          <div className="rounded-lg bg-surface-2 p-3 text-sm" data-testid="rpay-cover">
            <b>{cover.length} {cover.length === 1 ? word[0] : word[1]}</b> · {span} · <b className="tnum">{inr(total)}</b>
            {cover[cover.length - 1].amount < (unpaid.find((x) => x.date === cover[cover.length - 1].date)?.due ?? r.amount) && <span className="text-muted"> (last one part-paid)</span>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function RecurringDialog({ initial, onClose }: { initial: Recurring | null; onClose: () => void }) {
  const cats = useApi('expenses.categories', {});
  const [f, setF] = useState({
    categoryId: initial?.category_id ?? 0, amount: initial?.amount ?? 0, every: initial?.every ?? ('month' as Recurring['every']), everyN: initial?.every_n ?? 1,
    skipWeekdays: initial?.skip_weekdays ? initial.skip_weekdays.split(',').map(Number) : ([] as number[]), skips: initial?.skips ?? [],
    backfill: !!initial?.bills_from, anchorDate: initial?.anchor_date ?? today(),
    endDate: initial?.end_date ?? '', payee: initial?.payee ?? '', description: initial?.description ?? '', autoPay: !!initial?.auto_pay_mode, autoPayMode: (initial?.auto_pay_mode ?? 'bank') as PayMode, active: initial ? !!initial.active : true,
  });
  const [skip, setSkip] = useState({ from: '', to: '', note: '' });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const options = (cats.data ?? []).filter((c) => c.active && !c.is_salary);
  const catId = f.categoryId || options.find((c) => c.name === 'Shop rent')?.id || options[0]?.id || 0;
  const save = useAction('expenses.saveRecurring', { success: initial ? 'Saved' : 'Repeating expense added', onSuccess: onClose });
  const preview = previewDates(f.anchorDate, f.every, f.everyN, f.skipWeekdays, f.skips, f.endDate, 5);
  const past = f.anchorDate < today() && (!initial || initial.created_at.slice(0, 10) > f.anchorDate);
  const toggleDay = (d: number) => set('skipWeekdays', f.skipWeekdays.includes(d) ? f.skipWeekdays.filter((x) => x !== d) : [...f.skipWeekdays, d]);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={initial ? 'Edit repeating expense' : 'New repeating expense'} size="lg"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={f.amount <= 0 || !catId || f.skipWeekdays.length === 7} data-testid="recurring-save"
        onClick={() => save.mutate({
          id: initial?.id, categoryId: catId, amount: f.amount, every: f.every, everyN: f.everyN, skipWeekdays: f.every === 'day' ? f.skipWeekdays : [], skips: f.skips,
          billsFrom: past && f.backfill ? f.anchorDate : initial?.bills_from ?? null, anchorDate: f.anchorDate, endDate: f.endDate || null, payee: f.payee, description: f.description,
          autoPayMode: f.autoPay ? f.autoPayMode : null, active: f.active,
        })}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Category"><Select value={catId} onChange={(e) => set('categoryId', Number(e.target.value))}>{options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
        <Field label={f.every === 'day' ? 'Amount per day' : 'Amount each time'}><MoneyInput value={f.amount} onChange={(v) => set('amount', v)} data-testid="recurring-amount" /></Field>
        <Field label="Paid to"><Input value={f.payee} onChange={(e) => set('payee', e.target.value)} placeholder="e.g. Mr. Kulkarni (landlord)" data-testid="recurring-payee" /></Field>
        <Field label="Repeats">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted">Every</span>
            <Input type="number" min={1} max={365} value={f.everyN} onChange={(e) => set('everyN', Math.max(1, Math.min(365, Number(e.target.value) || 1)))} className="w-20" data-testid="recurring-n" />
            <Select value={f.every} onChange={(e) => set('every', e.target.value as Recurring['every'])} data-testid="recurring-every">
              {(Object.keys(UNIT) as Array<Recurring['every']>).map((k) => <option key={k} value={k}>{f.everyN === 1 ? UNIT[k][0] : UNIT[k][1]}</option>)}
            </Select>
          </div>
        </Field>
        {f.every === 'day' && (
          <Field label="Nothing due on" hint="e.g. the shop is shut on Sundays" className="sm:col-span-2">
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((w, d) => (
                <button key={w} type="button" onClick={() => toggleDay(d)} data-testid={`skip-${w}`}
                  className={cn('rounded-full border px-3 py-1 text-sm', f.skipWeekdays.includes(d) ? 'border-bad bg-bad/10 text-bad line-through' : 'border-border hover:bg-surface-2')}>{w}</button>
              ))}
            </div>
          </Field>
        )}
        <Field label="First due date" hint={f.every === 'day' ? 'Rent is due every day from here' : 'Later ones follow on the same day'}><Input type="date" value={f.anchorDate} onChange={(e) => set('anchorDate', e.target.value)} data-testid="recurring-anchor" /></Field>
        <Field label="Ends on" hint="Optional, e.g. last EMI"><Input type="date" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></Field>
        {past && (
          <div className="sm:col-span-2">
            <Switch checked={f.backfill} onChange={(v) => set('backfill', v)} label={`Also add the unpaid ${f.every === 'day' ? 'days' : 'bills'} since ${fmtDate(f.anchorDate)}`} hint="Turn on if you still owe for those days. Off: bills start from today." data-testid="recurring-backfill" />
          </div>
        )}
        <div className="sm:col-span-2 rounded-xl border border-border p-3">
          <p className="mb-2 text-sm font-medium">Closed days / holidays <span className="font-normal text-muted">— nothing is due on these dates</span></p>
          {f.skips.length > 0 && (
            <ul className="mb-2 space-y-1 text-sm">
              {f.skips.map((x, i) => (
                <li key={i} className="flex items-center justify-between rounded bg-surface-2 px-2 py-1">
                  <span>{fmtDate(x.from_date)}{x.to_date !== x.from_date && ` – ${fmtDate(x.to_date)}`}{x.note && <span className="text-muted"> · {x.note}</span>}</span>
                  <button className="text-xs text-bad" onClick={() => set('skips', f.skips.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="From"><Input type="date" value={skip.from} onChange={(e) => setSkip({ ...skip, from: e.target.value })} data-testid="skip-from" /></Field>
            <Field label="To"><Input type="date" value={skip.to} onChange={(e) => setSkip({ ...skip, to: e.target.value })} data-testid="skip-to" /></Field>
            <Field label="Why (optional)"><Input value={skip.note} onChange={(e) => setSkip({ ...skip, note: e.target.value })} placeholder="Diwali, renovation…" /></Field>
            <Button size="sm" variant="outline" disabled={!skip.from} data-testid="skip-add"
              onClick={() => (set('skips', [...f.skips, { from_date: skip.from, to_date: skip.to && skip.to > skip.from ? skip.to : skip.from, note: skip.note || null }]), setSkip({ from: '', to: '', note: '' }))}>Add</Button>
          </div>
        </div>
        <Field label="Note" className="sm:col-span-2"><Input value={f.description} onChange={(e) => set('description', e.target.value)} /></Field>
        <div className="sm:col-span-2 space-y-3 rounded-xl border border-border p-3">
          <Switch checked={f.autoPay} onChange={(v) => set('autoPay', v)} label="Paid automatically (auto-debit / UPI autopay)" hint="Marked paid on the due date. Otherwise it waits in Bills to pay." />
          {f.autoPay && <Segmented size="sm" value={f.autoPayMode} onChange={(v) => set('autoPayMode', v)} options={[{ value: 'bank', label: 'Bank' }, { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }]} />}
          {initial && <Switch checked={f.active} onChange={(v) => set('active', v)} label="Active" hint="Pause to stop creating new bills" />}
        </div>
        <p className="sm:col-span-2 text-sm text-muted" data-testid="recurring-preview">
          {describeEvery({ every: f.every, every_n: f.everyN, skip_weekdays: f.every === 'day' ? f.skipWeekdays.sort().join(',') || null : null })} · next: {preview.length ? preview.map((d) => fmtDay(d)).join(', ') : '—'}
        </p>
      </div>
    </Dialog>
  );
}

/** Upcoming due dates for the dialog preview (same rules as the database). */
function previewDates(anchor: string, every: Recurring['every'], n: number, skipWd: number[], skips: Array<{ from_date: string; to_date: string }>, end: string, count: number) {
  const from = anchor > today() ? anchor : today();
  return dueDates({ anchor_date: anchor, every, every_n: n, skip_weekdays: skipWd.join(',') || null, end_date: end || null }, skips, from, '9999-12-31', count);
}

/* ───────── categories & budgets ───────── */

function Categories() {
  const month = thisMonth();
  const cats = useApi('expenses.categories', { month });
  const canDo = useCan();
  const [edit, setEdit] = useState<{ id?: number; name: string; grp: string; monthlyBudget: number; active: boolean } | null>(null);
  const save = useAction('expenses.saveCategory', { success: 'Category saved', onSuccess: () => setEdit(null) });
  const rows = cats.data ?? [];
  const groups = [...new Set(rows.map((c) => c.grp))];
  return (
    <Card padded={false} title="Categories & monthly budgets" action={canDo('expense.create') && <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', grp: 'Other', monthlyBudget: 0, active: true })}>New category</Button>}>
      <table className="table-base">
        <thead><tr><th>Category</th><th>Group</th><th className="text-right">This month</th><th className="text-right">Budget</th><th /></tr></thead>
        <tbody>
          {rows.map((c) => {
            const over = c.monthly_budget > 0 && (c.spent ?? 0) > c.monthly_budget;
            return (
              <tr key={c.id} className={c.active ? '' : 'opacity-50'}>
                <td className="font-medium">{c.name}{c.is_salary ? <Badge className="ml-2">salaries</Badge> : null}</td>
                <td className="text-muted">{c.grp}</td>
                <td className={cn('text-right tnum', over && 'font-semibold text-bad')}>{inr(c.spent ?? 0, false)}</td>
                <td className="text-right tnum text-muted">{c.monthly_budget ? inr(c.monthly_budget, false) : '—'}</td>
                <td className="text-right">{canDo('expense.create') && <Button size="sm" variant="ghost" onClick={() => setEdit({ id: c.id, name: c.name, grp: c.grp, monthlyBudget: c.monthly_budget, active: !!c.active })}>Edit</Button>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {edit && (
        <Dialog open onOpenChange={(v) => !v && setEdit(null)} title={edit.id ? 'Edit category' : 'New category'} size="sm"
          footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(edit)}>Save</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Group"><Input list="grps" value={edit.grp} onChange={(e) => setEdit({ ...edit, grp: e.target.value })} /><datalist id="grps">{groups.map((g) => <option key={g} value={g} />)}</datalist></Field>
            <Field label="Monthly budget" hint="0 = no budget. You'll see a warning when spending crosses it."><MoneyInput value={edit.monthlyBudget} onChange={(v) => setEdit({ ...edit, monthlyBudget: v })} /></Field>
            {edit.id && <Switch checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Active" />}
          </div>
        </Dialog>
      )}
    </Card>
  );
}
