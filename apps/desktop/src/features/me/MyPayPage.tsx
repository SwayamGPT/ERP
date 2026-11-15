import { HandCoins, Send, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Loading, MoneyInput, PageHeader } from '../../components/ui';
import { cn } from '../../lib/cn';
import { fmtDate, inr, relative } from '../../lib/format';
import { useAction, useApi } from '../../lib/useApi';

const STATUS = {
  pending: { tone: 'warn', label: 'Waiting for owner' },
  approved: { tone: 'good', label: 'Approved' },
  declined: { tone: 'bad', label: 'Declined' },
  withdrawn: { tone: 'neutral', label: 'Withdrawn' },
} as const;

/** A staff member's own view: what they've taken, what's due to them, and a way to ask for money. */
export function MyPayPage() {
  const q = useApi('staff.myPay');
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const ask = useAction('staff.request', { success: 'Request sent to the owner', onSuccess: () => (setAmount(0), setReason('')) });
  const withdraw = useAction('staff.withdrawRequest', { success: 'Request withdrawn' });
  if (q.error) {
    // Not every login is a staff member (e.g. the owner, or a login not linked to an employee yet).
    return (
      <div className="animate-slide-up">
        <PageHeader icon={<Wallet className="h-5 w-5" />} title="My pay" />
        <Card>
          <p className="text-sm" data-testid="mypay-none">This page shows a staff member's own salary, advances and money requests.</p>
          <p className="mt-1 text-sm text-muted">Your login isn't linked to a staff record. The owner can link it from <b>Staff & salary</b> → the staff member → login. Salaries for everyone are under Staff & salary.</p>
        </Card>
      </div>
    );
  }
  if (!q.data) return <Loading />;
  const d = q.data;
  const pending = d.requests.find((r) => r.status === 'pending');
  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader icon={<Wallet className="h-5 w-5" />} title={`My pay · ${d.name}`} subtitle="Only you and the owner can see this." />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><div className="text-xs text-muted">Monthly salary</div><div className="mt-1 text-2xl font-semibold tnum">{inr(d.monthlySalary, false)}</div></Card>
        <Card><div className="text-xs text-muted">Taken before payday</div><div className="mt-1 text-2xl font-semibold tnum text-saffron-ink" data-testid="my-advance">{inr(d.advance, false)}</div><div className="text-xs text-muted">Adjusted when salary is paid</div></Card>
        <Card><div className="text-xs text-muted">Salary / bonus still due to you</div><div className="mt-1 text-2xl font-semibold tnum">{inr(d.salaryDue, false)}</div>{d.lastPaid && <div className="text-xs text-muted">Last paid {fmtDate(d.lastPaid)}</div>}</Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-[420px_1fr]">
        <Card title={<span className="flex items-center gap-2"><HandCoins className="h-4 w-4" /> Ask for money</span>}>
          {pending ? (
            <div className="space-y-3 text-sm">
              <p>You asked for <b className="tnum">{inr(pending.amount)}</b> ({pending.reason}) {relative(pending.requested_at).toLowerCase()}. The owner will see it when they unlock Hisaab.</p>
              <Button variant="ghost" onClick={() => withdraw.mutate({ id: pending.id })} loading={withdraw.isPending} data-testid="request-withdraw">Withdraw request</Button>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="How much"><MoneyInput autoFocus value={amount} onChange={setAmount} className="[&_input]:h-11 [&_input]:text-lg" data-testid="request-amount" /></Field>
              <div className="flex flex-wrap gap-1.5">
                {[200, 500, 1000, 2000].map((n) => <button key={n} type="button" onClick={() => setAmount(n * 100)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">₹{n.toLocaleString('en-IN')}</button>)}
              </div>
              <Field label="What is it for"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Medical, school fees, travel home" list="reasons" data-testid="request-reason" /></Field>
              <datalist id="reasons">{['Medical', 'School fees', 'Travel home', 'Festival', 'Rent', 'Family function'].map((r) => <option key={r} value={r} />)}</datalist>
              <Button variant="primary" icon={<Send className="h-4 w-4" />} className="w-full" disabled={amount <= 0 || !reason.trim()} loading={ask.isPending} onClick={() => ask.mutate({ amount, reason })} data-testid="request-send">Send request</Button>
            </div>
          )}
        </Card>
        <Card title="My requests & payments" padded={false}>
          {!d.requests.length && !d.timeline.length ? <p className="px-4 py-6 text-sm text-muted">Nothing yet.</p> : (
            <ul className="divide-y divide-border" data-testid="my-requests">
              {d.requests.map((r) => (
                <li key={`r${r.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                  <span><span className="text-muted">{fmtDate(r.requested_at)}</span> · Asked <b className="tnum">{inr(r.amount)}</b> — {r.reason}{r.decision_note ? <span className="text-muted"> · “{r.decision_note}”</span> : ''}</span>
                  <span className="flex items-center gap-2">
                    {r.status === 'approved' && r.paid_amount !== r.amount && <span className="text-xs text-muted">got {inr(r.paid_amount ?? 0)}</span>}
                    <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  </span>
                </li>
              ))}
              {d.timeline.filter((t) => !t.kind.startsWith('request_')).map((t, i) => (
                <li key={`t${i}`} className={cn('flex items-center justify-between px-4 py-2.5 text-sm', t.cancelled && 'line-through opacity-50')}>
                  <span><span className="text-muted">{fmtDate(t.date)}</span> · {({ salary: 'Salary', salary_paid: 'Salary paid', bonus: 'Bonus', bonus_paid: 'Bonus paid', advance: 'Money given', advance_return: 'Paid back', advance_recovery: 'Adjusted from salary' } as Record<string, string>)[t.kind] ?? t.kind}{t.note && !/^\d{4}-\d{2}$/.test(t.note) ? <span className="text-muted"> · {t.note}</span> : ''}</span>
                  <span className="font-medium tnum">{inr(t.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
