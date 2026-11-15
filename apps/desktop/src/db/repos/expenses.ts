import type { SqlJsAdapter } from '../adapter';
import { seriesCode } from '../sync/engine';
import { computeLine, isInterState, validateGstin } from '@hisaab/core';
import type { PayMode } from '../types';
import { dueDates, isOff, occurrence } from '../schedule';
import { addDays, allowed, AppError, audit, guard, localNow, bankIdOf, isBankCode, payAccount, postVoucher, requireSession, reverseVoucher, type Ctx } from './base';
import { mustCompany } from './company';

/*
 * Expenses are recorded as a bill (what you owe) plus zero or more payments (money that left).
 *   Bill:     Dr Expenses (+ Input GST when claimable)  /  Cr Expense bills payable
 *   Payment:  Dr Expense bills payable                  /  Cr Cash or Bank
 *   Salary paid from an advance: Dr Expense bills payable / Cr Staff advances
 * Paying immediately simply records both at once, so the books always show who is still owed what.
 */

export interface ExpenseCategory {
  id: number;
  name: string;
  grp: string;
  monthly_budget: number;
  is_salary: number;
  active: number;
  spent?: number;
}

export interface Expense {
  id: number;
  date: string;
  category_id: number;
  category: string;
  grp: string;
  payee: string | null;
  payee_gstin: string | null;
  bill_no: string | null;
  description: string | null;
  amount: number;
  taxable: number;
  gst_rate: number;
  cgst: number;
  sgst: number;
  igst: number;
  itc: number;
  status: 'unpaid' | 'partial' | 'paid' | 'cancelled';
  paid: number;
  due_date: string | null;
  employee_id: number | null;
  salary_period: string | null;
  salary_detail: string | null;
  recurring_id: number | null;
  legacy_payment_id: number | null;
  cancel_reason: string | null;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: string;
  payments?: Array<{ id: number; kind: 'payment' | 'advance'; amount: number; mode: string; date: string; cancelled: number; by: string | null; created_at: string }>;
}

export interface ExpenseInput {
  date?: string;
  categoryId: number;
  amount: number; // total incl. GST, paise
  payee?: string | null;
  payeeGstin?: string | null;
  billNo?: string | null;
  description?: string | null;
  gstRate?: number;
  claimItc?: boolean;
  /** Paid now in full with this mode, or leave unpaid with a due date. */
  payNow?: { mode: PayMode } | null;
  /** Paid from the counter's petty-cash box (cash only). */
  petty?: boolean;
  dueDate?: string | null;
  employeeId?: number | null;
  salaryPeriod?: string | null;
  salaryDetail?: unknown;
  recurringId?: number | null;
  recurringKey?: string | null;
}

const SELECT = `SELECT e.*, c.name AS category, c.grp, u.name AS created_by_name FROM expenses e
  JOIN expense_categories c ON c.id = e.category_id LEFT JOIN users u ON u.id = e.created_by`;

/* ───────── categories ───────── */

export function listCategories(ctx: Ctx, month?: string): ExpenseCategory[] {
  guard(ctx, 'expense.view');
  const m = month ?? ctx.today().slice(0, 7);
  return ctx.db.query<ExpenseCategory>(
    `SELECT c.*, (SELECT COALESCE(SUM(e.amount - e.cgst - e.sgst - e.igst * e.itc), 0) FROM expenses e WHERE e.category_id = c.id AND e.status <> 'cancelled' AND substr(e.date, 1, 7) = ?) AS spent
     FROM expense_categories c ORDER BY c.active DESC, c.grp, c.name`,
    [m],
  );
}

export function saveCategory(ctx: Ctx, input: { id?: number; name: string; grp?: string; monthlyBudget?: number; active?: boolean }) {
  guard(ctx, 'expense.create');
  const name = input.name?.trim();
  if (!name) throw new AppError('Give the category a name.');
  if ((input.monthlyBudget ?? 0) < 0) throw new AppError('Budget cannot be negative.');
  const dupe = ctx.db.get<{ id: number }>('SELECT id FROM expense_categories WHERE name = ? COLLATE NOCASE AND id <> ?', [name, input.id ?? 0]);
  if (dupe) throw new AppError(`A category called "${name}" already exists.`);
  return ctx.db.transaction(() => {
    if (input.id) {
      ctx.db.exec('UPDATE expense_categories SET name = ?, grp = ?, monthly_budget = ?, active = ? WHERE id = ?', [name, input.grp?.trim() || 'Other', input.monthlyBudget ?? 0, input.active === false ? 0 : 1, input.id]);
      audit(ctx, 'expense_category.update', 'expense_category', input.id, { name, budget: input.monthlyBudget });
      return input.id;
    }
    const id = ctx.db.exec('INSERT INTO expense_categories (name, grp, monthly_budget) VALUES (?, ?, ?)', [name, input.grp?.trim() || 'Other', input.monthlyBudget ?? 0]).lastId;
    audit(ctx, 'expense_category.create', 'expense_category', id, { name });
    return id;
  });
}

