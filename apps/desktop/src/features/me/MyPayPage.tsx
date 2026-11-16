import { CalendarDays, ChevronDown, HandCoins, Printer, Send, TrendingUp, UserRound, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Loading, MoneyInput, PageHeader } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtDate, inr, relative } from '../../lib/format';
import { useAction, useApi } from '../../lib/useApi';
import { printStaffReceipt } from '../staff/StaffReceiptDoc';

const STATUS = {
  pending: { tone: 'warn', label: 'Waiting for owner' },
  approved: { tone: 'good', label: 'Approved' },
  declined: { tone: 'bad', label: 'Declined' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
} as const;

const HOW: Record<string, string> = { cash: 'Cash', upi: 'UPI', bank: 'Bank', card: 'Card', cheque: 'Cheque', advance: 'Adjusted from advance' };
const monthName = (p: string) => new Date(`${p}-01T00:00:00`).toLocaleString('en-IN', { month: 'long', year: 'numeric' });

/**
 * A staff member's own page (desktop and phone): their salary month by month — how it was worked
 * out, what was paid and when, what is still due — money taken before payday, this month's
 * incentive, the year so far, their receipts to print, and a way to ask for money.
 * Only they and the owner can see it.
 */
export function MyPayPage({ compact = false }: { compact?: boolean }) {
  const q = useApi('staff.myPay');
  if (q.error) {
    // Not every login is a staff member (e.g. the owner, or a login not linked to an employee yet).
    return (
      <div className="animate-slide-up">
        {!compact && <PageHeader icon={<Wallet className="h-5 w-5" />} title="My pay" />}
        <Card>
          <p className="text-sm" data-testid="mypay-none">This page shows a staff member's own salary, advances and money requests.</p>
          <p className="mt-1 text-sm text-muted">Your login isn't linked to a staff record. The owner can link it from <b>Staff & salary</b> → the staff member → login. Salaries for everyone are under Staff & salary.</p>
        </Card>
      </div>
    );
  }
  if (!q.data) return <Loading />;
  const d = q.data;
  return (
    <div className="animate-slide-up space-y-4" data-testid="mypay">
      {!compact && <PageHeader icon={<Wallet className="h-5 w-5" />} title={`My pay · ${d.name}`} subtitle="Only you and the owner can see this." />}
      <div className={cn('grid gap-3', compact ? 'grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-4')}>
        <Tile label="Monthly salary" value={inr(d.monthlySalary, false)} />
        <Tile label="Still due to you" value={inr(d.salaryDue, false)} tone={d.salaryDue > 0 ? 'good' : undefined} sub={d.lastPaid ? `Last paid ${fmtDate(d.lastPaid)}` : undefined} testId="my-due" />
        <Tile label="Taken before payday" value={inr(d.advance, false)} tone="saffron" sub="Adjusted when salary is paid" testId="my-advance" />
        {d.thisMonth.incentivePct > 0 ? (
          <Tile label={`Incentive so far · ${monthName(d.thisMonth.period).split(' ')[0]}`} value={inr(d.thisMonth.incentiveSoFar, false)} sub={`${d.thisMonth.incentivePct}% of ${inr(d.thisMonth.salesServed, false)} sales you served`} testId="my-incentive" />
        ) : (
          <Tile label="Received this year" value={inr(d.year.received, false)} sub={`Since ${fmtDate(d.year.from)}`} />
        )}
      </div>

      <div className={cn('grid gap-4', !compact && 'lg:grid-cols-[1fr_380px]')}>
        <div className="space-y-4">
          <Card title={<span className="flex items-center gap-2"><CalendarDays className="h-4 w-4" /> My salary, month by month</span>} padded={false}>
            {!d.months.length ? <p className="px-4 py-6 text-sm text-muted">No salary yet. It shows here once the owner runs the month's salary.</p> : (
              <ul className="divide-y divide-border" data-testid="my-months">
                {d.months.map((m, i) => <Month key={m.id} m={m} open={i === 0} />)}
              </ul>
            )}
          </Card>

          <Card title={<span className="flex items-center gap-2"><HandCoins className="h-4 w-4" /> Money taken before payday</span>} padded={false}>
            {!d.money.length ? <p className="px-4 py-6 text-sm text-muted">Nothing taken.</p> : (
              <ul className="divide-y divide-border" data-testid="my-money">
                {d.money.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                    <span><span className="text-muted">{fmtDate(m.date)}</span> · {m.kind === 'advance' ? 'Taken' : 'Paid back'}{m.note ? <span className="text-muted"> · {m.note}</span> : ''}{m.mode ? <span className="text-xs text-faint"> · {HOW[m.mode] ?? m.mode}</span> : ''}</span>
                    <span className="flex items-center gap-2">
                      <b className={cn('tnum', m.kind === 'advance' ? 'text-saffron-ink' : 'text-good')}>{inr(m.amount)}</b>
                      <ReceiptButton k={m.receipt} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <AskForMoney requests={d.requests} />
          <Card title={<span className="flex items-center gap-2"><TrendingUp className="h-4 w-4" /> This year</span>}>
            <dl className="space-y-1.5 text-sm" data-testid="my-year">
              <Row k={`Salary & bonus earned since ${fmtDate(d.year.from)}`} v={inr(d.year.earned)} />
              <Row k="Received in hand / bank" v={inr(d.year.received)} />
              <Row k="Adjusted from money taken" v={inr(d.year.adjusted)} />
              <Row k="Money taken before payday" v={inr(d.year.taken)} />
            </dl>
          </Card>
          <Card title={<span className="flex items-center gap-2"><UserRound className="h-4 w-4" /> My details</span>}>
            <dl className="space-y-1.5 text-sm">
              {d.profile.designation && <Row k="Work" v={d.profile.designation} />}
              {d.profile.joinedOn && <Row k="Joined" v={fmtDate(d.profile.joinedOn)} />}
              <Row k="Paid by" v={HOW[d.profile.payMode] ?? d.profile.payMode} />
              {d.profile.bankAccount && <Row k="Bank account" v={d.profile.bankAccount} />}
              {d.profile.incentivePct > 0 && <Row k="Incentive" v={`${d.profile.incentivePct}% of sales you serve`} />}
              {d.profile.phone && <Row k="Phone" v={d.profile.phone} />}
            </dl>
            <p className="mt-2 text-xs text-muted">Something wrong? Tell the owner — only they can change these.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

type Months = NonNullable<ReturnType<typeof useApi<'staff.myPay'>>['data']>['months'];

function Month({ m, open: initial }: { m: Months[number]; open: boolean }) {
  const [open, setOpen] = useState(initial);
  const status = m.due === 0 ? { tone: 'good', label: 'Paid in full' } : m.paid > 0 ? { tone: 'warn', label: `Part paid · ${inr(m.due)} due` } : { tone: 'neutral', label: 'Not paid yet' };
  const w = m.working;
  return (
    <li data-testid="my-month">
      <button className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-surface-2" onClick={() => setOpen(!open)}>
        <span className="min-w-0">
          <b>{m.kind === 'bonus' ? m.title : m.period ? monthName(m.period) : m.title}</b>
          <span className="ml-2"><Badge tone={status.tone as 'good'}>{status.label}</Badge></span>
        </span>
        <span className="flex items-center gap-2"><b className="tnum">{inr(m.amount)}</b><ChevronDown className={cn('h-4 w-4 text-muted transition', open && 'rotate-180')} /></span>
      </button>
      {open && (
        <div className="space-y-2 bg-surface-2/50 px-4 pb-3 pt-1 text-sm">
          {w && (
            <dl className="space-y-1">
              <Row k="Monthly salary" v={inr(w.monthly)} />
              {w.paidDays !== w.daysInMonth && <Row k="Days worked" v={`${w.paidDays} of ${w.daysInMonth}`} />}
              {w.paidDays !== w.daysInMonth && <Row k="Salary for the days worked" v={inr(Math.round((w.monthly * w.paidDays) / w.daysInMonth))} />}
              {w.incentive > 0 && <Row k="Incentive" v={`+ ${inr(w.incentive)}`} />}
              {w.bonus > 0 && <Row k="Bonus" v={`+ ${inr(w.bonus)}`} />}
              {w.deduction > 0 && <Row k="Deduction" v={`− ${inr(w.deduction)}`} />}
              <Row k={<b>Total</b>} v={<b>{inr(m.amount)}</b>} />
            </dl>
          )}
          <div className="rounded-lg border border-border bg-surface">
            {!m.payments.length ? <p className="px-3 py-2 text-muted">Nothing paid yet.</p> : m.payments.map((p, i) => (
              <div key={i} className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 last:border-0">
                <span><span className="text-muted">{fmtDate(p.date)}</span> · {HOW[p.how] ?? p.how}</span>
                <span className="flex items-center gap-2"><span className="tnum">{inr(p.amount)}</span><ReceiptButton k={p.receipt} /></span>
              </div>
            ))}
            <div className="flex justify-between px-3 py-1.5 font-medium"><span>Paid so far</span><span className="tnum">{inr(m.paid)}</span></div>
            {m.due > 0 && <div className="flex justify-between px-3 pb-1.5 font-semibold text-good"><span>Still due to you</span><span className="tnum">{inr(m.due)}</span></div>}
          </div>
        </div>
      )}
    </li>
  );
}

function ReceiptButton({ k }: { k: { kind: 'pay' | 'move'; id: number } }) {
  return (
    <button className="grid h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" title="Print / save receipt" onClick={() => void printStaffReceipt(k)} data-testid="my-receipt">
      <Printer className="h-3.5 w-3.5" />
    </button>
  );
}

function Tile({ label, value, sub, tone, testId }: { label: string; value: string; sub?: string; tone?: 'good' | 'saffron'; testId?: string }) {
  return (
    <Card>
      <div className="text-xs text-muted">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tnum', tone === 'good' && 'text-good', tone === 'saffron' && 'text-saffron-ink')} data-testid={testId}>{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </Card>
  );
}

const Row = ({ k, v }: { k: React.ReactNode; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right tnum">{v}</dd></div>
);

type Requests = NonNullable<ReturnType<typeof useApi<'staff.myPay'>>['data']>['requests'];

function AskForMoney({ requests }: { requests: Requests }) {
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const ask = useAction('staff.request', { success: 'Request sent to the owner', onSuccess: () => (setAmount(0), setReason('')) });
  const withdraw = useAction('staff.withdrawRequest', { success: 'Request withdrawn' });
  const pending = requests.find((r) => r.status === 'pending');
  return (
    <Card title={<span className="flex items-center gap-2"><HandCoins className="h-4 w-4" /> Ask for money</span>}>
      {pending ? (
        <div className="space-y-3 text-sm">
          <p>You asked for <b className="tnum">{inr(pending.amount)}</b> ({pending.reason}) {relative(pending.requested_at).toLowerCase()}. The owner will see it when they unlock Hisaab.</p>
          <Button variant="ghost" onClick={() => withdraw.mutate({ id: pending.id })} loading={withdraw.isPending} data-testid="request-withdraw">Withdraw request</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="How much"><MoneyInput value={amount} onChange={setAmount} className="[&_input]:h-11 [&_input]:text-lg" data-testid="request-amount" /></Field>
          <div className="flex flex-wrap gap-1.5">
            {[200, 500, 1000, 2000].map((n) => <button key={n} type="button" onClick={() => setAmount(n * 100)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">₹{n.toLocaleString('en-IN')}</button>)}
          </div>
          <Field label="What is it for"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medical, school fees, travel home" list="reasons" data-testid="request-reason" /></Field>
          <datalist id="reasons">{['Medical', 'School fees', 'Travel home', 'Festival', 'Rent', 'Family function'].map((r) => <option key={r} value={r} />)}</datalist>
          <Button variant="primary" icon={<Send className="h-4 w-4" />} className="w-full" disabled={amount <= 0 || !reason.trim()} loading={ask.isPending} onClick={() => ask.mutate({ amount, reason })} data-testid="request-send">Send request</Button>
        </div>
      )}
      {requests.length > 0 && (
        <ul className="mt-3 divide-y divide-border border-t border-border text-sm" data-testid="my-requests">
          {requests.slice(0, 8).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 py-2">
              <span><span className="text-muted">{fmtDate(r.requested_at)}</span> · <b className="tnum">{inr(r.amount)}</b> {r.reason}{r.decision_note ? <span className="text-muted"> · “{r.decision_note}”</span> : ''}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                {r.status === 'approved' && r.paid_amount !== r.amount && <span className="text-xs text-muted">got {inr(r.paid_amount ?? 0)}</span>}
                <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
