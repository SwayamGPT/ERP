import type { SqlJsAdapter } from '../adapter';
import { seriesCode } from '../sync/engine';
import { computeLine, isInterState, validateGstin } from '@hisaab/core';
import type { PayMode } from '../types';
import { addDays, allowed, AppError, audit, guard, localNow, modeAccount, postVoucher, reverseVoucher, type Ctx } from './base';
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
export function payExpense(ctx: Ctx, input: { id: number; amount: number; mode: PayMode; date?: string; recoverAdvance?: number; reference?: string }) {
  const e = ctx.db.get<Expense>(`${SELECT} WHERE e.id = ?`, [input.id]);
  if (!e) throw new AppError('Expense not found.');
  const s = guard(ctx, e.employee_id ? 'payroll.manage' : 'expense.create');
  if (e.status === 'cancelled') throw new AppError('This expense is cancelled.');
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
  return ctx.db.transaction(() => {
    if (input.amount > 0) {
      const pid = ctx.db.exec(
        "INSERT INTO payments (direction, kind, amount, mode, category, reference, note, date, expense_id, created_by, created_at) VALUES ('out', 'expense', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [input.amount, input.mode, e.category, input.reference ?? null, label, date, e.id, s.userId, localNow()],
      ).lastId;
      postVoucher(ctx, 'expense_payment', pid, date, [
        { account: 'EXPENSE_PAYABLE', amount: input.amount, narration: label },
        { account: modeAccount(input.mode), amount: -input.amount, narration: label },
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
  every: 'week' | 'month' | 'quarter' | 'year';
  anchor_date: string;
  end_date: string | null;
  auto_pay_mode: PayMode | null;
  gst_rate: number;
  payee_gstin: string | null;
  active: number;
  created_at: string;
  next_due?: string | null;
}

function addMonthsClamped(iso: string, n: number, day: number): string {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** k-th occurrence of a schedule (k = 0 is the anchor date). Month-ends clamp (31 Jan → 28 Feb). */
export function occurrence(anchor: string, every: Recurring['every'], k: number): string {
  if (every === 'week') return addDays(anchor, 7 * k);
  const day = +anchor.slice(8, 10);
  return addMonthsClamped(anchor, k * (every === 'month' ? 1 : every === 'quarter' ? 3 : 12), day);
}

function nextDue(r: Pick<Recurring, 'anchor_date' | 'every' | 'end_date'>, after: string): string | null {
  for (let k = 0; k < 2000; k++) {
    const d = occurrence(r.anchor_date, r.every, k);
    if (r.end_date && d > r.end_date) return null;
    if (d > after) return d;
  }
  return null;
}

export const LEAD_DAYS = 7;

export function listRecurring(ctx: Ctx): Recurring[] {
  guard(ctx, 'expense.view');
  const today = ctx.today();
  return ctx.db
    .query<Recurring>('SELECT r.*, c.name AS category FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id ORDER BY r.active DESC, r.id')
    .map((r) => {
      const last = ctx.db.get<{ k: string | null }>('SELECT MAX(recurring_key) AS k FROM expenses WHERE recurring_id = ?', [r.id])?.k;
      return { ...r, next_due: r.active ? nextDue(r, last ?? addDays(today, -1)) : null };
    });
}

export function saveRecurring(
  ctx: Ctx,
  input: { id?: number; categoryId: number; amount: number; every: Recurring['every']; anchorDate: string; endDate?: string | null; payee?: string; description?: string; autoPayMode?: PayMode | null; gstRate?: number; payeeGstin?: string | null; active?: boolean },
) {
  guard(ctx, 'expense.create');
  if (!(input.amount > 0)) throw new AppError('Enter the amount.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.anchorDate ?? '')) throw new AppError('Pick the first due date.');
  if (input.endDate && input.endDate < input.anchorDate) throw new AppError('End date is before the first due date.');
  if (!['week', 'month', 'quarter', 'year'].includes(input.every)) throw new AppError('Pick how often it repeats.');
  const gstin = input.payeeGstin?.trim().toUpperCase() || null;
  if (gstin && !validateGstin(gstin)) throw new AppError("The payee's GSTIN is not valid.");
  const vals = [input.categoryId, input.payee?.trim() || null, input.description?.trim() || null, input.amount, input.every, input.anchorDate, input.endDate || null, input.autoPayMode || null, input.gstRate ?? 0, gstin, input.active === false ? 0 : 1];
  return ctx.db.transaction(() => {
    let id = input.id;
    if (id) {
      ctx.db.exec('UPDATE recurring_expenses SET category_id=?, payee=?, description=?, amount=?, every=?, anchor_date=?, end_date=?, auto_pay_mode=?, gst_rate=?, payee_gstin=?, active=? WHERE id = ?', [...vals, id] as never);
      audit(ctx, 'recurring.update', 'recurring', id, { amount: input.amount, every: input.every, active: input.active !== false });
    } else {
      id = ctx.db.exec('INSERT INTO recurring_expenses (category_id, payee, description, amount, every, anchor_date, end_date, auto_pay_mode, gst_rate, payee_gstin, active, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [...vals, ctx.session!.userId, `${ctx.today()} ${localNow().slice(11)}`] as never).lastId;
      audit(ctx, 'recurring.create', 'recurring', id, { amount: input.amount, every: input.every });
    }
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
      const from = r.created_at.slice(0, 10) > r.anchor_date ? r.created_at.slice(0, 10) : r.anchor_date;
      for (let k = 0; k < 600; k++) {
        const due = occurrence(r.anchor_date, r.every, k);
        if (due > horizon || (r.end_date && due > r.end_date)) break;
        if (due < from) continue;
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