function salaryCategoryId(ctx: Ctx): number {
  const c = ctx.db.get<{ id: number }>('SELECT id FROM expense_categories WHERE is_salary = 1 ORDER BY id LIMIT 1');
  if (c) return c.id;
  return ctx.db.exec("INSERT INTO expense_categories (name, grp, is_salary) VALUES ('Salaries & wages', 'Staff', 1)").lastId;
}

/* ───────── expenses ───────── */

/** Work out the GST inside an expense amount. Input credit only with the payee's valid GSTIN. */
function gstSplit(ctx: Ctx, amount: number, rate: number, payeeGstin: string | null, claim: boolean) {
  if (!rate) return { taxable: amount, cgst: 0, sgst: 0, igst: 0, itc: 0 };
  const company = mustCompany(ctx);
  const inter = payeeGstin ? isInterState(company.state_code, payeeGstin.slice(0, 2)) : false;
  const t = computeLine({ qty: 1, rate: amount, gstRate: rate, taxInclusive: true, interState: inter });
  return { taxable: t.taxable, cgst: t.cgst, sgst: t.sgst, igst: t.igst, itc: claim && payeeGstin ? 1 : 0 };
}

export function createExpense(ctx: Ctx, input: ExpenseInput): Expense {
  const s = guard(ctx, input.employeeId ? 'payroll.manage' : 'expense.create');
  if (!(input.amount > 0) || !Number.isSafeInteger(input.amount)) throw new AppError('Enter the amount.');
  const cat = ctx.db.get<{ id: number; name: string; active: number }>('SELECT id, name, active FROM expense_categories WHERE id = ?', [input.categoryId]);
  if (!cat) throw new AppError('Pick a category.');
  const gstin = input.payeeGstin?.trim().toUpperCase() || null;
  if (gstin && !validateGstin(gstin)) throw new AppError("The payee's GSTIN is not valid.");
  if ((input.gstRate ?? 0) > 0 && input.claimItc && !gstin) throw new AppError("To claim GST input credit, enter the payee's GSTIN from their bill.");
  const date = input.date ?? ctx.today();
  if (input.dueDate && input.dueDate < date) throw new AppError('Due date cannot be before the bill date.');

  return ctx.db.transaction(() => {
    const g = gstSplit(ctx, input.amount, input.gstRate ?? 0, gstin, !!input.claimItc);
    const id = ctx.db.exec(
      `INSERT INTO expenses (date, category_id, payee, payee_gstin, bill_no, description, amount, taxable, gst_rate, cgst, sgst, igst, itc, status, paid, due_date,
         employee_id, salary_period, salary_detail, recurring_id, recurring_key, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'unpaid', 0, ?, ?,?,?,?,?,?,?)`,
      [
        date, cat.id, input.payee?.trim() || null, gstin, input.billNo?.trim() || null, input.description?.trim() || null, input.amount, g.taxable,
        input.gstRate ?? 0, g.cgst, g.sgst, g.igst, g.itc, input.payNow ? null : input.dueDate ?? null, input.employeeId ?? null, input.salaryPeriod ?? null,
        input.salaryDetail ? JSON.stringify(input.salaryDetail) : null, input.recurringId ?? null, input.recurringKey ?? null, s.userId, localNow(),
      ],
    ).lastId;
    // Bills raised from a godown's rent schedule remember the godown.
    if (input.recurringId) ctx.db.exec('UPDATE expenses SET godown_id = (SELECT godown_id FROM recurring_expenses WHERE id = ?) WHERE id = ?', [input.recurringId, id]);
    const label = [cat.name, input.payee?.trim()].filter(Boolean).join(' · ');
    const expensePart = g.itc ? g.taxable : input.amount;
    postVoucher(ctx, 'expense_bill', id, date, [
      { account: 'EXPENSE', amount: expensePart, narration: label },
      { account: 'IN_CGST', amount: g.itc ? g.cgst : 0, narration: label },
      { account: 'IN_SGST', amount: g.itc ? g.sgst : 0, narration: label },
      { account: 'IN_IGST', amount: g.itc ? g.igst : 0, narration: label },
      { account: 'EXPENSE_PAYABLE', amount: -input.amount, narration: label },
    ]);
    audit(ctx, 'expense.create', 'expense', id, { category: cat.name, amount: input.amount, payee: input.payee, paid: !!input.payNow });
    if (input.petty) {
      if (input.payNow?.mode !== 'cash') throw new AppError('Petty cash expenses are paid in cash.');
      ctx.db.exec('UPDATE expenses SET petty = 1 WHERE id = ?', [id]);
    }
    // Above the owner's limit, staff expenses wait for the owner's approval before they can be paid.
    const limit = ctx.db.get<{ l: number }>('SELECT expense_approval_limit AS l FROM company WHERE id = 1')?.l ?? 0;
    if (limit > 0 && input.amount > limit && s.role !== 'owner' && !input.employeeId) {
      ctx.db.exec("UPDATE expenses SET approval = 'pending' WHERE id = ?", [id]);
      return getExpense(ctx, id);
    }
    if (input.payNow) payExpense(ctx, { id, amount: input.amount, mode: input.payNow.mode, date });
    return getExpense(ctx, id);
  });
}

