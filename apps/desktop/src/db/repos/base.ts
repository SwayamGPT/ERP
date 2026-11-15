import { can, ForbiddenError, type Permission } from '@hisaab/core';
import type { StorageAdapter } from '../adapter';
import type { EnterpriseEntry, Session } from '../types';

export interface Ctx {
  db: StorageAdapter;
  session: Session | null;
  /** Injected clock for tests & seeding. Returns local yyyy-mm-dd. */
  today: () => string;
  /** Set by the worker host: which enterprises exist and which one is open. */
  meta?: { enterprises: EnterpriseEntry[]; enterpriseId: string | null };
}

export class AppError extends Error {
  constructor(message: string, public code = 'APP_ERROR') {
    super(message);
    this.name = 'AppError';
  }
}

export function requireSession(ctx: Ctx) {
  if (!ctx.session) throw new AppError('Please unlock Hisaab with your PIN first.', 'LOCKED');
  return ctx.session;
}

export function guard(ctx: Ctx, perm: Permission) {
  const s = requireSession(ctx);
  if (s.mustChangePin) throw new AppError('Choose your new 4-digit PIN first.', 'CHANGE_PIN');
  if (!can(s.role, perm, s)) throw new ForbiddenError(perm);
  return s;
}

export const allowed = (ctx: Ctx, perm: Permission) => !!ctx.session && can(ctx.session.role, perm, ctx.session);

/** Remove cost/margin fields for users without cost.view. Mutates and returns. */
export function stripCost<T extends object>(ctx: Ctx, obj: T, fields: string[] = ['purchase_price', 'cost', 'cost_total', 'profit', 'margin']): T {
  if (allowed(ctx, 'cost.view')) return obj;
  for (const f of fields) delete (obj as Record<string, unknown>)[f];
  return obj;
}

export function audit(ctx: Ctx, action: string, entity?: string, entityId?: number, details?: unknown) {
  ctx.db.exec('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?)', [
    ctx.session?.userId ?? null,
    action,
    entity ?? null,
    entityId ?? null,
    details === undefined ? null : JSON.stringify(details),
  ]);
}

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local wall-clock time as 'YYYY-MM-DD HH:MM:SS' — what the shop sees on its clock. */
export function localNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ─────────────── Double-entry posting ─────────────── */

export interface Posting {
  account: string;
  partyId?: number | null;
  employeeId?: number | null;
  /** positive = debit, negative = credit */
  amount: number;
  narration?: string;
}

/** Writes a balanced voucher. Throws if Σdebit ≠ Σcredit. Zero rows are skipped. */
export function postVoucher(ctx: Ctx, voucherType: string, voucherId: number, date: string, postings: Posting[]) {
  const sum = postings.reduce((s, p) => s + p.amount, 0);
  if (sum !== 0) throw new AppError(`Unbalanced voucher ${voucherType}#${voucherId}: off by ${sum} paise`, 'UNBALANCED');
  for (const p of postings) {
    if (!Number.isSafeInteger(p.amount)) throw new AppError(`Non-integer posting ${p.amount}`, 'UNBALANCED');
    if (p.amount === 0) continue;
    ctx.db.exec(
      'INSERT INTO ledger_entries (voucher_type, voucher_id, date, account, party_id, employee_id, debit, credit, narration, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [voucherType, voucherId, date, p.account, p.partyId ?? null, p.employeeId ?? null, p.amount > 0 ? p.amount : 0, p.amount < 0 ? -p.amount : 0, p.narration ?? null, ctx.session?.userId ?? null, localNow()],
    );
  }
}

/** Post exact reversals of an existing voucher (used for cancellation). */
export function reverseVoucher(ctx: Ctx, voucherType: string, voucherId: number, date: string, newType: string) {
  const rows = ctx.db.query<{ account: string; party_id: number | null; employee_id: number | null; debit: number; credit: number }>(
    'SELECT account, party_id, employee_id, debit, credit FROM ledger_entries WHERE voucher_type = ? AND voucher_id = ?',
    [voucherType, voucherId],
  );
  postVoucher(
    ctx,
    newType,
    voucherId,
    date,
    rows.map((r) => ({ account: r.account, partyId: r.party_id, employeeId: r.employee_id, amount: r.credit - r.debit, narration: 'Cancelled' })),
  );
}

export const ACCOUNTS: Record<string, string> = {
  CASH: 'Cash in hand',
  BANK: 'Bank / UPI',
  PARTY: 'Party',
  SALES: 'Sales',
  PURCHASE: 'Purchases',
  OUT_CGST: 'Output CGST',
  OUT_SGST: 'Output SGST',
  OUT_IGST: 'Output IGST',
  OUT_CESS: 'Output Cess',
  IN_CGST: 'Input CGST',
  IN_SGST: 'Input SGST',
  IN_IGST: 'Input IGST',
  IN_CESS: 'Input Cess',
  ROUND_OFF: 'Round off',
  OTHER_INCOME: 'Other charges collected',
  FREIGHT: 'Freight & other charges',
  EXPENSE: 'Expenses',
  EXPENSE_PAYABLE: 'Expense bills payable',
  EMP_ADVANCE: 'Staff advances',
  INCOME: 'Other income',
  OPENING: 'Opening balance',
  CAPITAL: 'Owner capital',
  DRAWINGS: 'Owner withdrawals',
  CASH_DIFF: 'Cash short / excess',
  COUPONS: 'Supplier coupons to redeem',
};

export const modeAccount = (mode: string) => (mode === 'cash' ? 'CASH' : mode === 'coupon' ? 'COUPONS' : 'BANK');

/**
 * Bank accounts. The first (id 1) keeps the ledger account 'BANK' that every older entry uses;
 * more accounts get 'BANK:<id>'. All of them together are "the bank" in totals and reports.
 */
export const bankCode = (id?: number | null) => (!id || id === 1 ? 'BANK' : `BANK:${id}`);
export const bankIdOf = (code: string) => (code === 'BANK' ? 1 : Number(code.split(':')[1]) || 1);
export const isBankCode = (code: string | null | undefined) => !!code && (code === 'BANK' || code.startsWith('BANK:'));
/** SQL condition for "any bank account" on ledger_entries.account. */
export const ANY_BANK = "(account = 'BANK' OR account LIKE 'BANK:%')";

export function defaultBankId(ctx: Ctx): number {
  return ctx.db.get<{ id: number }>('SELECT id FROM bank_accounts WHERE is_default = 1 AND active = 1 ORDER BY id LIMIT 1')?.id ?? 1;
}

/** The ledger account money paid this way lands in: cash, coupons, or a bank account (default if none chosen). */
export function payAccount(ctx: Ctx, mode: string, bankAccountId?: number | null) {
  if (mode === 'cash') return 'CASH';
  if (mode === 'coupon') return 'COUPONS';
  const id = bankAccountId ?? defaultBankId(ctx);
  if (bankAccountId && !ctx.db.get('SELECT 1 FROM bank_accounts WHERE id = ? AND active = 1', [bankAccountId])) throw new AppError('That bank account is closed or does not exist.');
  return bankCode(id);
}
