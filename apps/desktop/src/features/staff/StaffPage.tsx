import { isMobile } from '@hisaab/core';
import { BadgeIndianRupee, CalendarCheck, HandCoins, Pencil, Plus, Send, UserRound, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Drawer, EmptyState, Field, Input, Loading, MoneyInput, PageHeader, Segmented, Select, Switch } from '../../components/ui';
import type { PayMode } from '../../db/types';
import type { Employee, SalaryRow } from '../../db/repos/staff';
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
            <Button variant="primary" icon={<CalendarCheck className="h-4 w-4" />} onClick={() => setRun(true)} disabled={!active.length} data-testid="salary-run">Run salary</Button>
          </>
        }
      />
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
                  <td><div className="font-medium">{e.name}</div><div className="text-xs text-muted">{e.phone ?? ''}</div></td>
                  <td className="text-muted">{e.designation ?? '—'}{!e.active && <Badge className="ml-2">left</Badge>}</td>
                  <td className="text-right tnum">{inr(e.monthly_salary, false)}</td>
                  <td className="text-right tnum">{e.advance ? <span className="text-saffron-ink">{inr(e.advance)}</span> : '—'}</td>
                  <td className="text-right tnum">{e.salary_due ? <b className="text-bad">{inr(e.salary_due)}</b> : '—'}</td>
                  <td className="text-muted">{e.last_paid ? fmtDate(e.last_paid) : '—'}</td>
                  <td className="text-right" onClick={(x) => x.stopPropagation()}>
                    {!!e.active && <Button size="sm" variant="ghost" icon={<HandCoins className="h-3.5 w-3.5" />} onClick={() => setAdvance(e)}>Advance</Button>}
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
      {open && <EmployeeDrawer id={open} onClose={() => setOpen(null)} onEdit={(e) => (setOpen(null), setEdit(e))} onAdvance={(e) => setAdvance(e)} />}
    </div>
  );
}