export function refreshStatus(ctx: Ctx, id: number) {
  const e = ctx.db.get<{ amount: number; status: string }>('SELECT amount, status FROM expenses WHERE id = ?', [id])!;
  if (e.status === 'cancelled') return;
  const paid =
    ctx.db.get<{ s: number }>('SELECT COALESCE(SUM(amount), 0) AS s FROM payments WHERE expense_id = ? AND cancelled = 0', [id])!.s +
    ctx.db.get<{ s: number }>("SELECT COALESCE(SUM(amount), 0) AS s FROM money_moves WHERE expense_id = ? AND kind = 'advance_recovery' AND cancelled = 0", [id])!.s;
  ctx.db.exec('UPDATE expenses SET paid = ?, status = ? WHERE id = ?', [paid, paid >= e.amount ? 'paid' : paid > 0 ? 'partial' : 'unpaid', id]);
}

/** Pay all or part of an expense bill. For salaries, part can come from the employee's advance. */
export function payExpense(ctx: Ctx, input: { id: number; amount: number; mode: PayMode; date?: string; recoverAdvance?: number; reference?: string; bankAccountId?: number | null }) {
  const e = ctx.db.get<Expense>(`${SELECT} WHERE e.id = ?`, [input.id]);
  if (!e) throw new AppError('Expense not found.');
  const s = guard(ctx, e.employee_id ? 'payroll.manage' : 'expense.create');
  if (e.status === 'cancelled') throw new AppError('This expense is cancelled.');
  const approval = ctx.db.get<{ a: string | null }>('SELECT approval AS a FROM expenses WHERE id = ?', [input.id])!.a;
  if (approval === 'pending') throw new AppError('This expense is waiting for the owner’s approval.', 'NEEDS_APPROVAL');
  if (approval === 'rejected') throw new AppError('The owner rejected this expense.');
  const recover = input.recoverAdvance ?? 0;
  const due = e.amount - e.paid;
  if (input.amount < 0 || recover < 0) throw new AppError('Amounts cannot be negative.');
  if (input.amount + recover <= 0) throw new AppError('Enter the amount being paid.');
  if (input.amount + recover > due) throw new AppError(`Only ₹${(due / 100).toFixed(2)} is still due on this bill.`);
  if (recover > 0) {
    if (!e.employee_id) throw new AppError('Advance can only be adjusted against a salary.');
    const adv = employeeAdvance(ctx, e.employee_id);
    if (recover > adv) throw new AppError(`Only ₹${(adv / 100).toFixed(2)} advance is outstanding for this employee.`);
  }
  const date = input.date ?? ctx.today();
  const label = [e.category, e.payee].filter(Boolean).join(' · ');
  const acct = payAccount(ctx, input.mode, input.bankAccountId);
  return ctx.db.transaction(() => {
    if (input.amount > 0) {
      const pid = ctx.db.exec(
        "INSERT INTO payments (direction, kind, amount, mode, category, reference, note, date, expense_id, created_by, created_at, bank_account_id) VALUES ('out', 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [input.amount, input.mode, e.category, input.reference ?? null, label, date, e.id, s.userId, localNow(), isBankCode(acct) ? bankIdOf(acct) : null],
      ).lastId;
      postVoucher(ctx, 'expense_payment', pid, date, [
        { account: 'EXPENSE_PAYABLE', amount: input.amount, narration: label },
        { account: acct, amount: -input.amount, narration: label },
      ]);
    }
    if (recover > 0) {
      const mid = ctx.db.exec(
        "INSERT INTO money_moves (kind, amount, employee_id, expense_id, note, date, created_by, created_at) VALUES ('advance_recovery', ?, ?, ?, ?, ?, ?, ?)",
        [recover, e.employee_id, e.id, `Adjusted from ${label}`, date, s.userId, localNow()],
      ).lastId;
      postVoucher(ctx, 'move', mid, date, [
        { account: 'EXPENSE_PAYABLE', amount: recover, narration: 'Advance adjusted in salary' },
        { account: 'EMP_ADVANCE', employeeId: e.employee_id, amount: -recover, narration: 'Advance adjusted in salary' },
      ]);
    }
    refreshStatus(ctx, e.id);
    audit(ctx, 'expense.pay', 'expense', e.id, { amount: input.amount, mode: input.mode, recovered: recover || undefined, category: e.category, payee: e.payee });
    return getExpense(ctx, e.id);
  });
}

