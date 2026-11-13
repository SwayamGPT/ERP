import { computeLine, validateGstin } from '@hisaab/core';
import { Banknote, CalendarClock, Landmark, Smartphone } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button, Dialog, Field, Input, MoneyInput, Segmented, Select, Switch } from '../../components/ui';
import type { PayMode } from '../../db/types';
import { cn } from '../../lib/cn';
import { inr, shiftDate, today } from '../../lib/format';
import { useAction, useApi } from '../../lib/useApi';

const MODES: Array<{ value: PayMode; label: string; icon: JSX.Element }> = [
  { value: 'cash', label: 'Cash', icon: <Banknote className="h-4 w-4" /> },
  { value: 'upi', label: 'UPI', icon: <Smartphone className="h-4 w-4" /> },
  { value: 'bank', label: 'Bank', icon: <Landmark className="h-4 w-4" /> },
];

/** Record any shop expense: paid now, or a bill to pay later. GST bills can claim input credit. */
export function ExpenseDialog({ onClose, defaultCategory }: { onClose: () => void; defaultCategory?: string }) {
  const cats = useApi('expenses.categories', {});
  const payees = useApi('expenses.payees');
  const company = useApi('app.status').data?.company;
  const [f, setF] = useState({
    date: today(), categoryId: 0, amount: 0, payee: '', billNo: '', description: '', when: 'now' as 'now' | 'later', mode: 'cash' as PayMode,
    dueDate: shiftDate(today(), 7), gst: false, gstRate: 18, payeeGstin: '', claimItc: true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const active = (cats.data ?? []).filter((c) => c.active && !c.is_salary);
  useEffect(() => {
    if (!f.categoryId && active.length) set('categoryId', (active.find((c) => c.name === defaultCategory) ?? active[0]).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cats.data]);
  const groups = useMemo(() => [...new Set(active.map((c) => c.grp))], [active]);
  const gstinOk = !f.payeeGstin || validateGstin(f.payeeGstin);
  const split = f.gst && f.amount > 0
    ? computeLine({ qty: 1, rate: f.amount, gstRate: f.gstRate, taxInclusive: true, interState: !!f.payeeGstin && gstinOk && f.payeeGstin.slice(0, 2) !== company?.state_code })
    : null;
  const save = useAction('expenses.create', { success: (e) => `${e.category} · ${inr(e.amount)} ${e.status === 'paid' ? 'paid' : 'added to bills to pay'}`, onSuccess: onClose });
  const cat = active.find((c) => c.id === f.categoryId);
  const overBudget = cat && cat.monthly_budget > 0 && (cat.spent ?? 0) + f.amount > cat.monthly_budget;

  const submit = () =>
    save.mutate({
      date: f.date, categoryId: f.categoryId, amount: f.amount, payee: f.payee || null, billNo: f.billNo || null, description: f.description || null,
      gstRate: f.gst ? f.gstRate : 0, payeeGstin: f.gst ? f.payeeGstin || null : null, claimItc: f.gst && f.claimItc && !!f.payeeGstin,
      payNow: f.when === 'now' ? { mode: f.mode } : null, dueDate: f.when === 'later' ? f.dueDate : null,
    });

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title="Add expense"
      description="Rent, electricity, salaries, transport — anything the shop spends."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} disabled={!f.categoryId || f.amount <= 0 || !gstinOk} onClick={submit} data-testid="expense-save">
            {f.when === 'now' ? `Save · paid ${f.amount ? inr(f.amount) : ''}` : 'Save as bill to pay'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_160px]">
          <Field label="What for *" hint={cat && cat.monthly_budget > 0 ? `${inr(cat.spent ?? 0, false)} of ${inr(cat.monthly_budget, false)} budget used this month` : undefined} error={overBudget ? 'This takes the category over its monthly budget' : null}>
            <Select value={f.categoryId} onChange={(e) => set('categoryId', Number(e.target.value))} autoFocus data-testid="expense-category">
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {active.filter((c) => c.grp === g).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Amount *" hint={f.gst ? 'Total including GST' : undefined}>
            <MoneyInput value={f.amount} onChange={(v) => set('amount', v)} className="[&_input]:font-semibold" data-testid="expense-amount" />
          </Field>
          <Field label="Date">
            <Input type="date" value={f.date} max={shiftDate(today(), 30)} onChange={(e) => set('date', e.target.value)} />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid to" hint="Landlord, electricity board, shop, person…">
            <Input list="payees" value={f.payee} onChange={(e) => set('payee', e.target.value)} placeholder="e.g. MSEDCL" data-testid="expense-payee" />
            <datalist id="payees">{payees.data?.map((p) => <option key={p} value={p} />)}</datalist>
          </Field>
          <Field label="Bill / receipt no.">
            <Input value={f.billNo} onChange={(e) => set('billNo', e.target.value)} />
          </Field>
        </div>

        <div className="rounded-xl border border-border p-3">
          <Segmented
            value={f.when}
            onChange={(v) => set('when', v)}
            options={[{ value: 'now', label: 'Paid now' }, { value: 'later', label: 'Pay later (bill)' }]}
          />
          {f.when === 'now' ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {MODES.map((m) => (
                <button key={m.value} onClick={() => set('mode', m.value)} className={cn('flex items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm font-medium', f.mode === m.value ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:text-ink')} data-testid={`expense-mode-${m.value}`}>
                  {m.icon} {m.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex items-center gap-3">
              <CalendarClock className="h-4 w-4 text-warn" />
              <span className="text-sm text-muted">Due on</span>
              <Input type="date" className="w-44" value={f.dueDate} min={f.date} onChange={(e) => set('dueDate', e.target.value)} data-testid="expense-due" />
              <span className="text-xs text-muted">It will show in “Bills to pay” and on the dashboard.</span>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border p-3">
          <Switch checked={f.gst} onChange={(v) => set('gst', v)} label="This is a GST bill" hint="Rent from a registered landlord, internet, CA fees, repairs…" />
          {f.gst && (
            <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
              <Field label="GST rate">
                <Select value={f.gstRate} onChange={(e) => set('gstRate', Number(e.target.value))}>
                  {[5, 12, 18, 28, 40].map((r) => <option key={r} value={r}>{r}%</option>)}
                </Select>
              </Field>
              <Field label="Their GSTIN (from the bill)" error={!gstinOk ? 'GSTIN is not valid' : null}>
                <Input className="font-mono" value={f.payeeGstin} onChange={(e) => set('payeeGstin', e.target.value.toUpperCase().slice(0, 15))} />
              </Field>
              {split && (
                <div className="sm:col-span-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
                  Bill value {inr(split.taxable)} + GST {inr(split.tax)} ({split.igst ? `IGST ${inr(split.igst)}` : `CGST ${inr(split.cgst)} + SGST ${inr(split.sgst)}`})
                  {f.payeeGstin && gstinOk && f.claimItc ? <b className="ml-1 text-good">· {inr(split.tax)} input credit in GSTR-3B</b> : null}
                </div>
              )}
              {f.payeeGstin && gstinOk && <div className="sm:col-span-2"><Switch checked={f.claimItc} onChange={(v) => set('claimItc', v)} label="Claim input tax credit" hint="Turn off for blocked credits (e.g. food & beverages for staff)" /></div>}
            </div>
          )}
        </div>
        <Field label="Note">
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="Optional" />
        </Field>
      </div>
    </Dialog>
  );
}

/** Pay a bill fully or partly. Salary bills can also be settled from the employee's advance. */
export function PayExpenseDialog({ expense, onClose, advance = 0 }: { expense: { id: number; category: string; payee: string | null; amount: number; paid: number; employee_id: number | null }; advance?: number; onClose: () => void }) {
  const due = expense.amount - expense.paid;
  const [recover, setRecover] = useState(expense.employee_id ? Math.min(advance, due) : 0);
  const [amount, setAmount] = useState(due - (expense.employee_id ? Math.min(advance, due) : 0));
  const [mode, setMode] = useState<PayMode>('cash');
  const [date, setDate] = useState(today());
  const paySalary = useAction('staff.paySalary', { success: 'Salary payment recorded', onSuccess: onClose });
  const payBill = useAction('expenses.pay', { success: 'Payment recorded', onSuccess: onClose });
  const total = amount + recover;
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Pay ${expense.payee ?? expense.category}`}
      description={`${expense.category} · ${inr(due)} still to pay${expense.paid ? ` (${inr(expense.paid)} paid earlier)` : ''}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={paySalary.isPending || payBill.isPending}
            disabled={total <= 0 || total > due}
            data-testid="pay-expense-save"
            onClick={() =>
              expense.employee_id
                ? paySalary.mutate({ expenseId: expense.id, amount, mode, recoverAdvance: recover, date })
                : payBill.mutate({ id: expense.id, amount, mode, date })
            }
          >
            Pay {inr(total)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {expense.employee_id && advance > 0 && (
          <Field label="Adjust from advance" hint={`${inr(advance)} advance outstanding`}>
            <MoneyInput value={recover} onChange={(v) => (setRecover(Math.min(v, advance, due)), setAmount(Math.max(0, due - Math.min(v, advance, due))))} />
          </Field>
        )}
        <Field label={expense.employee_id && advance > 0 ? 'Paid in money' : 'Amount'} error={total > due ? 'More than the amount due' : null}>
          <MoneyInput autoFocus value={amount} onChange={setAmount} className="[&_input]:h-11 [&_input]:text-lg" data-testid="pay-expense-amount" />
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.value, label: m.label }))} />
          <Input type="date" className="w-44" value={date} max={today()} onChange={(e) => setDate(e.target.value)} />
        </div>
        {total < due && total > 0 && <p className="text-xs text-muted">Part payment — {inr(due - total)} will remain in bills to pay.</p>}
      </div>
    </Dialog>
  );
}
