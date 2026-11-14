import { isMobile, normalizePhone, roundHalfUp, type Role } from '@hisaab/core';
import type { PayMode } from '../types';
import { allowed, AppError, audit, guard, localNow, modeAccount, postVoucher, requireSession, type Ctx } from './base';
import { saveUser } from './company';
import { createExpense, employeeAdvance, getExpense, payExpense, salaryCategoryId, type Expense } from './expenses';

export interface Employee {
  id: number;
  name: string;
  phone: string | null;
  designation: string | null;
  monthly_salary: number;
  joined_on: string | null;
  pay_mode: PayMode;
  bank_account: string | null;
  bank_ifsc: string | null;
  incentive_pct: number;
  user_id: number | null;
  user_name?: string | null;
  active: number;
  created_at: string;
  advance: number; // outstanding advance they owe the shop
  salary_due: number; // salary & bonus bills not yet paid
  taken_this_month?: number; // advances given this calendar month
  last_paid?: string | null;
}

const BAL = `
  (SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_entries l WHERE l.account = 'EMP_ADVANCE' AND l.employee_id = e.id) AS advance,
  (SELECT COALESCE(SUM(x.amount - x.paid), 0) FROM expenses x WHERE x.employee_id = e.id AND x.status IN ('unpaid','partial')) AS salary_due,
  (SELECT MAX(p.date) FROM payments p JOIN expenses x ON x.id = p.expense_id WHERE x.employee_id = e.id AND p.cancelled = 0) AS last_paid,
  (SELECT name FROM users u WHERE u.id = e.user_id) AS user_name`;

export function listEmployees(ctx: Ctx, opts: { includeInactive?: boolean } = {}): Employee[] {
  guard(ctx, 'payroll.manage');
  const month = ctx.today().slice(0, 7);
  return ctx.db.query<Employee>(
    `SELECT e.*, ${BAL},
       (SELECT COALESCE(SUM(m.amount), 0) FROM money_moves m WHERE m.employee_id = e.id AND m.kind = 'advance' AND m.cancelled = 0 AND substr(m.date, 1, 7) = ?) AS taken_this_month
     FROM employees e ${opts.includeInactive ? '' : 'WHERE e.active = 1'} ORDER BY e.active DESC, e.name`,
    [month],
  );
}

export interface EmployeeInput {
  id?: number;
  name: string;
  phone?: string | null;
  designation?: string | null;
  monthlySalary: number;
  joinedOn?: string | null;
  payMode?: PayMode;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  incentivePct?: number;
  active?: boolean;
  /** Link to an existing PIN login (null = no login). */
  userId?: number | null;
  /** Or create a new cashier PIN login for this employee. */
  newLoginPin?: string | null;
}

export function saveEmployee(ctx: Ctx, input: EmployeeInput) {
  guard(ctx, 'payroll.manage');
  if (!input.name?.trim()) throw new AppError("Enter the employee's name.");
  if (!(input.monthlySalary >= 0)) throw new AppError('Enter the monthly salary.');
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (phone && !isMobile(phone)) throw new AppError('Enter a 10-digit mobile number.');
  const pct = input.incentivePct ?? 0;
  if (pct < 0 || pct > 20) throw new AppError('Incentive must be between 0% and 20% of sales.');
  return ctx.db.transaction(() => {
    let userId = input.userId ?? null;
    if (input.newLoginPin) userId = saveUser(ctx, { name: input.name.trim(), role: 'cashier', pin: input.newLoginPin });
    if (userId) {
      const u = ctx.db.get<{ active: number; role: Role }>('SELECT active, role FROM users WHERE id = ?', [userId]);
      if (!u?.active) throw new AppError('That login does not exist or is switched off.');
      if (u.role === 'owner') throw new AppError("The owner's login can't be linked to an employee.");
      const taken = ctx.db.get<{ name: string }>('SELECT name FROM employees WHERE user_id = ? AND id <> ?', [userId, input.id ?? 0]);
      if (taken) throw new AppError(`That login is already linked to ${taken.name}.`);
    }
    const vals = [
      input.name.trim(), phone, input.designation?.trim() || null, input.monthlySalary, input.joinedOn || null, input.payMode ?? 'cash',
      input.bankAccount?.trim() || null, input.bankIfsc?.trim().toUpperCase() || null, pct, userId, input.active === false ? 0 : 1,
    ];
    if (input.id) {
      ctx.db.exec('UPDATE employees SET name=?, phone=?, designation=?, monthly_salary=?, joined_on=?, pay_mode=?, bank_account=?, bank_ifsc=?, incentive_pct=?, user_id=?, active=? WHERE id = ?', [...vals, input.id] as never);
      audit(ctx, 'employee.update', 'employee', input.id, { salary: input.monthlySalary, active: input.active !== false, incentive: pct || undefined, login: !!userId });
      return input.id;
    }
    const id = ctx.db.exec('INSERT INTO employees (name, phone, designation, monthly_salary, joined_on, pay_mode, bank_account, bank_ifsc, incentive_pct, user_id, active) VALUES (?,?,?,?,?,?,?,?,?,?,?)', vals as never).lastId;
    audit(ctx, 'employee.create', 'employee', id, { name: input.name, salary: input.monthlySalary });
    return id;
  });
}