export function cancelExpense(ctx: Ctx, input: { id: number; reason: string }) {
  const e = getExpense(ctx, input.id);
  guard(ctx, e.employee_id ? 'payroll.manage' : 'expense.create');
  if (e.status === 'cancelled') throw new AppError('Already cancelled.');
  if (!input.reason?.trim()) throw new AppError('Please give a reason for cancelling.');
  return ctx.db.transaction(() => {
    const date = ctx.today();
    if (e.legacy_payment_id) {
      reverseVoucher(ctx, 'expense', e.legacy_payment_id, date, 'cancel_expense');
      ctx.db.exec('UPDATE payments SET cancelled = 1 WHERE id = ?', [e.legacy_payment_id]);
    } else {
      reverseVoucher(ctx, 'expense_bill', e.id, date, 'cancel_expense_bill');
      for (const p of ctx.db.query<{ id: number }>('SELECT id FROM payments WHERE expense_id = ? AND cancelled = 0', [e.id])) {
        reverseVoucher(ctx, 'expense_payment', p.id, date, 'cancel_expense_payment');
        ctx.db.exec('UPDATE payments SET cancelled = 1 WHERE id = ?', [p.id]);
      }
      for (const m of ctx.db.query<{ id: number }>("SELECT id FROM money_moves WHERE expense_id = ? AND cancelled = 0 AND kind = 'advance_recovery'", [e.id])) {
        reverseVoucher(ctx, 'move', m.id, date, 'cancel_move');
        ctx.db.exec('UPDATE money_moves SET cancelled = 1 WHERE id = ?', [m.id]);
      }
    }
    ctx.db.exec("UPDATE expenses SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [input.reason.trim(), e.id]);
    audit(ctx, 'expense.cancel', 'expense', e.id, { reason: input.reason, amount: e.amount, category: e.category });
    return getExpense(ctx, e.id);
  });
}

/** A single payment against an expense bill can be undone; the bill goes back to unpaid/partial. */
export function cancelExpensePayment(ctx: Ctx, paymentId: number) {
  const p = ctx.db.get<{ expense_id: number | null; cancelled: number }>('SELECT expense_id, cancelled FROM payments WHERE id = ?', [paymentId]);
  if (!p?.expense_id) throw new AppError('Payment not found.');
  const e = getExpense(ctx, p.expense_id);
  guard(ctx, e.employee_id ? 'payroll.manage' : 'expense.create');
  if (p.cancelled) throw new AppError('Already cancelled.');
  if (e.legacy_payment_id === paymentId) return cancelExpense(ctx, { id: e.id, reason: 'Payment cancelled' });
  return ctx.db.transaction(() => {
    reverseVoucher(ctx, 'expense_payment', paymentId, ctx.today(), 'cancel_expense_payment');
    ctx.db.exec('UPDATE payments SET cancelled = 1 WHERE id = ?', [paymentId]);
    refreshStatus(ctx, e.id);
    audit(ctx, 'expense.payment_cancel', 'expense', e.id, { paymentId });
    return getExpense(ctx, e.id);
  });
}

export function getExpense(ctx: Ctx, id: number): Expense {
  guard(ctx, 'expense.view');
  const e = ctx.db.get<Expense>(`${SELECT} WHERE e.id = ?`, [id]);
  if (!e) throw new AppError('Expense not found.', 'NOT_FOUND');
  if (e.employee_id) guard(ctx, 'payroll.manage');
  e.payments = [
    ...ctx.db.query<NonNullable<Expense['payments']>[number]>(
      "SELECT p.id, 'payment' AS kind, p.amount, p.mode, p.date, p.cancelled, u.name AS by, p.created_at FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.expense_id = ? ORDER BY p.id",
      [id],
    ),
    ...ctx.db.query<NonNullable<Expense['payments']>[number]>(
      "SELECT m.id, 'advance' AS kind, m.amount, 'advance' AS mode, m.date, m.cancelled, u.name AS by, m.created_at FROM money_moves m LEFT JOIN users u ON u.id = m.created_by WHERE m.expense_id = ? AND m.kind = 'advance_recovery' ORDER BY m.id",
      [id],
    ),
  ];
  return e;
}

export function listExpenses(
  ctx: Ctx,
  opts: { from?: string; to?: string; categoryId?: number; status?: 'due' | 'paid' | 'cancelled' | 'all'; q?: string; employeeId?: number; limit?: number } = {},
): Expense[] {
  guard(ctx, 'expense.view');
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.from) where.push('e.date >= ?'), params.push(opts.from);
  if (opts.to) where.push('e.date <= ?'), params.push(opts.to);
  if (opts.categoryId) where.push('e.category_id = ?'), params.push(opts.categoryId);
  if (opts.employeeId) where.push('e.employee_id = ?'), params.push(opts.employeeId);
  if (opts.status === 'due') where.push("e.status IN ('unpaid','partial')");
  else if (opts.status === 'paid') where.push("e.status = 'paid'");
  else if (opts.status === 'cancelled') where.push("e.status = 'cancelled'");
  if (opts.q?.trim()) where.push('(e.payee LIKE ? OR e.description LIKE ? OR e.bill_no LIKE ? OR c.name LIKE ?)'), params.push(...Array(4).fill(`%${opts.q.trim()}%`));
  // Salaries are private: only people with payroll access see them in lists.
  if (!allowed(ctx, 'payroll.manage')) where.push('e.employee_id IS NULL');
  return ctx.db.query<Expense>(
    `${SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${opts.status === 'due' ? 'COALESCE(e.due_date, e.date)' : 'e.date DESC'}, e.id DESC LIMIT ?`,
    [...params, opts.limit ?? 500] as never,
  );
}

