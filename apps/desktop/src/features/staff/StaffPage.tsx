import { isMobile } from '@hisaab/core';
import { BadgeIndianRupee, CalendarCheck, Check, Gift, HandCoins, MessageSquareText, Pencil, Plus, Send, UserRound, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Drawer, EmptyState, Field, Input, Loading, MoneyInput, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import { relative } from '../../lib/format';
import type { PayMode } from '../../db/types';
import type { Employee, SalaryRow, StaffRequest } from '../../db/repos/staff';
import { cn } from '../../lib/cn';
import { fmtDate, inr, prevMonth, thisMonth } from '../../lib/format';
import { whatsappLink } from '../../lib/share';
import { useAction, useApi } from '../../lib/useApi';
import { PayExpenseDialog } from '../expenses/ExpenseDialog';

const monthName = (p: string) => new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' }).format(new Date(`${p}-01T00:00:00`));

export function StaffPage() {
  const list = useApi('staff.list', { includeInactive: true });
  const [edit, setEdit] = useState<Employee | 'new' | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [advance, setAdvance] = useState<Employee | null>(null);
  const [run, setRun] = useState(false);
  const [bonus, setBonus] = useState<number[] | null>(null);
  const rows = list.data ?? [];
  const active = rows.filter((r) => r.active);
  const payroll = active.reduce((s, r) => s + r.monthly_salary, 0);
  const due = rows.reduce((s, r) => s + r.salary_due, 0);
  const adv = rows.reduce((s, r) => s + r.advance, 0);

  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader
        icon={<Users className="h-5 w-5" />}
        title="Staff & salary"
        subtitle="Employees, monthly salary, advances — every payment lands in your cash book automatically."
        actions={
          <>
            <Button variant="outline" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')} data-testid="staff-new">Add employee</Button>
            <Button variant="outline" icon={<Gift className="h-4 w-4" />} onClick={() => setBonus(active.map((a) => a.id))} disabled={!active.length} data-testid="bonus-open">Festival bonus</Button>
            <Button variant="primary" icon={<CalendarCheck className="h-4 w-4" />} onClick={() => setRun(true)} disabled={!active.length} data-testid="salary-run">Run salary</Button>
          </>
        }
      />
      <Requests />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><div className="text-xs text-muted">People</div><div className="mt-1 text-2xl font-semibold">{active.length}</div></Card>
        <Card><div className="text-xs text-muted">Monthly salary bill</div><div className="mt-1 text-2xl font-semibold tnum">{inr(payroll, false)}</div></Card>
        <Card><div className="text-xs text-muted">Salary still to pay</div><div className={cn('mt-1 text-2xl font-semibold tnum', due > 0 && 'text-bad')}>{inr(due, false)}</div></Card>
        <Card><div className="text-xs text-muted">Advances given (to recover)</div><div className="mt-1 text-2xl font-semibold tnum text-saffron-ink">{inr(adv, false)}</div></Card>
      </div>
      <Card padded={false}>
        {list.isLoading ? <Loading /> : !rows.length ? (
          <EmptyState icon={<UserRound />} title="No employees yet" body="Add your staff with their monthly salary. Then run salary each month in one go." action={<Button variant="primary" onClick={() => setEdit('new')}>Add employee</Button>} />
        ) : (
          <table className="table-base" data-testid="staff-table">
            <thead><tr><th>Name</th><th>Role</th><th className="text-right">Monthly salary</th><th className="text-right">Advance</th><th className="text-right">Salary due</th><th>Last paid</th><th /></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={cn('cursor-pointer', !e.active && 'opacity-50')} onClick={() => setOpen(e.id)}>
                  <td><div className="font-medium">{e.name}{e.user_name && <Badge className="ml-2">login: {e.user_name}</Badge>}</div><div className="text-xs text-muted">{[e.phone, e.incentive_pct ? `${e.incentive_pct}% incentive on sales` : null].filter(Boolean).join(' · ')}</div></td>
                  <td className="text-muted">{e.designation ?? '—'}{!e.active && <Badge className="ml-2">left</Badge>}</td>
                  <td className="text-right tnum">{inr(e.monthly_salary, false)}</td>
                  <td className="text-right tnum">
                    {e.advance ? <span className="text-saffron-ink">{inr(e.advance)}</span> : '—'}
                    {!!e.taken_this_month && <div className="text-[11px] text-muted">taken this month {inr(e.taken_this_month, false)}</div>}
                  </td>
                  <td className="text-right tnum">{e.salary_due ? <b className="text-bad">{inr(e.salary_due)}</b> : '—'}</td>
                  <td className="text-muted">{e.last_paid ? fmtDate(e.last_paid) : '—'}</td>
                  <td className="text-right" onClick={(x) => x.stopPropagation()}>
                    {!!e.active && <Button size="sm" variant="ghost" icon={<HandCoins className="h-3.5 w-3.5" />} onClick={() => setAdvance(e)} data-testid="give-money">Give money</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {edit && <EmployeeDialog initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {advance && <AdvanceDialog employee={advance} onClose={() => setAdvance(null)} />}
      {run && <SalaryRun onClose={() => setRun(false)} />}
      {bonus && <BonusDialog employees={active} preselect={bonus} onClose={() => setBonus(null)} />}
      {open && <EmployeeDrawer id={open} onClose={() => setOpen(null)} onEdit={(e) => (setOpen(null), setEdit(e))} onAdvance={(e) => setAdvance(e)} onBonus={(id) => setBonus([id])} />}
    </div>
  );
}

function EmployeeDialog({ initial, onClose }: { initial: Employee | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? '', phone: initial?.phone ?? '', designation: initial?.designation ?? '', monthlySalary: initial?.monthly_salary ?? 0, joinedOn: initial?.joined_on ?? '',
    payMode: (initial?.pay_mode ?? 'cash') as PayMode, bankAccount: initial?.bank_account ?? '', bankIfsc: initial?.bank_ifsc ?? '', active: initial ? !!initial.active : true,
    incentivePct: initial?.incentive_pct ?? 0, login: (initial?.user_id ? 'link' : 'none') as 'none' | 'link' | 'new', userId: initial?.user_id ?? 0, newLoginPin: '',
  });
  const users = useApi('users.list');
  const linkable = (users.data ?? []).filter((u) => u.role !== 'owner' && u.active);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useAction('staff.save', { success: initial ? 'Saved' : `${f.name} added`, onSuccess: onClose });
  const phoneErr = f.phone && !isMobile(f.phone) ? 'Enter a 10-digit mobile' : null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={initial ? `Edit ${initial.name}` : 'Add employee'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !!phoneErr} onClick={() => save.mutate({
        id: initial?.id, name: f.name, phone: f.phone, designation: f.designation, monthlySalary: f.monthlySalary, joinedOn: f.joinedOn, payMode: f.payMode,
        bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, active: f.active, incentivePct: f.incentivePct,
        userId: f.login === 'link' ? f.userId || null : null, newLoginPin: f.login === 'new' ? f.newLoginPin : null,
      })} data-testid="staff-save">Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name *"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="staff-name" /></Field>
        <Field label="Mobile" error={phoneErr}><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Role"><Input value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Counter, helper, delivery…" /></Field>
        <Field label="Monthly salary *"><MoneyInput value={f.monthlySalary} onChange={(v) => set('monthlySalary', v)} data-testid="staff-salary" /></Field>
        <Field label="Joined on"><Input type="date" value={f.joinedOn} onChange={(e) => set('joinedOn', e.target.value)} /></Field>
        <Field label="Usually paid by"><Select value={f.payMode} onChange={(e) => set('payMode', e.target.value as PayMode)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option></Select></Field>
        {f.payMode === 'bank' && (<><Field label="Bank account"><Input value={f.bankAccount} onChange={(e) => set('bankAccount', e.target.value.replace(/\D/g, ''))} /></Field><Field label="IFSC"><Input value={f.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} /></Field></>)}
        <Field label="Incentive on sales served" hint="Optional. % of the bills they serve (before GST), added at salary time.">
          <Input value={f.incentivePct || ''} onChange={(e) => set('incentivePct', Math.min(20, Number(e.target.value.replace(/[^\d.]/g, '')) || 0))} suffix="%" placeholder="0" inputMode="decimal" data-testid="staff-incentive" />
        </Field>
        <div className="sm:col-span-2 rounded-xl border border-border p-3">
          <span className="label">Staff login (to ask for money from their own PIN)</span>
          <Segmented size="sm" value={f.login} onChange={(v) => set('login', v)} options={[{ value: 'none', label: 'No login' }, { value: 'link', label: 'Use an existing login' }, { value: 'new', label: 'Create a cashier PIN' }]} />
          {f.login === 'link' && (
            <Select className="mt-2" value={f.userId} onChange={(e) => set('userId', Number(e.target.value))} data-testid="staff-login">
              <option value={0}>Pick a login…</option>
              {linkable.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </Select>
          )}
          {f.login === 'new' && <Input className="mt-2" type="password" inputMode="numeric" placeholder="4-digit PIN" maxLength={4} value={f.newLoginPin} onChange={(e) => set('newLoginPin', e.target.value.replace(/\D/g, '').slice(0, 4))} />}
        </div>
        {initial && <div className="sm:col-span-2"><Switch checked={f.active} onChange={(v) => set('active', v)} label="Still working here" hint="Turn off when someone leaves — their history stays." /></div>}
      </div>
    </Dialog>
  );
}

function AdvanceDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const [direction, setDirection] = useState<'give' | 'return'>('give');
  const [amount, setAmount] = useState(0);
  const [mode, setMode] = useState<PayMode>('cash');
  const [note, setNote] = useState('');
  const act = useAction('staff.advance', { success: direction === 'give' ? 'Advance recorded' : 'Repayment recorded', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Give money · ${employee.name}`} description={employee.advance ? `${inr(employee.advance)} already taken before payday — you decide how much to adjust at salary time.` : 'An advance or a small amount on request. You decide how much to adjust at salary time.'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={amount <= 0} onClick={() => act.mutate({ employeeId: employee.id, amount, mode, direction, note })} data-testid="advance-save">Save</Button></>}>
      <div className="space-y-3">
        <Segmented value={direction} onChange={setDirection} options={[{ value: 'give', label: 'Give money' }, { value: 'return', label: 'They paid back' }]} />
        {direction === 'give' && (
          <div className="flex flex-wrap gap-1.5">
            {[200, 500, 1000, 2000, 5000].map((n) => <button key={n} type="button" onClick={() => setAmount(n * 100)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:border-primary hover:text-primary">₹{n.toLocaleString('en-IN')}</button>)}
          </div>
        )}
        <Field label="Amount"><MoneyInput autoFocus value={amount} onChange={setAmount} data-testid="advance-amount" /></Field>
        <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} />
        <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Diwali advance" /></Field>
      </div>
    </Dialog>
  );
}

function SalaryRun({ onClose }: { onClose: () => void }) {
  const [period, setPeriod] = useState(new Date().getDate() <= 10 ? prevMonth() : thisMonth());
  const preview = useApi('staff.salaryPreview', { period });
  const [rows, setRows] = useState<SalaryRow[]>([]);
  useEffect(() => setRows(preview.data ?? []), [preview.data]);
  const act = useAction('staff.runSalary', { success: (ids) => (ids.length ? `${ids.length} salary bills created for ${monthName(period)}` : 'Nothing new to create'), onSuccess: onClose });
  const calc = (r: SalaryRow) => Math.max(0, Math.round((r.monthlySalary * r.paidDays) / r.daysInMonth) + r.incentive + r.bonus - r.deduction);
  const fresh = rows.filter((r) => !r.existing);
  const total = fresh.reduce((s, r) => s + calc(r), 0);
  const upd = (i: number, p: Partial<SalaryRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} size="xl" title="Run salary" description="Days worked, bonus and deductions for each person. This creates their salary bills — pay them now or later from Bills to pay."
      footer={<><span className="mr-auto text-sm text-muted">{fresh.length} people · <b className="text-ink tnum">{inr(total)}</b></span><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={act.isPending} disabled={!fresh.length} onClick={() => act.mutate({ period, rows: fresh.map((r) => ({ employeeId: r.employeeId, paidDays: r.paidDays, bonus: r.bonus, deduction: r.deduction, incentive: r.incentive })) })} data-testid="salary-create">Create salary bills</Button></>}>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm text-muted">Month</span>
        <Input type="month" value={period} max={thisMonth()} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-48" data-testid="salary-month" />
      </div>
      {!preview.data ? <Loading /> : (
        <table className="table-base">
          <thead><tr><th>Employee</th><th className="text-right">Monthly</th><th className="text-right">Days worked</th><th className="text-right">Incentive</th><th className="text-right">Bonus / OT</th><th className="text-right">Deduction</th><th className="text-right">Salary</th><th className="text-right">Advance</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.employeeId}>
                <td><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.designation}</div></td>
                <td className="text-right tnum text-muted">{inr(r.monthlySalary, false)}</td>
                {r.existing ? (
                  <td colSpan={5} className="text-right"><Badge tone={r.existing.status === 'paid' ? 'good' : 'warn'}>Already created · {inr(r.existing.amount)} · {r.existing.status === 'paid' ? 'paid' : 'unpaid'}</Badge></td>
                ) : (
                  <>
                    <td className="text-right"><input className="input h-8 w-16 text-right" inputMode="numeric" value={r.paidDays} onChange={(e) => upd(i, { paidDays: Math.max(0, Math.min(r.daysInMonth, Number(e.target.value.replace(/\D/g, '')) || 0)) })} /> <span className="text-xs text-muted">/ {r.daysInMonth}</span></td>
                    <td className="text-right">
                      {r.incentivePct > 0 ? (
                        <>
                          <MoneyInput className="ml-auto w-28" value={r.incentive} onChange={(v) => upd(i, { incentive: v })} data-testid="salary-incentive" />
                          <div className="mt-0.5 text-[10px] text-muted">{r.incentivePct}% of {inr(r.salesServed, false)} sales</div>
                        </>
                      ) : <span className="text-faint">—</span>}
                    </td>
                    <td className="text-right"><MoneyInput className="ml-auto w-28" value={r.bonus} onChange={(v) => upd(i, { bonus: v })} /></td>
                    <td className="text-right"><MoneyInput className="ml-auto w-28" value={r.deduction} onChange={(v) => upd(i, { deduction: v })} /></td>
                    <td className="text-right font-semibold tnum">{inr(calc(r))}</td>
                  </>
                )}
                <td className="text-right tnum text-saffron-ink">{r.advance ? inr(r.advance) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-3 text-xs text-muted">Salary = monthly × days worked ÷ days in month + incentive + bonus − deduction. Money taken before payday is adjusted when you pay — you decide how much.</p>
    </Dialog>
  );
}

const KIND: Record<string, { label: string; sign: 1 | -1 | 0 }> = {
  salary: { label: 'Salary for', sign: 0 },
  salary_paid: { label: 'Salary paid', sign: -1 },
  bonus: { label: 'Bonus', sign: 0 },
  bonus_paid: { label: 'Bonus paid', sign: -1 },
  request_pending: { label: 'Asked for money', sign: 0 },
  request_approved: { label: 'Asked for money · approved', sign: 0 },
  request_declined: { label: 'Asked for money · declined', sign: 0 },
  request_withdrawn: { label: 'Asked for money · withdrawn', sign: 0 },
  advance: { label: 'Money given before payday', sign: -1 },
  advance_return: { label: 'Advance paid back', sign: 1 },
  advance_recovery: { label: 'Advance adjusted in salary', sign: 0 },
};

function EmployeeDrawer({ id, onClose, onEdit, onAdvance, onBonus }: { id: number; onClose: () => void; onEdit: (e: Employee) => void; onAdvance: (e: Employee) => void; onBonus: (id: number) => void }) {
  const q = useApi('staff.get', { id });
  const bills = useApi('expenses.list', { employeeId: id, status: 'due' });
  const company = useApi('app.status').data?.company;
  const [pay, setPay] = useState<NonNullable<typeof bills.data>[number] | null>(null);
  const e = q.data;
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title={e?.name ?? 'Employee'} width="max-w-xl"
      footer={e ? (<><Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(e)}>Edit</Button><Button variant="outline" icon={<Gift className="h-4 w-4" />} onClick={() => onBonus(e.id)}>Bonus</Button><Button variant="outline" icon={<HandCoins className="h-4 w-4" />} onClick={() => onAdvance(e)}>Give money</Button></>) : undefined}>
      {!e ? <Loading /> : (
        <div className="space-y-5 text-sm">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Monthly</div><div className="text-lg font-semibold tnum">{inr(e.monthly_salary, false)}</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Salary due</div><div className={cn('text-lg font-semibold tnum', e.salary_due > 0 && 'text-bad')}>{inr(e.salary_due, false)}</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Advance</div><div className="text-lg font-semibold tnum text-saffron-ink">{inr(e.advance, false)}</div></div>
          </div>
          {!!bills.data?.length && (
            <div>
              <h4 className="mb-2 font-semibold">Unpaid salary & bonus</h4>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {bills.data.map((b) => (
                  <li key={b.id} className="flex items-center justify-between px-3 py-2">
                    <span>{b.description}</span>
                    <span className="flex items-center gap-3"><b className="tnum">{inr(b.amount - b.paid)}</b><Button size="sm" variant="primary" icon={<BadgeIndianRupee className="h-3.5 w-3.5" />} onClick={() => setPay(b)} data-testid="salary-pay">Pay</Button></span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <h4 className="mb-2 font-semibold">History</h4>
            {!e.timeline.length ? <p className="text-muted">Nothing yet.</p> : (
              <ul className="divide-y divide-border rounded-xl border border-border" data-testid="staff-timeline">
                {e.timeline.map((t, i) => (
                  <li key={i} className={cn('flex items-center justify-between px-3 py-2', t.cancelled && 'line-through opacity-50')}>
                    <span>
                      <span className="text-muted">{fmtDate(t.date)}</span> · {KIND[t.kind]?.label ?? t.kind} {(t.kind === 'salary' || t.kind === 'salary_paid') && t.note && /^\d{4}-\d{2}$/.test(t.note) ? <b>{monthName(t.note)}</b> : t.note && <span className="text-muted">{t.note}</span>}
                      {t.mode && t.kind !== 'advance_recovery' && <span className="text-xs text-faint"> · {t.mode}</span>}
                    </span>
                    <span className="flex items-center gap-2">
                      {t.kind === 'salary' && !t.cancelled && e.phone && company && t.note && /^\d{4}-\d{2}$/.test(t.note) && (
                        <a className="text-good" title="Send salary slip on WhatsApp" target="_blank" rel="noreferrer" data-testid="salary-slip"
                          href={whatsappLink(e.phone, salarySlip(company.name, e.name, monthName(t.note), t.amount, e.advance))}>
                          <Send className="h-3.5 w-3.5" />
                        </a>
                      )}
                      <span className={cn('font-medium tnum', KIND[t.kind]?.sign === -1 && 'text-bad', KIND[t.kind]?.sign === 1 && 'text-good')}>{inr(t.amount)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {e.phone && company && (
            <a className="inline-flex items-center gap-2 text-sm font-medium text-good hover:underline" target="_blank" rel="noreferrer"
              href={whatsappLink(e.phone, `Namaste ${e.name}, salary summary from ${company.name}: salary due ${inr(e.salary_due)}, advance outstanding ${inr(e.advance)}.`)}>
              <Send className="h-4 w-4" /> Send summary on WhatsApp
            </a>
          )}
          {pay && <PayExpenseDialog expense={{ ...pay, employee_id: id }} advance={e.advance} onClose={() => setPay(null)} />}
        </div>
      )}
    </Drawer>
  );
}

/* ───────── money requests from staff ───────── */

function Requests() {
  const q = useApi('staff.requests', { status: 'pending' });
  const [deciding, setDeciding] = useState<{ r: StaffRequest; approve: boolean } | null>(null);
  if (!q.data?.length) return null;
  return (
    <Card padded={false} className="border-saffron/40" title={<span className="flex items-center gap-2"><MessageSquareText className="h-4 w-4 text-saffron-ink" /> Money requests from staff <Badge tone="saffron">{q.data.length}</Badge></span>}>
      <ul className="divide-y divide-border" data-testid="staff-requests">
        {q.data.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-saffron-soft text-sm font-semibold text-saffron-ink">{r.employee_name[0]}</span>
            <div className="min-w-0 flex-1">
              <div className="text-sm"><b>{r.employee_name}</b> asked for <b className="tnum">{inr(r.amount)}</b> · <span className="text-muted">{r.reason}</span></div>
              <div className="text-xs text-muted">{relative(r.requested_at)} · salary {inr(r.monthly_salary ?? 0, false)}/month · already taken {inr(r.advance ?? 0, false)}{r.salary_due ? ` · salary due ${inr(r.salary_due, false)}` : ''}</div>
            </div>
            <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setDeciding({ r, approve: false })} data-testid="request-decline">Decline</Button>
            <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} onClick={() => setDeciding({ r, approve: true })} data-testid="request-approve">Approve & pay</Button>
          </li>
        ))}
      </ul>
      {deciding && <DecideDialog r={deciding.r} approve={deciding.approve} onClose={() => setDeciding(null)} />}
    </Card>
  );
}

function DecideDialog({ r, approve, onClose }: { r: StaffRequest; approve: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState(r.amount);
  const [mode, setMode] = useState<PayMode>('cash');
  const [note, setNote] = useState('');
  const act = useAction('staff.decide', { success: approve ? `Paid ${inr(amount)} to ${r.employee_name}` : 'Request declined', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} size="sm" title={approve ? `Pay ${r.employee_name}` : `Decline ${r.employee_name}'s request`}
      description={`Asked for ${inr(r.amount)} — ${r.reason}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={approve ? 'primary' : 'danger'} loading={act.isPending} disabled={approve ? amount <= 0 || amount > r.amount : !note.trim()} onClick={() => act.mutate({ id: r.id, approve, amount, mode, note })} data-testid="decide-save">{approve ? `Pay ${inr(amount)}` : 'Decline'}</Button></>}>
      <div className="space-y-3">
        {approve && (
          <>
            <Field label="Amount to give" hint="You can give less than asked." error={amount > r.amount ? 'More than they asked for' : null}><MoneyInput autoFocus value={amount} onChange={setAmount} /></Field>
            <Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} />
            <p className="text-xs text-muted">Recorded as money taken before payday — adjust it from salary when you pay.</p>
          </>
        )}
        <Field label={approve ? 'Note (optional)' : 'Reason *'}><Input autoFocus={!approve} value={note} onChange={(e) => setNote(e.target.value)} placeholder={approve ? '' : 'e.g. Please ask after payday'} data-testid="decide-note" /></Field>
      </div>
    </Dialog>
  );
}

/* ───────── festival bonus ───────── */

const FESTIVALS = ['Diwali', 'Holi', 'Eid', 'Raksha Bandhan', 'Ganesh Chaturthi', 'Durga Puja', 'Onam', 'Pongal / Sankranti', 'Gudi Padwa / Ugadi', 'Baisakhi', 'Christmas', 'Other'];

function BonusDialog({ employees, preselect, onClose }: { employees: Employee[]; preselect: number[]; onClose: () => void }) {
  const [occasion, setOccasion] = useState('Diwali');
  const [other, setOther] = useState('');
  const [basis, setBasis] = useState<'fixed' | 'percent'>('fixed');
  const [value, setValue] = useState(0); // paise for fixed, % for percent
  const [pct, setPct] = useState('');
  const [picked, setPicked] = useState<Record<number, boolean>>(Object.fromEntries(preselect.map((id) => [id, true])));
  const [custom, setCustom] = useState<Record<number, number>>({});
  const [when, setWhen] = useState<'now' | 'payday'>('now');
  const [mode, setMode] = useState<PayMode>('cash');
  const amountFor = (e: Employee) => custom[e.id] ?? (basis === 'fixed' ? value : Math.round((e.monthly_salary * (Number(pct) || 0)) / 100 / 100) * 100);
  const chosen = employees.filter((e) => picked[e.id]);
  const total = chosen.reduce((s, e) => s + amountFor(e), 0);
  const name = occasion === 'Other' ? other.trim() : occasion;
  const act = useAction('staff.bonus', { success: (ids) => `${name} bonus for ${ids.length} ${ids.length === 1 ? 'person' : 'people'} · ${inr(total)}${when === 'now' ? ' paid' : ' added to their pay'}`, onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} size="lg" title="Festival bonus" description="Give everyone the same amount, or a share of their monthly salary. Change anyone's amount in the table."
      footer={<><span className="mr-auto text-sm text-muted">{chosen.length} people · <b className="text-ink tnum">{inr(total)}</b></span><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" icon={<Gift className="h-4 w-4" />} loading={act.isPending} disabled={!name || total <= 0} data-testid="bonus-save"
          onClick={() => act.mutate({ occasion: name, rows: chosen.map((e) => ({ employeeId: e.id, amount: amountFor(e) })), payNow: when === 'now' ? { mode } : null })}>
          {when === 'now' ? `Pay ${inr(total)}` : 'Add to their pay'}
        </Button></>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {FESTIVALS.map((f) => (
            <button key={f} type="button" onClick={() => setOccasion(f)} className={cn('rounded-full border px-3 py-1 text-sm', occasion === f ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-ink')} data-testid={`fest-${f}`}>{f}</button>
          ))}
        </div>
        {occasion === 'Other' && <Field label="Occasion"><Input autoFocus value={other} onChange={(e) => setOther(e.target.value)} placeholder="e.g. Shop anniversary" /></Field>}
        <div className="flex flex-wrap items-end gap-3">
          <Segmented value={basis} onChange={(v) => (setBasis(v), setCustom({}))} options={[{ value: 'fixed', label: 'Same amount each' }, { value: 'percent', label: '% of monthly salary' }]} />
          {basis === 'fixed' ? (
            <MoneyInput className="w-40" value={value} onChange={(v) => (setValue(v), setCustom({}))} data-testid="bonus-amount" />
          ) : (
            <Input className="w-32" suffix="%" inputMode="decimal" value={pct} onChange={(e) => (setPct(e.target.value.replace(/[^\d.]/g, '')), setCustom({}))} placeholder="e.g. 50" data-testid="bonus-percent" />
          )}
          {basis === 'percent' && <span className="pb-2 text-xs text-muted">100% = one month's salary</span>}
        </div>
        <table className="table-base">
          <thead><tr><th className="w-8" /><th>Employee</th><th className="text-right">Monthly salary</th><th className="text-right">Bonus</th></tr></thead>
          <tbody>
            {employees.map((e) => (
              <tr key={e.id} className={picked[e.id] ? '' : 'opacity-50'}>
                <td><input type="checkbox" checked={!!picked[e.id]} onChange={(x) => setPicked({ ...picked, [e.id]: x.target.checked })} className="accent-[rgb(var(--primary))]" /></td>
                <td className="font-medium">{e.name}</td>
                <td className="text-right tnum text-muted">{inr(e.monthly_salary, false)}</td>
                <td className="text-right"><MoneyInput className="ml-auto w-32" value={amountFor(e)} onChange={(v) => setCustom({ ...custom, [e.id]: v })} disabled={!picked[e.id]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
          <Segmented value={when} onChange={setWhen} options={[{ value: 'now', label: 'Pay now' }, { value: 'payday', label: 'Add to next salary' }]} />
          {when === 'now' && <Segmented size="sm" value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'bank', label: 'Bank' }]} />}
          {when === 'payday' && <span className="text-xs text-muted">Shows as unpaid in each person's pay — settle it with their salary.</span>}
        </div>
      </div>
    </Dialog>
  );
}

function salarySlip(shop: string, name: string, month: string, amount: number, advance: number) {
  return [
    `*Salary slip — ${month}*`,
    `${shop}`,
    `Employee: ${name}`,
    `Net salary for the month: ${inr(amount)}`,
    advance > 0 ? `Advance still outstanding: ${inr(advance)}` : 'No advance outstanding.',
    'Thank you for your work! 🙏',
  ].join('\n');
}