export function getEmployee(ctx: Ctx, id: number) {
  guard(ctx, 'payroll.manage');
  const e = ctx.db.get<Employee>(`SELECT e.*, ${BAL} FROM employees e WHERE e.id = ?`, [id]);
  if (!e) throw new AppError('Employee not found.', 'NOT_FOUND');
  return { ...e, timeline: timeline(ctx, id) };
}

/** One timeline per person: salary & bonus bills, their payments, advances, and money requests. */
function timeline(ctx: Ctx, employeeId: number) {
  return ctx.db.query<{ date: string; kind: string; ref_id: number; amount: number; note: string | null; mode: string | null; cancelled: number; created_at: string }>(
    `SELECT x.date, COALESCE(x.staff_pay_kind, 'salary') AS kind, x.id AS ref_id, x.amount, COALESCE(x.salary_period, x.description) AS note, NULL AS mode, x.status = 'cancelled' AS cancelled, x.created_at FROM expenses x WHERE x.employee_id = ?1
     UNION ALL SELECT p.date, COALESCE(x.staff_pay_kind, 'salary') || '_paid', p.id, p.amount, COALESCE(x.salary_period, x.description), p.mode, p.cancelled, p.created_at FROM payments p JOIN expenses x ON x.id = p.expense_id WHERE x.employee_id = ?1
     UNION ALL SELECT m.date, m.kind, m.id, m.amount, m.note, m.mode, m.cancelled, m.created_at FROM money_moves m WHERE m.employee_id = ?1
     UNION ALL SELECT substr(r.requested_at, 1, 10), 'request_' || r.status, r.id, r.amount, COALESCE(r.reason, '') || CASE WHEN r.decision_note IS NOT NULL THEN ' · ' || r.decision_note ELSE '' END, NULL, 0, r.requested_at FROM staff_requests r WHERE r.employee_id = ?1
     ORDER BY 1 DESC, 8 DESC`,
    [employeeId],
  );
}

const daysIn = (period: string) => new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7), 0)).getUTCDate();

/** Net sales (before GST, after returns) on bills this employee served in the month. */
export function salesServed(ctx: Ctx, employeeId: number, from: string, to: string): number {
  return ctx.db.get<{ s: number }>(
    `SELECT COALESCE(SUM(CASE WHEN kind = 'sale' THEN taxable ELSE -taxable END), 0) AS s FROM invoices
     WHERE served_by = ? AND kind IN ('sale','sale_return') AND status = 'final' AND date BETWEEN ? AND ?`,
    [employeeId, from, to],
  )!.s;
}

export interface SalaryRow {
  employeeId: number;
  name: string;
  designation: string | null;
  monthlySalary: number;
  daysInMonth: number;
  paidDays: number;
  incentivePct: number;
  salesServed: number;
  incentive: number;
  bonus: number;
  deduction: number;
  net: number;
  advance: number;
  existing: Pick<Expense, 'id' | 'amount' | 'paid' | 'status'> | null;
}

