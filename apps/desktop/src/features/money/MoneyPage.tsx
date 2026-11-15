import { toCsv } from '@hisaab/core';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Ban, Calculator, Download, HandCoins, PiggyBank, Plus, Receipt, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Loading, Money, MoneyInput, PageHeader, Segmented, Stat, Tabs, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Party, PayMode } from '../../db/types';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { fmtDate, fmtTime, inr, monthStart, shiftDate, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';
import { ExpenseDialog } from '../expenses/ExpenseDialog';
import { CustomerPicker } from '../pos/CustomerPicker';
import { BankReconciliation, Cheques } from './Banking';

type Tab = 'log' | 'flow' | 'payments' | 'moves' | 'bank' | 'cheques';
type Action = 'in' | 'out' | 'expense' | 'transfer' | 'owner' | 'income' | 'check';

export function MoneyPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? (canDo('expense.view') ? 'log' : 'payments');
  const action = params.get('action') as Action | null;
  const set = (patch: Record<string, string | null>) =>
    setParams((p) => {
      for (const [k, v] of Object.entries(patch)) v === null ? p.delete(k) : p.set(k, v);
      return p;
    });
  const dash = useApi('reports.dashboard');
  const close = () => set({ action: null });

  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader
        icon={<Wallet className="h-5 w-5" />}
        title="Money"
        subtitle="Every rupee in and out of the drawer and the bank — who moved it, when, and why."
        actions={
          <>
            {canDo('money.move') && <Button variant="outline" icon={<Calculator className="h-4 w-4" />} onClick={() => set({ action: 'check' })} data-testid="cash-check">Count cash</Button>}
            {canDo('money.move') && <Button variant="outline" icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => set({ action: 'transfer' })} data-testid="money-transfer">Cash ↔ Bank</Button>}
            {canDo('expense.create') && <Button variant="outline" icon={<Receipt className="h-4 w-4" />} onClick={() => set({ action: 'expense' })}>Expense</Button>}
            {canDo('payment.out') && <Button variant="outline" icon={<ArrowUpRight className="h-4 w-4" />} onClick={() => set({ action: 'out' })}>Pay supplier</Button>}
            <Button variant="saffron" icon={<ArrowDownLeft className="h-4 w-4" />} onClick={() => set({ action: 'in' })} data-testid="money-in">Money in</Button>
          </>
        }
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Cash in drawer" value={inr(dash.data?.cash ?? 0, false)} icon={<Wallet className="h-4 w-4" />} />
        <Stat label="Bank & UPI" value={inr(dash.data?.bank ?? 0, false)} icon={<PiggyBank className="h-4 w-4" />} />
        <Stat label="Money in today" value={inr(dash.data?.moneyIn ?? 0, false)} tone="saffron" icon={<ArrowDownLeft className="h-4 w-4" />} />
        <Stat label="Money out today" value={inr(dash.data?.moneyOut ?? 0, false)} tone="bad" icon={<ArrowUpRight className="h-4 w-4" />} />
      </div>
      {canDo('money.move') && (
        <div className="flex flex-wrap gap-2 text-sm">
          <QuickLink onClick={() => set({ action: 'owner' })} icon={<HandCoins className="h-4 w-4" />}>Owner took / added money</QuickLink>
          <QuickLink onClick={() => set({ action: 'income' })} icon={<Plus className="h-4 w-4" />}>Other income (scrap, commission…)</QuickLink>
          {canDo('payroll.manage') && <Link to="/staff" className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-muted hover:border-primary hover:text-primary"><Wallet className="h-4 w-4" /> Salaries & advances</Link>}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={(t) => set({ tab: t })}
        tabs={[
          ...(canDo('expense.view') ? [{ value: 'log' as const, label: 'Money log' }, { value: 'flow' as const, label: 'Cash flow' }] : []),
          { value: 'payments' as const, label: 'Customer & supplier payments' },
          ...(canDo('expense.view') ? [{ value: 'moves' as const, label: 'Transfers, owner & cash checks' }] : []),
          { value: 'cheques' as const, label: 'Cheques' },
          ...(canDo('money.move') ? [{ value: 'bank' as const, label: 'Bank reconciliation' }] : []),
        ]}
      />
      {tab === 'log' && <MoneyLog />}
      {tab === 'flow' && <CashFlow />}
      {tab === 'payments' && <PartyPayments />}
      {tab === 'moves' && <Moves />}
      {tab === 'cheques' && <Cheques />}
      {tab === 'bank' && <BankReconciliation />}
      {(action === 'in' || action === 'out') && <PaymentDialog direction={action} onClose={close} />}
      {action === 'expense' && <ExpenseDialog onClose={close} />}
      {(action === 'transfer' || action === 'owner' || action === 'income') && <MoveDialog kind={action} onClose={close} />}
      {action === 'check' && <CashCheckDialog onClose={close} />}
    </div>
  );
}

function QuickLink({ children, icon, onClick }: { children: React.ReactNode; icon: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-muted hover:border-primary hover:text-primary">
      {icon} {children}
    </button>
  );
}

/* ───────── money log ───────── */

function MoneyLog() {
  const [from, setFrom] = useState(shiftDate(today(), -6));
  const [to, setTo] = useState(today());
  const [account, setAccount] = useState<'ALL' | 'CASH' | 'BANK'>('ALL');
  const q = useApi('money.log', { from, to, account });
  const d = q.data;
  return (
    <Card padded={false}>
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        <Segmented size="sm" value={account} onChange={setAccount} options={[{ value: 'ALL', label: 'Cash + Bank' }, { value: 'CASH', label: 'Cash' }, { value: 'BANK', label: 'Bank / UPI' }]} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        <span className="text-muted">to</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
        <span className="flex-1" />
        {d && (
          <span className="text-sm text-muted">
            Opening <b className="text-ink tnum">{inr(d.opening)}</b> · In <b className="text-saffron-ink tnum">{inr(d.totalIn)}</b> · Out <b className="text-bad tnum">{inr(d.totalOut)}</b> · Closing <b className="text-ink tnum">{inr(d.closing)}</b>
          </span>
        )}
        <Button size="sm" variant="outline" icon={<Download className="h-4 w-4" />} disabled={!d?.rows.length} onClick={() => d && downloadCsv(toCsv(d.rows.map((r) => ({ date: r.date, time: r.time ?? '', account: r.account, what: r.label, details: r.detail ?? '', money_in: r.in / 100, money_out: r.out / 100, balance: r.balance / 100, recorded_by: r.by ?? '' }))), `money-log-${from}-to-${to}.csv`)}>CSV</Button>
      </div>
      {!d ? <Loading /> : !d.rows.length ? (
        <EmptyState icon={<Wallet />} title="No money moved in these dates" />
      ) : (
        <div className="max-h-[calc(100vh-360px)] overflow-y-auto">
          <table className="table-base" data-testid="money-log">
            <thead><tr><th>When</th><th>What</th><th>Account</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Balance</th><th>By</th></tr></thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-muted">{fmtDate(r.date)}<div className="text-[11px] text-faint">{r.time ? fmtTime(r.time) : ''}</div></td>
                  <td>
                    <div className="font-medium">{r.link ? <Link to={r.link} className="hover:underline">{r.label}</Link> : r.label}</div>
                    {r.detail && <div className="text-xs text-muted">{r.detail}</div>}
                  </td>
                  <td><Badge tone={r.account === 'CASH' ? 'saffron' : 'primary'}>{r.account === 'CASH' ? 'Cash' : 'Bank'}</Badge></td>
                  <td className="text-right tnum text-saffron-ink">{r.in ? inr(r.in) : ''}</td>
                  <td className="text-right tnum text-bad">{r.out ? inr(r.out) : ''}</td>
                  <td className="text-right font-medium tnum">{inr(r.balance)}</td>
                  <td className="text-muted">{r.by ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ───────── cash flow ───────── */

function CashFlow() {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const q = useApi('reports.cashflow', { from, to });
  const d = q.data;
  const max = d ? Math.max(1, ...[...d.inflows, ...d.outflows].map((l) => Math.abs(l.amount))) : 1;
  const Row = ({ label, amount, sub }: { label: string; amount: number; sub?: boolean }) => (
    <div className={cn('grid grid-cols-[1fr_140px] items-center gap-3 py-1.5', sub && 'pl-5 text-xs text-muted')}>
      <div>
        <div className="flex justify-between"><span>{label}</span></div>
        {!sub && <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2"><div className={cn('h-full rounded-full', amount >= 0 ? 'bg-saffron' : 'bg-primary/70')} style={{ width: `${(Math.abs(amount) / max) * 100}%` }} /></div>}
      </div>
      <span className={cn('text-right tnum', !sub && 'font-semibold')}>{amount > 0 ? '+' : ''}{inr(amount)}</span>
    </div>
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented size="sm" value="" onChange={(v) => { if (v === 'month') (setFrom(monthStart()), setTo(today())); if (v === '30') (setFrom(shiftDate(today(), -29)), setTo(today())); if (v === '90') (setFrom(shiftDate(today(), -89)), setTo(today())); }} options={[{ value: 'month', label: 'This month' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" />
        <span className="text-muted">to</span>
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" />
      </div>
      {!d ? <Loading /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
          <Card title="Where money came from and where it went" data-testid="cash-flow">
            <div data-testid="cash-flow-body">
              <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-faint">Money in</div>
              {d.inflows.length ? d.inflows.map((l) => <Row key={l.group} label={l.label} amount={l.amount} />) : <p className="py-2 text-sm text-muted">Nothing came in.</p>}
              <div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-faint">Money out</div>
              {d.outflows.length ? d.outflows.map((l) => (
                <div key={l.group}>
                  <Row label={l.label} amount={l.amount} />
                  {l.group === 'expenses' && d.expenseBreakdown.map((x) => <Row key={x.label} label={x.label} amount={x.amount} sub />)}
                </div>
              )) : <p className="py-2 text-sm text-muted">Nothing went out.</p>}
              {d.other.length > 0 && (<><div className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wider text-faint">Other</div>{d.other.map((l) => <Row key={l.group} label={l.label} amount={l.amount} />)}</>)}
            </div>
          </Card>
          <div className="space-y-4">
            <Card>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between text-muted"><span>Opening (cash + bank)</span><span className="tnum">{inr(d.opening)}</span></div>
                <div className="flex justify-between"><span>Net change</span><Money value={d.net} tone="auto" /></div>
                <div className="flex justify-between border-t border-border pt-2 text-base font-semibold"><span>Closing</span><span className="tnum">{inr(d.closing)}</span></div>
              </div>
            </Card>
            <Card title="Month by month" padded={false}>
              <table className="table-base text-xs">
                <thead><tr><th>Month</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Net</th></tr></thead>
                <tbody>
                  {d.monthly.map((m) => (
                    <tr key={m.month}>
                      <td>{new Intl.DateTimeFormat('en-IN', { month: 'short', year: '2-digit' }).format(new Date(`${m.month}-01T00:00:00`))}</td>
                      <td className="text-right tnum">{inr(m.in, false)}</td>
                      <td className="text-right tnum">{inr(m.out, false)}</td>
                      <td className={cn('text-right font-medium tnum', m.in - m.out < 0 ? 'text-bad' : 'text-good')}>{inr(m.in - m.out, false)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <p className="text-xs text-muted">Cash ↔ bank transfers move money between your own accounts, so they don't change the total. For profit (including unpaid bills), see <Link className="text-primary hover:underline" to="/reports?tab=pnl">Profit & loss</Link>.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── customer & supplier payments ───────── */

function PartyPayments() {
  const canDo = useCan();
  const [filter, setFilter] = useState<'all' | 'in' | 'out'>('all');
  const list = useApi('payments.list', { from: monthStart(), kind: 'party', direction: filter === 'all' ? undefined : filter });
  const rows = list.data ?? [];
  return (
    <Card padded={false} title={<Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'Received' }, { value: 'out', label: 'Paid' }]} />}>
      {!rows.length ? <EmptyState icon={<Wallet />} title="No customer or supplier payments this month" /> : (
        <table className="table-base">
          <thead><tr><th>Date</th><th>Party</th><th>Mode</th><th className="text-right">Amount</th><th className="w-10" /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.cancelled ? 'opacity-50' : ''}>
                <td className="text-muted">{fmtDate(r.date)}</td>
                <td><div className="font-medium">{r.party_name}</div><div className="text-xs text-muted">{r.invoice_number ? `Against ${r.invoice_number}` : r.note}{r.cancelled ? ' · cancelled' : ''}</div></td>
                <td><Badge>{r.mode}</Badge></td>
                <td className="text-right font-medium"><Money value={r.amount} tone={r.direction === 'in' ? 'in' : 'out'} /></td>
                <td>
                  {!r.cancelled && !r.invoice_id && canDo('sale.cancel') && (
                    <button title="Cancel entry" className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" onClick={async () => { try { await call('payments.cancel', { id: r.id }); toast.success('Entry cancelled'); } catch (e) { toast.error(e); } }}>
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/* ───────── transfers, owner, income, cash checks ───────── */

const MOVE_LABEL: Record<string, string> = {
  transfer: 'Cash ↔ bank', drawing: 'Owner withdrawal', capital: 'Owner added money', income: 'Other income', advance: 'Staff advance',
  advance_return: 'Advance paid back', advance_recovery: 'Advance adjusted in salary', cash_check: 'Cash count',
};

function Moves() {
  const canDo = useCan();
  const q = useApi('money.moves', { from: shiftDate(today(), -89) });
  const rows = q.data ?? [];
  return (
    <Card padded={false} title="Last 90 days">
      {!rows.length ? <EmptyState icon={<ArrowLeftRight />} title="No transfers, owner entries or cash counts yet" /> : (
        <table className="table-base" data-testid="moves-table">
          <thead><tr><th>When</th><th>What</th><th>Details</th><th className="text-right">Amount</th><th>By</th><th className="w-10" /></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={m.cancelled ? 'opacity-50' : ''}>
                <td className="whitespace-nowrap text-muted">{fmtDate(m.date)}<div className="text-[11px] text-faint">{fmtTime(m.created_at)}</div></td>
                <td className="font-medium">{MOVE_LABEL[m.kind]}{m.cancelled ? ' · cancelled' : ''}</td>
                <td className="text-muted">
                  {m.kind === 'transfer' && `${m.from_account === 'CASH' ? 'Cash → Bank' : 'Bank → Cash'}`}
                  {m.kind === 'cash_check' && (
                    <span>Expected {inr(m.expected ?? 0)} · counted {inr(m.counted ?? 0)} {m.counted === m.expected ? <Badge tone="good">matched</Badge> : <Badge tone="bad">{(m.counted ?? 0) < (m.expected ?? 0) ? 'short' : 'excess'} {inr(m.amount)}</Badge>}</span>
                  )}
                  {m.employee_name && ` ${m.employee_name}`}
                  {m.category && ` ${m.category}`}
                  {m.note && <span className="text-faint"> · {m.note}</span>}
                </td>
                <td className="text-right tnum">{m.kind === 'cash_check' ? '' : inr(m.amount)}</td>
                <td className="text-muted">{m.created_by_name ?? '—'}</td>
                <td>
                  {!m.cancelled && ['transfer', 'drawing', 'capital', 'income'].includes(m.kind) && canDo('money.move') && (
                    <button title="Cancel entry" className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" onClick={async () => { try { await call('money.cancelMove', { id: m.id }); toast.success('Entry cancelled'); } catch (e) { toast.error(e); } }}>
                      <Ban className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function MoveDialog({ kind, onClose }: { kind: 'transfer' | 'owner' | 'income'; onClose: () => void }) {
  const [dir, setDir] = useState<'deposit' | 'withdraw' | 'drawing' | 'capital'>(kind === 'transfer' ? 'deposit' : 'drawing');
  const [amount, setAmount] = useState(0);
  const [acct, setAcct] = useState<PayMode>('cash');
  const [category, setCategory] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(today());
  const act = useAction('money.move', { success: 'Recorded', onSuccess: onClose });
  const submit = () => {
    if (kind === 'transfer') act.mutate({ kind: 'transfer', amount, from: dir === 'deposit' ? 'cash' : 'bank', to: dir === 'deposit' ? 'bank' : 'cash', note, date });
    else if (kind === 'owner') act.mutate(dir === 'drawing' ? { kind: 'drawing', amount, from: acct, note, date } : { kind: 'capital', amount, to: acct, note, date });
    else act.mutate({ kind: 'income', amount, to: acct, category, note, date });
  };
  const title = kind === 'transfer' ? 'Move money between cash and bank' : kind === 'owner' ? 'Owner money' : 'Other income';
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={title} size="sm"
      description={kind === 'owner' ? 'Money the owner takes home is not an expense — it is recorded separately so profit stays correct.' : kind === 'income' ? 'Money in that is not a sale: scrap or carton sale, commission, rent received, interest.' : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={amount <= 0 || (kind === 'income' && !category.trim())} onClick={submit} data-testid="move-save">Save</Button></>}>
      <div className="space-y-3">
        {kind === 'transfer' && <Segmented value={dir} onChange={setDir} options={[{ value: 'deposit', label: 'Cash → Bank (deposit)' }, { value: 'withdraw', label: 'Bank → Cash (withdraw)' }]} />}
        {kind === 'owner' && <Segmented value={dir} onChange={setDir} options={[{ value: 'drawing', label: 'Owner took money' }, { value: 'capital', label: 'Owner added money' }]} />}
        {kind === 'income' && <Field label="What is it for"><Input autoFocus list="income-cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="e.g. Scrap / carton sale" data-testid="income-category" /><datalist id="income-cats">{['Scrap / carton sale', 'Commission', 'Rent received', 'Interest received', 'Display / scheme income from company'].map((c) => <option key={c} value={c} />)}</datalist></Field>}
        <Field label="Amount"><MoneyInput autoFocus={kind !== 'income'} value={amount} onChange={setAmount} data-testid="move-amount" /></Field>
        {kind !== 'transfer' && <Segmented size="sm" value={acct} onChange={setAcct} options={[{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'upi', label: 'UPI' }]} />}
        <div className="grid grid-cols-[1fr_150px] gap-3">
          <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={kind === 'transfer' ? 'Deposit slip no.' : 'Optional'} /></Field>
          <Field label="Date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
      </div>
    </Dialog>
  );
}

function CashCheckDialog({ onClose }: { onClose: () => void }) {
  const dash = useApi('reports.dashboard');
  const expected = dash.data?.cash ?? 0;
  const [counted, setCounted] = useState(0);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState<Record<number, string>>({});
  const DENOMS = [500, 200, 100, 50, 20, 10, 5, 2, 1];
  const fromNotes = DENOMS.reduce((s, d) => s + (Number(notes[d]) || 0) * d * 100, 0);
  const total = fromNotes || counted;
  const diff = total - expected;
  const act = useAction('money.cashCheck', { success: (r) => (r.difference === 0 ? 'Cash matches the books ✔' : `Recorded — cash ${r.difference < 0 ? 'short' : 'excess'} by ${inr(Math.abs(r.difference))}`), onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Count the cash drawer" description="Count notes and coins. Any difference is recorded so your books always match the drawer." size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={diff !== 0 && !note.trim()} onClick={() => act.mutate({ counted: total, note })} data-testid="check-save">Save count</Button></>}>
      <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
        <div className="grid grid-cols-3 gap-2">
          {DENOMS.map((d) => (
            <label key={d} className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-sm">
              <span className="w-10 text-right font-medium tnum">₹{d}</span>×
              <input className="w-full bg-transparent text-right tnum outline-none" inputMode="numeric" placeholder="0" value={notes[d] ?? ''} onChange={(e) => setNotes({ ...notes, [d]: e.target.value.replace(/\D/g, '') })} data-testid={`denom-${d}`} />
            </label>
          ))}
        </div>
        <div className="space-y-3">
          {!fromNotes && <Field label="Or total counted"><MoneyInput value={counted} onChange={setCounted} data-testid="check-total" /></Field>}
          <div className="rounded-xl bg-surface-2 p-3 text-sm">
            <div className="flex justify-between text-muted"><span>Books say</span><span className="tnum">{inr(expected)}</span></div>
            <div className="flex justify-between"><span>Counted</span><span className="font-semibold tnum">{inr(total)}</span></div>
            <div className={cn('mt-1 flex justify-between border-t border-border pt-1 font-semibold', diff === 0 ? 'text-good' : 'text-bad')}><span>{diff === 0 ? 'Matches' : diff < 0 ? 'Short' : 'Excess'}</span><span className="tnum" data-testid="check-diff">{inr(Math.abs(diff))}</span></div>
          </div>
          {diff !== 0 && <Field label="Reason *"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Change given wrongly" data-testid="check-note" /></Field>}
        </div>
      </div>
    </Dialog>
  );
}

export function PaymentDialog({ direction, party: initial, onClose }: { direction: 'in' | 'out'; party?: Party; onClose: () => void }) {
  const [party, setParty] = useState<Party | null>(initial ?? null);
  const [picking, setPicking] = useState(!initial);
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState<PayMode>('cash');
  const [ref, setRef] = useState('');
  const act = useAction('payments.receive', { success: direction === 'in' ? 'Payment received' : 'Payment recorded', onSuccess: onClose });
  const owes = party ? (direction === 'in' ? party.balance : -party.balance) : 0;
  return (
    <>
      <Dialog
        open={!picking}
        onOpenChange={(v) => !v && onClose()}
        title={direction === 'in' ? 'Receive payment' : 'Pay supplier'}
        description={party ? `${party.name}${owes > 0 ? ` · ${direction === 'in' ? 'owes you' : 'you owe'} ${inr(owes)}` : ''}` : undefined}
        footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={direction === 'in' ? 'saffron' : 'primary'} loading={act.isPending} disabled={!party || amount <= 0} onClick={() => act.mutate({ direction, partyId: party!.id, amount, mode, reference: ref || undefined })} data-testid="pay-save">Save {amount ? inr(amount) : ''}</Button></>}
      >
        <div className="space-y-3">
          <Field label="Amount"><MoneyInput autoFocus value={amount} onChange={setAmount} className="[&_input]:h-11 [&_input]:text-lg" data-testid="pay-amount" /></Field>
          {owes > 0 && <button className="text-xs font-medium text-primary hover:underline" onClick={() => setAmount(owes)}>Full balance {inr(owes)}</button>}
          <Field label="Mode"><Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }, { value: 'cheque', label: 'Cheque' }]} /></Field>
          {mode !== 'cash' && <Field label="Reference (UTR / cheque no.)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
          <button className="text-xs text-muted hover:text-ink" onClick={() => setPicking(true)}>Change {direction === 'in' ? 'customer' : 'supplier'}</button>
        </div>
      </Dialog>
      <CustomerPicker kind={direction === 'in' ? 'customer' : 'supplier'} open={picking} onOpenChange={(v) => (!v && !party ? onClose() : setPicking(v))} onPick={(p) => (setParty(p), setPicking(false))} />
    </>
  );
}

