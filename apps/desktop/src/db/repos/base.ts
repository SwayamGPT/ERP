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
  if (!can(s.role, perm)) throw new ForbiddenError(perm);
  return s;
}

export const allowed = (ctx: Ctx, perm: Permission) => !!ctx.session && can(ctx.session.role, perm);

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

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ─────────────── Double-entry posting ─────────────── */

export interface Posting {
  account: string;
  partyId?: number | null;
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
      'INSERT INTO ledger_entries (voucher_type, voucher_id, date, account, party_id, debit, credit, narration) VALUES (?,?,?,?,?,?,?,?)',
      [voucherType, voucherId, date, p.account, p.partyId ?? null, p.amount > 0 ? p.amount : 0, p.amount < 0 ? -p.amount : 0, p.narration ?? null],
    );
  }
}

/** Post exact reversals of an existing voucher (used for cancellation). */
export function reverseVoucher(ctx: Ctx, voucherType: string, voucherId: number, date: string, newType: string) {
  const rows = ctx.db.query<{ account: string; party_id: number | null; debit: number; credit: number }>(
    'SELECT account, party_id, debit, credit FROM ledger_entries WHERE voucher_type = ? AND voucher_id = ?',
    [voucherType, voucherId],
  );
  postVoucher(
    ctx,
    newType,
    voucherId,
    date,
    rows.map((r) => ({ account: r.account, partyId: r.party_id, amount: r.credit - r.debit, narration: 'Cancelled' })),
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
  INCOME: 'Other income',
  OPENING: 'Opening balance',
  CAPITAL: 'Owner capital',
};

export const modeAccount = (mode: string) => (mode === 'cash' ? 'CASH' : 'BANK');