/** What each active employee would get for the month; rows already run show their saved bill. */
export function salaryPreview(ctx: Ctx, period: string): SalaryRow[] {
  guard(ctx, 'payroll.manage');
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError('Pick a month.');
  const d = daysIn(period);
  return listEmployees(ctx).map((e) => {
    const ex = ctx.db.get<{ id: number; amount: number; paid: number; status: Expense['status']; salary_detail: string | null }>(
      "SELECT id, amount, paid, status, salary_detail FROM expenses WHERE employee_id = ? AND salary_period = ? AND status <> 'cancelled'",
      [e.id, period],
    );
    const detail = ex?.salary_detail ? (JSON.parse(ex.salary_detail) as { paidDays: number; bonus: number; deduction: number; incentive?: number }) : null;
    const sales = salesServed(ctx, e.id, `${period}-01`, `${period}-31`);
    const incentive = detail?.incentive ?? (e.incentive_pct > 0 ? Math.max(0, roundHalfUp((sales * e.incentive_pct) / 100)) : 0);
    const paidDays = detail?.paidDays ?? d;
    const bonus = detail?.bonus ?? 0;
    const deduction = detail?.deduction ?? 0;
    return {
      employeeId: e.id, name: e.name, designation: e.designation, monthlySalary: e.monthly_salary, daysInMonth: d, paidDays, incentivePct: e.incentive_pct,
      salesServed: sales, incentive, bonus, deduction, net: ex?.amount ?? salaryFor(e.monthly_salary, d, paidDays, bonus + incentive, deduction), advance: e.advance,
      existing: ex ? { id: ex.id, amount: ex.amount, paid: ex.paid, status: ex.status } : null,
    };
  });
}

/** monthly × days worked ÷ days in month + extras (bonus, incentive) − deduction */
export const salaryFor = (monthly: number, days: number, paidDays: number, extras: number, deduction: number) =>
  Math.max(0, roundHalfUp((monthly * paidDays) / days) + extras - deduction);

/** Create the month's salary bills (one per employee). Re-running skips employees already done. */
export function runSalary(ctx: Ctx, input: { period: string; rows: Array<{ employeeId: number; paidDays: number; bonus?: number; deduction?: number; incentive?: number }> }) {
  guard(ctx, 'payroll.manage');
  const d = daysIn(input.period);
  const end = `${input.period}-${String(d).padStart(2, '0')}`;
  const date = end > ctx.today() ? ctx.today() : end;
  const cat = salaryCategoryId(ctx);
  const created: number[] = [];
  ctx.db.transaction(() => {
    for (const r of input.rows) {
      const e = ctx.db.get<{ id: number; name: string; monthly_salary: number }>('SELECT id, name, monthly_salary FROM employees WHERE id = ? AND active = 1', [r.employeeId]);
      if (!e) throw new AppError('Employee not found.');
      if (r.paidDays < 0 || r.paidDays > d) throw new AppError(`${e.name}: days worked must be between 0 and ${d}.`);
      if ((r.incentive ?? 0) < 0 || (r.bonus ?? 0) < 0 || (r.deduction ?? 0) < 0) throw new AppError(`${e.name}: amounts cannot be negative.`);
      if (ctx.db.get("SELECT 1 FROM expenses WHERE employee_id = ? AND salary_period = ? AND status <> 'cancelled'", [e.id, input.period])) continue;
      const incentive = r.incentive ?? 0;
      const net = salaryFor(e.monthly_salary, d, r.paidDays, (r.bonus ?? 0) + incentive, r.deduction ?? 0);
      if (net <= 0) continue;
      const parts = [r.paidDays < d ? `${r.paidDays}/${d} days` : '', incentive ? `incl. incentive ₹${(incentive / 100).toFixed(0)}` : ''].filter(Boolean).join(', ');
      const x = createExpense(ctx, {
        date, categoryId: cat, amount: net, payee: e.name, description: `Salary ${monthLabel(input.period)}${parts ? ` (${parts})` : ''}`,
        employeeId: e.id, salaryPeriod: input.period, dueDate: addDaysIso(end, 7) < date ? date : addDaysIso(end, 7),
        salaryDetail: { monthly: e.monthly_salary, daysInMonth: d, paidDays: r.paidDays, bonus: r.bonus ?? 0, deduction: r.deduction ?? 0, incentive },
      });
      ctx.db.exec("UPDATE expenses SET staff_pay_kind = 'salary' WHERE id = ?", [x.id]);
      created.push(x.id);
    }
    audit(ctx, 'salary.run', 'payroll', undefined, { period: input.period, bills: created.length });
  });
  return created;
}