/** Previous payees, for the autocomplete. */
export function payees(ctx: Ctx): string[] {
  guard(ctx, 'expense.view');
  return ctx.db.query<{ payee: string }>("SELECT payee FROM expenses WHERE payee IS NOT NULL AND employee_id IS NULL GROUP BY payee ORDER BY MAX(id) DESC LIMIT 100").map((r) => r.payee);
}

/* ───────── recurring ───────── */

export interface Recurring {
  id: number;
  category_id: number;
  category: string;
  payee: string | null;
  description: string | null;
  amount: number;
  every: 'day' | 'week' | 'month' | 'quarter' | 'year';
  /** Repeat every N days / weeks / months… */
  every_n: number;
  /** Weekdays with nothing due, comma list (0 = Sunday). */
  skip_weekdays: string | null;
  /** Earliest date bills are made for (to add missed days from before the schedule was set up). */
  bills_from: string | null;
  anchor_date: string;
  end_date: string | null;
  auto_pay_mode: PayMode | null;
  gst_rate: number;
  payee_gstin: string | null;
  active: number;
  created_at: string;
  next_due?: string | null;
  skips?: RecurringSkip[];
  /** Unpaid bills of this schedule: how many and how much. */
  due_count?: number;
  due_amount?: number;
}

export interface RecurringSkip {
  id?: number;
  from_date: string;
  to_date: string;
  note?: string | null;
}

function skipsOf(ctx: Ctx, recurringId: number): RecurringSkip[] {
  return ctx.db.query<RecurringSkip>('SELECT id, from_date, to_date, note FROM recurring_skips WHERE recurring_id = ? ORDER BY from_date', [recurringId]);
}

export { dueDates, occurrence };

function nextDue(r: Pick<Recurring, 'anchor_date' | 'every' | 'end_date' | 'every_n' | 'skip_weekdays'>, skips: RecurringSkip[], after: string): string | null {
  return dueDates(r, skips, addDays(after, 1), '9999-12-31', 1)[0] ?? null;
}

export const LEAD_DAYS = 7;

export function listRecurring(ctx: Ctx): Recurring[] {
  guard(ctx, 'expense.view');
  const today = ctx.today();
  return ctx.db
    .query<Recurring>('SELECT r.*, c.name AS category FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id ORDER BY r.active DESC, r.id')
    .map((r) => {
      const last = ctx.db.get<{ k: string | null }>('SELECT MAX(recurring_key) AS k FROM expenses WHERE recurring_id = ?', [r.id])?.k;
      const skips = skipsOf(ctx, r.id);
      const due = ctx.db.get<{ n: number; s: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(amount - paid), 0) AS s FROM expenses WHERE recurring_id = ? AND status IN ('unpaid','partial')", [r.id])!;
      return { ...r, skips, due_count: due.n, due_amount: due.s, next_due: r.active ? nextDue(r, skips, last && last > addDays(today, -1) ? last : addDays(today, -1)) : null };
    });
}

