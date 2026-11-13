import { validateGstin, type PriceTier } from '@hisaab/core';
import type { LedgerRow, Party } from '../types';
import { AppError, audit, guard, postVoucher, type Ctx } from './base';
import { mustCompany } from './company';

const BAL_SQL = `(SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_entries l WHERE l.account = 'PARTY' AND l.party_id = p.id)`;
const LAST_SQL = `(SELECT MAX(date) FROM invoices v WHERE v.party_id = p.id AND v.status = 'final')`;

export function listParties(ctx: Ctx, opts: { kind?: 'customer' | 'supplier'; q?: string; filter?: 'due' | 'all'; limit?: number } = {}): Party[] {
  guard(ctx, 'party.view');
  const where = ['p.active = 1'];
  const params: unknown[] = [];
  if (opts.kind) where.push('p.kind = ?'), params.push(opts.kind);
  if (opts.q?.trim()) where.push('(p.name LIKE ? OR p.phone LIKE ? OR p.gstin LIKE ?)'), params.push(`%${opts.q.trim()}%`, `%${opts.q.trim()}%`, `${opts.q.trim().toUpperCase()}%`);
  if (opts.filter === 'due') where.push(`${BAL_SQL} <> 0`);
  return ctx.db.query<Party>(
    `SELECT p.*, ${BAL_SQL} AS balance, ${LAST_SQL} AS last_txn FROM parties p WHERE ${where.join(' AND ')}
     ORDER BY p.is_walkin DESC, p.name LIMIT ?`,
    [...params, opts.limit ?? 500] as never,
  );
}

export function getParty(ctx: Ctx, id: number): Party {
  guard(ctx, 'party.view');
  const p = ctx.db.get<Party>(`SELECT p.*, ${BAL_SQL} AS balance, ${LAST_SQL} AS last_txn FROM parties p WHERE p.id = ?`, [id]);
  if (!p) throw new AppError('Party not found.', 'NOT_FOUND');
  return p;
}

export function walkinParty(ctx: Ctx): Party {
  const p = ctx.db.get<{ id: number }>('SELECT id FROM parties WHERE is_walkin = 1 LIMIT 1');
  if (!p) throw new AppError('Walk-in customer missing.');
  return getParty(ctx, p.id);
}

export interface PartyInput {
  id?: number;
  kind: 'customer' | 'supplier';
  name: string;
  phone?: string | null;
  gstin?: string | null;
  state_code?: string | null;
  address?: string | null;
  city?: string | null;
  pincode?: string | null;
  price_tier?: PriceTier;
  credit_limit?: number;
  credit_days?: number;
  opening_balance?: number; // +ve they owe us, -ve we owe them
}

export function saveParty(ctx: Ctx, input: PartyInput): number {
  guard(ctx, 'party.edit');
  if (!input.name?.trim()) throw new AppError('Name is required.');
  const gstin = input.gstin?.trim().toUpperCase() || null;
  if (gstin && !validateGstin(gstin)) throw new AppError('That GSTIN does not look right. Please check it.');
  const phone = input.phone?.replace(/[^\d+]/g, '') || null;
  if (phone && phone.replace(/^\+?91/, '').length !== 10) throw new AppError('Enter a 10-digit mobile number.');
  const company = mustCompany(ctx);
  const state = gstin ? gstin.slice(0, 2) : input.state_code || company.state_code;
  const vals = [
    input.kind, input.name.trim(), phone, gstin, state, input.address ?? null, input.city ?? null, input.pincode ?? null,
    input.price_tier ?? (input.kind === 'supplier' ? 'retail' : 'retail'), input.credit_limit ?? 0, input.credit_days ?? 0,
  ];
  return ctx.db.transaction(() => {
    if (input.id) {
      const existing = ctx.db.get<{ is_walkin: number }>('SELECT is_walkin FROM parties WHERE id = ?', [input.id]);
      if (existing?.is_walkin) throw new AppError('The walk-in customer cannot be edited.');
      ctx.db.exec(
        'UPDATE parties SET kind=?, name=?, phone=?, gstin=?, state_code=?, address=?, city=?, pincode=?, price_tier=?, credit_limit=?, credit_days=? WHERE id = ?',
        [...vals, input.id] as never,
      );
      audit(ctx, 'party.update', 'party', input.id);
      return input.id;
    }
    const id = ctx.db.exec(
      'INSERT INTO parties (kind, name, phone, gstin, state_code, address, city, pincode, price_tier, credit_limit, credit_days) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      vals as never,
    ).lastId;
    if (input.opening_balance) {
      postVoucher(ctx, 'opening', id, ctx.today(), [
        { account: 'PARTY', partyId: id, amount: input.opening_balance, narration: 'Opening balance' },
        { account: 'OPENING', amount: -input.opening_balance, narration: 'Opening balance' },
      ]);
    }
    audit(ctx, 'party.create', 'party', id);
    return id;
  });
}

/** Running statement for a party. */
export function partyLedger(ctx: Ctx, partyId: number, opts: { from?: string; to?: string } = {}) {
  guard(ctx, 'party.view');
  const party = getParty(ctx, partyId);
  const from = opts.from ?? '0000-00-00';
  const to = opts.to ?? '9999-12-31';
  const opening =
    ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id = ? AND date < ?", [partyId, from])?.b ?? 0;
  const rows = ctx.db.query<LedgerRow>(
    `SELECT l.*, CASE WHEN l.voucher_type IN ('sale','purchase','sale_return','purchase_return','cancel_sale','cancel_purchase','cancel_sale_return','cancel_purchase_return')
                     THEN (SELECT number FROM invoices WHERE id = l.voucher_id) END AS number
     FROM ledger_entries l WHERE l.account = 'PARTY' AND l.party_id = ? AND l.date BETWEEN ? AND ? ORDER BY l.date, l.id`,
    [partyId, from, to],
  );
  let bal = opening;
  for (const r of rows) {
    bal += r.debit - r.credit;
    r.balance = bal;
  }
  return { party, opening, rows, closing: bal };
}