/** Pay a salary or bonus bill: cash/bank part plus (optionally) the part adjusted from their advance. */
export function paySalary(ctx: Ctx, input: { expenseId: number; amount: number; mode: PayMode; recoverAdvance?: number; date?: string }) {
  guard(ctx, 'payroll.manage');
  return payExpense(ctx, { id: input.expenseId, amount: input.amount, mode: input.mode, recoverAdvance: input.recoverAdvance, date: input.date });
}

/** Give money before payday (an advance or a small amount on request), or record the employee paying some back. */
export function staffAdvance(ctx: Ctx, input: { employeeId: number; amount: number; mode: PayMode; direction: 'give' | 'return'; note?: string; date?: string }) {
  const s = guard(ctx, 'payroll.manage');
  if (!(input.amount > 0)) throw new AppError('Enter the amount.');
  const e = ctx.db.get<{ name: string }>('SELECT name FROM employees WHERE id = ?', [input.employeeId]);
  if (!e) throw new AppError('Employee not found.');
  if (input.direction === 'return' && input.amount > employeeAdvance(ctx, input.employeeId)) throw new AppError('That is more than the advance outstanding.');
  const date = input.date ?? ctx.today();
  const acc = modeAccount(input.mode);
  return ctx.db.transaction(() => {
    const kind = input.direction === 'give' ? 'advance' : 'advance_return';
    const id = ctx.db.exec(
      'INSERT INTO money_moves (kind, amount, from_account, to_account, mode, employee_id, note, date, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [kind, input.amount, input.direction === 'give' ? acc : null, input.direction === 'return' ? acc : null, input.mode, input.employeeId, input.note?.trim() || null, date, s.userId, localNow()],
    ).lastId;
    const sign = input.direction === 'give' ? 1 : -1;
    const label = `${input.direction === 'give' ? 'Advance to' : 'Advance returned by'} ${e.name}`;
    postVoucher(ctx, 'move', id, date, [
      { account: 'EMP_ADVANCE', employeeId: input.employeeId, amount: sign * input.amount, narration: label },
      { account: acc, amount: -sign * input.amount, narration: label },
    ]);
    audit(ctx, `staff.${kind}`, 'employee', input.employeeId, { amount: input.amount, mode: input.mode, name: e.name });
    return id;
  });
}

/* ───────── money requests from staff ───────── */

export interface StaffRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  amount: number;
  reason: string | null;
  status: 'pending' | 'approved' | 'declined' | 'withdrawn';
  requested_at: string;
  decided_at: string | null;
  decided_by_name: string | null;
  decision_note: string | null;
  paid_amount: number | null;
  monthly_salary?: number;
  advance?: number;
  salary_due?: number;
}

/** The employee record linked to whoever is logged in, if any. */
export function myEmployee(ctx: Ctx): { id: number; name: string } | null {
  if (!ctx.session) return null;
  return ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM employees WHERE user_id = ? AND active = 1', [ctx.session.userId]) ?? null;
}

function mustBeMe(ctx: Ctx) {
  requireSession(ctx);
  const me = myEmployee(ctx);
  if (!me) throw new AppError('Your login is not linked to a staff record. Ask the owner to link it in Staff & salary.');
  return me;
}