export function saveRecurring(
  ctx: Ctx,
  input: {
    id?: number; categoryId: number; amount: number; every: Recurring['every']; everyN?: number; skipWeekdays?: number[]; skips?: RecurringSkip[]; billsFrom?: string | null;
    anchorDate: string; endDate?: string | null; payee?: string; description?: string; autoPayMode?: PayMode | null; gstRate?: number; payeeGstin?: string | null; active?: boolean;
  },
  godownId?: number,
) {
  guard(ctx, 'expense.create');
  if (!(input.amount > 0)) throw new AppError('Enter the amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate ?? '')) throw new AppError('Pick the first due date.');
  if (input.endDate && input.endDate < input.anchorDate) throw new AppError('End date is before the first due date.');
  if (!['day', 'week', 'month', 'quarter', 'year'].includes(input.every)) throw new AppError('Pick how often it repeats.');
  const everyN = Math.round(input.everyN ?? 1);
  if (!(everyN >= 1 && everyN <= 365)) throw new AppError('Repeat every 1 to 365.');
  const skipWd = [...new Set(input.skipWeekdays ?? [])].filter((d) => d >= 0 && d <= 6).sort();
  if (skipWd.length === 7) throw new AppError('Every day of the week is skipped, so nothing would ever be due.');
  const skips = (input.skips ?? []).map((x) => ({ from_date: x.from_date, to_date: x.to_date || x.from_date, note: x.note?.trim() || null }));
  for (const x of skips) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.from_date) || x.to_date < x.from_date) throw new AppError('A closed-days range has a wrong date.');
  }
  const gstin = input.payeeGstin?.trim().toUpperCase() || null;
  if (gstin && !validateGstin(gstin)) throw new AppError("The payee's GSTIN is not valid.");
  const vals = [input.categoryId, input.payee?.trim() || null, input.description?.trim() || null, input.amount, input.every, everyN, skipWd.join(',') || null, input.billsFrom || null, input.anchorDate, input.endDate || null, input.autoPayMode || null, input.gstRate ?? 0, gstin, input.active === false ? 0 : 1];
  return ctx.db.transaction(() => {
    let id = input.id;
    if (id) {
      ctx.db.exec('UPDATE recurring_expenses SET category_id=?, payee=?, description=?, amount=?, every=?, every_n=?, skip_weekdays=?, bills_from=?, anchor_date=?, end_date=?, auto_pay_mode=?, gst_rate=?, payee_gstin=?, active=? WHERE id = ?', [...vals, id] as never);
      audit(ctx, 'recurring.update', 'recurring', id, { amount: input.amount, every: input.every, active: input.active !== false });
    } else {
      id = ctx.db.exec('INSERT INTO recurring_expenses (category_id, payee, description, amount, every, every_n, skip_weekdays, bills_from, anchor_date, end_date, auto_pay_mode, gst_rate, payee_gstin, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [...vals, ctx.session!.userId, `${ctx.today()} ${localNow().slice(11)}`] as never).lastId;
      audit(ctx, 'recurring.create', 'recurring', id, { amount: input.amount, every: input.every });
    }
    if (godownId) ctx.db.exec('UPDATE recurring_expenses SET godown_id = ? WHERE id = ?', [godownId, id]);
    if (input.skips) {
      ctx.db.exec('DELETE FROM recurring_skips WHERE recurring_id = ?', [id]);
      for (const x of skips) ctx.db.exec('INSERT INTO recurring_skips (recurring_id, from_date, to_date, note) VALUES (?,?,?,?)', [id, x.from_date, x.to_date, x.note]);
    }
    dropOffDays(ctx, id);
    syncRecurring(ctx);
    return id;
  });
}

/**
 * Create the bills for recurring expenses that are due (or due within LEAD_DAYS), once each.
 * Only occurrences on/after the day the schedule was set up are created — no surprise back-dated bills.
 * Auto-pay schedules (bank auto-debit, UPI autopay) are marked paid straight away.
 */
export function syncRecurring(ctx: Ctx): number {
  if (!ctx.session) return 0;
  // With several devices, only the shop's first device raises recurring bills, so each is created once.
  if (seriesCode(ctx.db as SqlJsAdapter)) return 0;
  const today = ctx.today();
  const horizon = addDays(today, LEAD_DAYS);
  const rows = ctx.db.query<Recurring>('SELECT r.*, c.name AS category FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id WHERE r.active = 1');
  let created = 0;
  ctx.db.transaction(() => {
    for (const r of rows) {
      const setUp = r.created_at.slice(0, 10);
      // From the day it was set up (no surprise back-dated bills), or from `bills_from` if the owner asked for missed days.
      const from = r.bills_from ?? (setUp > r.anchor_date ? setUp : r.anchor_date);
      // Daily bills are made on the day; others a week ahead so they show up in Bills to pay in time.
      const until = r.every === 'day' ? today : horizon;
      for (const due of dueDates(r, skipsOf(ctx, r.id), from < r.anchor_date ? r.anchor_date : from, until)) {
        if (ctx.db.get('SELECT 1 FROM expenses WHERE recurring_id = ? AND recurring_key = ?', [r.id, due])) continue;
        // Auto-pay happens on the due date, not before.
        const autopay = r.auto_pay_mode && due <= today;
        createExpenseAsSystem(ctx, {
          date: due, categoryId: r.category_id, amount: r.amount, payee: r.payee, description: r.description ?? `${r.category} (${r.every}ly)`,
          gstRate: r.gst_rate, payeeGstin: r.payee_gstin, claimItc: !!r.payee_gstin && r.gst_rate > 0, dueDate: due,
          payNow: autopay ? { mode: r.auto_pay_mode! } : null, recurringId: r.id, recurringKey: due,
        });
        created++;
      }
    }
  });
  return created;
}