function EmployeeDialog({ initial, onClose }: { initial: Employee | null; onClose: () => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? '', phone: initial?.phone ?? '', designation: initial?.designation ?? '', monthlySalary: initial?.monthly_salary ?? 0, joinedOn: initial?.joined_on ?? '',
    payMode: (initial?.pay_mode ?? 'cash') as PayMode, bankAccount: initial?.bank_account ?? '', bankIfsc: initial?.bank_ifsc ?? '', active: initial ? !!initial.active : true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useAction('staff.save', { success: initial ? 'Saved' : `${f.name} added`, onSuccess: onClose });
  const phoneErr = f.phone && !isMobile(f.phone) ? 'Enter a 10-digit mobile' : null;
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={initial ? `Edit ${initial.name}` : 'Add employee'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!f.name.trim() || !!phoneErr} onClick={() => save.mutate({ id: initial?.id, ...f })} data-testid="staff-save">Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name *"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} data-testid="staff-name" /></Field>
        <Field label="Mobile" error={phoneErr}><Input value={f.phone} onChange={(e) => set('phone', e.target.value)} inputMode="tel" /></Field>
        <Field label="Role"><Input value={f.designation} onChange={(e) => set('designation', e.target.value)} placeholder="Counter, helper, delivery…" /></Field>
        <Field label="Monthly salary *"><MoneyInput value={f.monthlySalary} onChange={(v) => set('monthlySalary', v)} data-testid="staff-salary" /></Field>
        <Field label="Joined on"><Input type="date" value={f.joinedOn} onChange={(e) => set('joinedOn', e.target.value)} /></Field>
        <Field label="Usually paid by"><Select value={f.payMode} onChange={(e) => set('payMode', e.target.value as PayMode)}><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank transfer</option></Select></Field>
        {f.payMode === 'bank' && (<><Field label="Bank account"><Input value={f.bankAccount} onChange={(e) => set('bankAccount', e.target.value.replace(/\D/g, ''))} /></Field><Field label="IFSC"><Input value={f.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase())} /></Field></>)}
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
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Advance · ${employee.name}`} description={employee.advance ? `${inr(employee.advance)} advance already outstanding` : 'Money given now, adjusted from a later salary.'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={amount <= 0} onClick={() => act.mutate({ employeeId: employee.id, amount, mode, direction, note })} data-testid="advance-save">Save</Button></>}>
      <div className="space-y-3">
        <Segmented value={direction} onChange={setDirection} options={[{ value: 'give', label: 'Give advance' }, { value: 'return', label: 'They paid back' }]} />
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
  const calc = (r: SalaryRow) => Math.max(0, Math.round((r.monthlySalary * r.paidDays) / r.daysInMonth) + r.bonus - r.deduction);
  const fresh = rows.filter((r) => !r.existing);
  const total = fresh.reduce((s, r) => s + calc(r), 0);
  const upd = (i: number, p: Partial<SalaryRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} size="xl" title="Run salary" description="Days worked, bonus and deductions for each person. This creates their salary bills — pay them now or later from Bills to pay."
      footer={<><span className="mr-auto text-sm text-muted">{fresh.length} people · <b className="text-ink tnum">{inr(total)}</b></span><Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={act.isPending} disabled={!fresh.length} onClick={() => act.mutate({ period, rows: fresh.map((r) => ({ employeeId: r.employeeId, paidDays: r.paidDays, bonus: r.bonus, deduction: r.deduction })) })} data-testid="salary-create">Create salary bills</Button></>}>
      <div className="mb-3 flex items-center gap-3">
        <span className="text-sm text-muted">Month</span>
        <Input type="month" value={period} max={thisMonth()} onChange={(e) => e.target.value && setPeriod(e.target.value)} className="w-48" data-testid="salary-month" />
      </div>
      {!preview.data ? <Loading /> : (
        <table className="table-base">
          <thead><tr><th>Employee</th><th className="text-right">Monthly</th><th className="text-right">Days worked</th><th className="text-right">Bonus / OT</th><th className="text-right">Deduction</th><th className="text-right">Salary</th><th className="text-right">Advance</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.employeeId}>
                <td><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.designation}</div></td>
                <td className="text-right tnum text-muted">{inr(r.monthlySalary, false)}</td>
                {r.existing ? (
                  <td colSpan={4} className="text-right"><Badge tone={r.existing.status === 'paid' ? 'good' : 'warn'}>Already created · {inr(r.existing.amount)} · {r.existing.status === 'paid' ? 'paid' : 'unpaid'}</Badge></td>
                ) : (
                  <>
                    <td className="text-right"><input className="input h-8 w-16 text-right" inputMode="numeric" value={r.paidDays} onChange={(e) => upd(i, { paidDays: Math.max(0, Math.min(r.daysInMonth, Number(e.target.value.replace(/\D/g, '')) || 0)) })} /> <span className="text-xs text-muted">/ {r.daysInMonth}</span></td>
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
      <p className="mt-3 text-xs text-muted">Salary = monthly × days worked ÷ days in month + bonus − deduction. Advances are adjusted when you pay.</p>
    </Dialog>
  );
}

const KIND: Record<string, { label: string; sign: 1 | -1 | 0 }> = {
  salary: { label: 'Salary for', sign: 0 },
  salary_paid: { label: 'Salary paid', sign: -1 },
  advance: { label: 'Advance given', sign: -1 },
  advance_return: { label: 'Advance paid back', sign: 1 },
  advance_recovery: { label: 'Advance adjusted in salary', sign: 0 },
};

function EmployeeDrawer({ id, onClose, onEdit, onAdvance }: { id: number; onClose: () => void; onEdit: (e: Employee) => void; onAdvance: (e: Employee) => void }) {
  const q = useApi('staff.get', { id });
  const bills = useApi('expenses.list', { employeeId: id, status: 'due' });
  const company = useApi('app.status').data?.company;
  const [pay, setPay] = useState<NonNullable<typeof bills.data>[number] | null>(null);
  const e = q.data;
  return (
    <Drawer open onOpenChange={(v) => !v && onClose()} title={e?.name ?? 'Employee'} width="max-w-xl"
      footer={e ? (<><Button variant="ghost" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(e)}>Edit</Button><Button variant="outline" icon={<HandCoins className="h-4 w-4" />} onClick={() => onAdvance(e)}>Advance</Button></>) : undefined}>
      {!e ? <Loading /> : (
        <div className="space-y-5 text-sm">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Monthly</div><div className="text-lg font-semibold tnum">{inr(e.monthly_salary, false)}</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Salary due</div><div className={cn('text-lg font-semibold tnum', e.salary_due > 0 && 'text-bad')}>{inr(e.salary_due, false)}</div></div>
            <div className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-muted">Advance</div><div className="text-lg font-semibold tnum text-saffron-ink">{inr(e.advance, false)}</div></div>
          </div>
          {!!bills.data?.length && (
            <div>
              <h4 className="mb-2 font-semibold">Unpaid salary</h4>
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
                      <span className="text-muted">{fmtDate(t.date)}</span> · {KIND[t.kind]?.label ?? t.kind} {t.kind === 'salary' || t.kind === 'salary_paid' ? <b>{t.note && monthName(t.note)}</b> : t.note && <span className="text-muted">{t.note}</span>}
                      {t.mode && t.kind !== 'advance_recovery' && <span className="text-xs text-faint"> · {t.mode}</span>}
                    </span>
                    <span className={cn('font-medium tnum', KIND[t.kind]?.sign === -1 && 'text-bad', KIND[t.kind]?.sign === 1 && 'text-good')}>{inr(t.amount)}</span>
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