/** Staff ask for money themselves, from their own PIN login. The owner approves or declines. */
export function requestAdvance(ctx: Ctx, input: { amount: number; reason?: string }) {
  const me = mustBeMe(ctx);
  if (!(input.amount > 0) || !Number.isSafeInteger(input.amount)) throw new AppError('Enter how much you need.');
  if (!input.reason?.trim()) throw new AppError('Say what it is for — it helps the owner decide.');
  if (ctx.db.get("SELECT 1 FROM staff_requests WHERE employee_id = ? AND status = 'pending'", [me.id])) throw new AppError('You already have a request waiting. Withdraw it first to ask again.');
  return ctx.db.transaction(() => {
    const id = ctx.db.exec(
      "INSERT INTO staff_requests (employee_id, amount, reason, status, requested_by, requested_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      [me.id, input.amount, input.reason!.trim(), ctx.session!.userId, localNow()],
    ).lastId;
    audit(ctx, 'staff.request', 'staff_request', id, { name: me.name, amount: input.amount, reason: input.reason });
    return id;
  });
}

export function withdrawRequest(ctx: Ctx, id: number) {
  const me = mustBeMe(ctx);
  const r = ctx.db.get<{ employee_id: number; status: string }>('SELECT employee_id, status FROM staff_requests WHERE id = ?', [id]);
  if (!r || r.employee_id !== me.id) throw new AppError('Request not found.');
  if (r.status !== 'pending') throw new AppError('This request has already been decided.');
  ctx.db.transaction(() => {
    ctx.db.exec("UPDATE staff_requests SET status = 'withdrawn', decided_at = ? WHERE id = ?", [localNow(), id]);
    audit(ctx, 'staff.request_withdraw', 'staff_request', id, { name: me.name });
  });
  return true;
}

/** What a staff member sees about themselves — and nothing about anyone else. */
export function myPay(ctx: Ctx) {
  const me = mustBeMe(ctx);
  const e = ctx.db.get<Employee>(`SELECT e.*, ${BAL} FROM employees e WHERE e.id = ?`, [me.id])!;
  const requests = ctx.db.query<StaffRequest>(
    `SELECT r.*, ? AS employee_name, u.name AS decided_by_name FROM staff_requests r LEFT JOIN users u ON u.id = r.decided_by WHERE r.employee_id = ? ORDER BY r.id DESC LIMIT 20`,
    [me.name, me.id],
  );
  return { name: e.name, monthlySalary: e.monthly_salary, advance: e.advance, salaryDue: e.salary_due, lastPaid: e.last_paid ?? null, requests, timeline: timeline(ctx, me.id).slice(0, 30) };
}

export function listRequests(ctx: Ctx, opts: { status?: StaffRequest['status'] | 'all' } = {}) {
  guard(ctx, 'payroll.manage');
  const status = opts.status ?? 'pending';
  return ctx.db.query<StaffRequest>(
    `SELECT r.*, e.name AS employee_name, e.monthly_salary, u.name AS decided_by_name,
       (SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_entries l WHERE l.account = 'EMP_ADVANCE' AND l.employee_id = e.id) AS advance,
       (SELECT COALESCE(SUM(x.amount - x.paid), 0) FROM expenses x WHERE x.employee_id = e.id AND x.status IN ('unpaid','partial')) AS salary_due
     FROM staff_requests r JOIN employees e ON e.id = r.employee_id LEFT JOIN users u ON u.id = r.decided_by
     ${status === 'all' ? '' : 'WHERE r.status = ?'} ORDER BY r.id DESC LIMIT 200`,
    (status === 'all' ? [] : [status]) as never,
  );
}

export function pendingRequestCount(ctx: Ctx): number {
  if (!allowed(ctx, 'payroll.manage')) return 0;
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM staff_requests WHERE status = 'pending'")!.n;
}