/** Unpaid bills of a schedule that now fall on an off day (skipped weekday / closed days) are cancelled. */
function dropOffDays(ctx: Ctx, recurringId: number) {
  const r = ctx.db.get<Recurring>('SELECT * FROM recurring_expenses WHERE id = ?', [recurringId])!;
  const skips = skipsOf(ctx, recurringId);
  const open = ctx.db.query<{ id: number; recurring_key: string }>("SELECT id, recurring_key FROM expenses WHERE recurring_id = ? AND status = 'unpaid' AND paid = 0", [recurringId]);
  for (const e of open) if (isOff(r, skips, e.recurring_key)) cancelExpense(ctx, { id: e.id, reason: 'Nothing due that day (shop closed / skipped)' });
}

/** A schedule's unpaid days (oldest first) and the next days that could be paid ahead. */
export function recurringDue(ctx: Ctx, recurringId: number, aheadDays = 14) {
  guard(ctx, 'expense.view');
  const r = ctx.db.get<Recurring>('SELECT r.*, c.name AS category FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id WHERE r.id = ?', [recurringId]);
  if (!r) throw new AppError('Repeating expense not found.');
  const unpaid = ctx.db.query<{ id: number; date: string; amount: number; paid: number; due: number }>(
    "SELECT id, recurring_key AS date, amount, paid, amount - paid AS due FROM expenses WHERE recurring_id = ? AND status IN ('unpaid','partial') AND COALESCE(approval, 'ok') <> 'pending' ORDER BY recurring_key",
    [recurringId],
  );
  const last = ctx.db.get<{ k: string | null }>('SELECT MAX(recurring_key) AS k FROM expenses WHERE recurring_id = ?', [recurringId])?.k ?? addDays(ctx.today(), -1);
  const ahead = r.active ? dueDates(r, skipsOf(ctx, recurringId), addDays(last > ctx.today() ? last : ctx.today(), 1), '9999-12-31', aheadDays) : [];
  const lastPaid = ctx.db.get<{ d: string | null }>("SELECT MAX(recurring_key) AS d FROM expenses WHERE recurring_id = ? AND status = 'paid'", [recurringId])?.d ?? null;
  return { recurring: r, unpaid, total: unpaid.reduce((a, x) => a + x.due, 0), ahead, lastPaid };
}

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Pay several days of a repeating expense at once (e.g. four days of missed rent), oldest first.
 * Either a number of days, or an amount (the last day may be paid in part). `ahead` also pays
 * that many upcoming days in advance.
 */
export function payRecurring(ctx: Ctx, input: { recurringId: number; days?: number; amount?: number; ahead?: number; mode: PayMode; date?: string; reference?: string }) {
  guard(ctx, 'expense.create');
  const st = recurringDue(ctx, input.recurringId, Math.max(0, input.ahead ?? 0));
  if ((input.days ?? 0) <= 0 && (input.amount ?? 0) <= 0 && (input.ahead ?? 0) <= 0) throw new AppError('Choose the days or the amount to pay.');
  if ((input.ahead ?? 0) > st.ahead.length) throw new AppError(`Only ${st.ahead.length} upcoming days can be paid ahead.`);
  return ctx.db.transaction(() => {
    const r = st.recurring;
    // Bills for the days paid in advance.
    for (const due of st.ahead.slice(0, input.ahead ?? 0)) {
      createExpenseAsSystem(ctx, {
        date: due, categoryId: r.category_id, amount: r.amount, payee: r.payee, description: r.description ?? r.category, gstRate: r.gst_rate,
        payeeGstin: r.payee_gstin, claimItc: !!r.payee_gstin && r.gst_rate > 0, dueDate: due, payNow: null, recurringId: r.id, recurringKey: due,
      });
    }
    const open = recurringDue(ctx, input.recurringId, 0).unpaid;
    let pick = open;
    if (input.amount && input.amount > 0) {
      const total = open.reduce((a, x) => a + x.due, 0);
      if (input.amount > total) throw new AppError(`Only ₹${(total / 100).toFixed(2)} is due. Pay days in advance to pay more.`);
    } else if (input.days && input.days > 0 && !input.ahead) {
      // Without `ahead`: the oldest N unpaid days. With `ahead`: everything due plus the days ahead.
      if (input.days > open.length) throw new AppError(`Only ${open.length} ${open.length === 1 ? 'day is' : 'days are'} due.`);
      pick = open.slice(0, input.days);
    }
    let left = input.amount && input.amount > 0 ? input.amount : Infinity;
    const paid: Array<{ date: string; amount: number }> = [];
    for (const e of pick) {
      if (left <= 0) break;
      const amt = Math.min(e.due, left);
      paid.push({ date: e.date, amount: amt });
      left -= amt;
    }
    if (!paid.length) throw new AppError('Nothing to pay.');
    const label = paid.length === 1 ? shortDate(paid[0].date) : `${shortDate(paid[0].date)} – ${shortDate(paid[paid.length - 1].date)}`;
    const note = `${r.payee ?? r.category} ${label} (${paid.length} ${r.every === 'day' ? (paid.length === 1 ? 'day' : 'days') : 'bills'})`;
    for (const x of paid) {
      const e = pick.find((y) => y.date === x.date)!;
      payExpense(ctx, { id: e.id, amount: x.amount, mode: input.mode, date: input.date, reference: input.reference || note });
    }
    const total = paid.reduce((a, x) => a + x.amount, 0);
    audit(ctx, 'recurring.pay', 'recurring', r.id, { days: paid.length, amount: total, from: paid[0].date, to: paid[paid.length - 1].date });
    return { days: paid.length, amount: total, from: paid[0].date, to: paid[paid.length - 1].date, note };
  });
}

/** Recurring bills are created on behalf of whoever opened the app; permission was checked when the schedule was made. */
function createExpenseAsSystem(ctx: Ctx, input: ExpenseInput) {
  const real = ctx.session;
  ctx.session = { userId: real!.userId, name: real!.name, role: 'owner' };
  try {
    createExpense(ctx, input);
  } finally {
    ctx.session = real;
  }
}

/* ───────── staff advances (balance helper used by payExpense) ───────── */

export function employeeAdvance(ctx: Ctx, employeeId: number): number {
  return ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'EMP_ADVANCE' AND employee_id = ?", [employeeId])!.b;
}

export { salaryCategoryId };

/* ───────── approvals & petty cash ───────── */

export function approveExpense(ctx: Ctx, input: { id: number; approve: boolean; payNow?: { mode: PayMode } | null }) {
  guard(ctx, 'users.manage'); // owner
  const e = ctx.db.get<{ approval: string | null; amount: number; petty: number }>('SELECT approval, amount, petty FROM expenses WHERE id = ?', [input.id]);
  if (!e) throw new AppError('Expense not found.');
  if (e.approval !== 'pending') throw new AppError('This expense is not waiting for approval.');
  return ctx.db.transaction(() => {
    const s = requireSession(ctx);
    ctx.db.exec('UPDATE expenses SET approval = ?, approved_by = ? WHERE id = ?', [input.approve ? 'approved' : 'rejected', s.userId, input.id]);
    if (!input.approve) cancelExpense(ctx, { id: input.id, reason: 'Rejected by the owner' });
    else if (input.payNow) payExpense(ctx, { id: input.id, amount: e.amount, mode: input.payNow.mode });
    audit(ctx, input.approve ? 'expense.approve' : 'expense.reject', 'expense', input.id);
    return getExpense(ctx, input.id);
  });
}

export function pendingApprovals(ctx: Ctx) {
  guard(ctx, 'expense.view');
  return ctx.db.query<Expense>(`${SELECT} WHERE e.approval = 'pending' AND e.status <> 'cancelled' ORDER BY e.date`);
}

/**
 * Petty cash (imprest): the counter keeps a fixed float; small expenses are paid from it; topping
 * it back up restores the float. The cash is part of the shop's cash in the books throughout.
 */
export function pettyCash(ctx: Ctx) {
  guard(ctx, 'expense.view');
  const float = ctx.db.get<{ f: number }>('SELECT petty_cash_float AS f FROM company WHERE id = 1')!.f;
  // Top-ups are recorded in the audit log with the shop's local time (expenses use local time too).
  const last = ctx.db.get<{ at: string }>("SELECT json_extract(details, '$.at') AS at FROM audit_log WHERE action = 'petty.topup' ORDER BY id DESC LIMIT 1")?.at ?? '0000';
  const spent = ctx.db.query<{ id: number; date: string; category: string; payee: string | null; amount: number }>(
    `SELECT e.id, e.date, c.name AS category, e.payee, e.amount FROM expenses e JOIN expense_categories c ON c.id = e.category_id
     WHERE e.petty = 1 AND e.status <> 'cancelled' AND e.created_at > ? ORDER BY e.created_at`,
    [last],
  );
  const total = spent.reduce((a, x) => a + x.amount, 0);
  return { float, spent: total, inBox: float - total, since: last === '0000' ? null : last, items: spent };
}

export function pettyTopUp(ctx: Ctx) {
  guard(ctx, 'money.move');
  const p = pettyCash(ctx);
  audit(ctx, 'petty.topup', 'company', 1, { amount: p.spent, at: localNow() });
  return p.spent;
}