/** Approve (and pay, fully or partly, as an advance) or decline a request. */
export function decideRequest(ctx: Ctx, input: { id: number; approve: boolean; amount?: number; mode?: PayMode; note?: string }) {
  const s = guard(ctx, 'payroll.manage');
  const r = ctx.db.get<{ employee_id: number; amount: number; status: string; reason: string | null; name: string }>(
    'SELECT r.employee_id, r.amount, r.status, r.reason, e.name FROM staff_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = ?',
    [input.id],
  );
  if (!r) throw new AppError('Request not found.');
  if (r.status !== 'pending') throw new AppError('This request has already been decided.');
  return ctx.db.transaction(() => {
    if (!input.approve) {
      if (!input.note?.trim()) throw new AppError('Add a short note so they know why.');
      ctx.db.exec("UPDATE staff_requests SET status = 'declined', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?", [s.userId, localNow(), input.note.trim(), input.id]);
      audit(ctx, 'staff.request_decline', 'staff_request', input.id, { name: r.name, amount: r.amount, note: input.note });
      return null;
    }
    const amount = input.amount ?? r.amount;
    if (!(amount > 0)) throw new AppError('Enter the amount to give.');
    if (amount > r.amount) throw new AppError('You can give up to the amount asked for.');
    const moveId = staffAdvance(ctx, { employeeId: r.employee_id, amount, mode: input.mode ?? 'cash', direction: 'give', note: r.reason ? `Requested: ${r.reason}` : 'Requested' });
    ctx.db.exec("UPDATE staff_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, paid_amount = ?, move_id = ? WHERE id = ?", [
      s.userId, localNow(), input.note?.trim() || null, amount, moveId, input.id,
    ]);
    audit(ctx, 'staff.request_approve', 'staff_request', input.id, { name: r.name, amount, asked: r.amount, mode: input.mode ?? 'cash' });
    return moveId;
  });
}

/* ───────── festival bonus ───────── */

export const FESTIVALS = ['Diwali', 'Holi', 'Eid', 'Raksha Bandhan', 'Ganesh Chaturthi', 'Durga Puja', 'Onam', 'Pongal / Sankranti', 'Gudi Padwa / Ugadi', 'Baisakhi', 'Christmas', 'Other'];

function bonusCategoryId(ctx: Ctx): number {
  const c = ctx.db.get<{ id: number }>("SELECT id FROM expense_categories WHERE name = 'Festival bonus & incentives'");
  if (c) return c.id;
  return ctx.db.exec("INSERT INTO expense_categories (name, grp) VALUES ('Festival bonus & incentives', 'Staff')").lastId;
}

/** Bonus for one or many people. Paid now, or added to their unpaid pay (settled at payday). */
export function giveBonus(ctx: Ctx, input: { occasion: string; rows: Array<{ employeeId: number; amount: number }>; payNow?: { mode: PayMode } | null; date?: string }) {
  guard(ctx, 'payroll.manage');
  const occasion = input.occasion?.trim();
  if (!occasion) throw new AppError('Pick the occasion.');
  const rows = input.rows.filter((r) => r.amount > 0);
  if (!rows.length) throw new AppError('Enter a bonus amount for at least one person.');
  const date = input.date ?? ctx.today();
  const cat = bonusCategoryId(ctx);
  const ids: number[] = [];
  ctx.db.transaction(() => {
    for (const r of rows) {
      if (!Number.isSafeInteger(r.amount)) throw new AppError('Bonus must be a valid amount.');
      const e = ctx.db.get<{ name: string }>('SELECT name FROM employees WHERE id = ? AND active = 1', [r.employeeId]);
      if (!e) throw new AppError('Employee not found.');
      const x = createExpense(ctx, {
        date, categoryId: cat, amount: r.amount, payee: e.name, description: `${occasion} bonus ${date.slice(0, 4)}`, employeeId: r.employeeId,
        payNow: input.payNow ?? null, dueDate: input.payNow ? null : date,
      });
      ctx.db.exec("UPDATE expenses SET staff_pay_kind = 'bonus' WHERE id = ?", [x.id]);
      ids.push(x.id);
    }
    audit(ctx, 'staff.bonus', 'payroll', undefined, { occasion, people: rows.length, total: rows.reduce((s, r) => s + r.amount, 0), paid: !!input.payNow });
  });
  return ids;
}

/* ───────── staff on bills ───────── */

/** Names only — for the "Served by" picker on the billing screen. No salary data. */
export function billers(ctx: Ctx) {
  guard(ctx, 'sale.create');
  return ctx.db.query<{ id: number; name: string; designation: string | null }>('SELECT id, name, designation FROM employees WHERE active = 1 ORDER BY name');
}

function addDaysIso(iso: string, n: number) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}
export const monthLabel = (period: string) => new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7) - 1, 1)).toLocaleString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export { getExpense };
