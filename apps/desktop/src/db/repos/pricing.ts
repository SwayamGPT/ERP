import type { SqlJsAdapter } from '../adapter';
import { seriesCode } from '../sync/engine';
import type { Company } from '../types';
import { AppError, audit, guard, type Ctx } from './base';

/* ───────── customer price lists ───────── */

export interface PriceList {
  id: number;
  name: string;
  active: number;
  items: number;
  customers: number;
}

export function listPriceLists(ctx: Ctx): PriceList[] {
  guard(ctx, 'party.view');
  return ctx.db.query<PriceList>(
    `SELECT l.*, (SELECT COUNT(*) FROM price_list_items WHERE list_id = l.id) AS items, (SELECT COUNT(*) FROM parties WHERE price_list_id = l.id) AS customers
     FROM price_lists l ORDER BY l.name`,
  );
}

export function savePriceList(ctx: Ctx, input: { id?: number; name: string; active?: boolean }) {
  guard(ctx, 'item.edit');
  const name = input.name.trim();
  if (!name) throw new AppError('Give the price list a name.');
  if (ctx.db.get('SELECT 1 FROM price_lists WHERE name = ? COLLATE NOCASE AND id <> ?', [name, input.id ?? 0])) throw new AppError('A price list with this name already exists.');
  if (input.id) {
    ctx.db.exec('UPDATE price_lists SET name = ?, active = ? WHERE id = ?', [name, input.active === false ? 0 : 1, input.id]);
    return input.id;
  }
  return ctx.db.exec('INSERT INTO price_lists (name, active) VALUES (?, 1)', [name]).lastId;
}

/** Prices per base unit (paise). price = null removes the item from the list. */
export function setListPrices(ctx: Ctx, input: { listId: number; prices: Array<{ itemId: number; price: number | null }> }) {
  guard(ctx, 'item.edit');
  if (!ctx.db.get('SELECT 1 FROM price_lists WHERE id = ?', [input.listId])) throw new AppError('Price list not found.');
  ctx.db.transaction(() => {
    for (const p of input.prices) {
      if (p.price == null) ctx.db.exec('DELETE FROM price_list_items WHERE list_id = ? AND item_id = ?', [input.listId, p.itemId]);
      else {
        if (!(p.price >= 0) || !Number.isSafeInteger(p.price)) throw new AppError('Prices must be in whole paise.');
        const ex = ctx.db.get<{ id: number }>('SELECT id FROM price_list_items WHERE list_id = ? AND item_id = ?', [input.listId, p.itemId]);
        if (ex) ctx.db.exec('UPDATE price_list_items SET price = ? WHERE id = ?', [p.price, ex.id]);
        else ctx.db.exec('INSERT INTO price_list_items (list_id, item_id, price) VALUES (?, ?, ?)', [input.listId, p.itemId, p.price]);
      }
    }
    audit(ctx, 'pricelist.update', 'price_list', input.listId, { count: input.prices.length });
  });
  return true;
}

export function listPrices(ctx: Ctx, listId: number) {
  guard(ctx, 'party.view');
  return ctx.db.query<{ item_id: number; name: string; base_unit: string; price: number; retail_price: number; mrp: number }>(
    'SELECT p.item_id, i.name, i.base_unit, p.price, i.retail_price, i.mrp FROM price_list_items p JOIN items i ON i.id = p.item_id WHERE p.list_id = ? ORDER BY i.name',
    [listId],
  );
}

export function assignPriceList(ctx: Ctx, input: { partyId: number; listId: number | null }) {
  guard(ctx, 'party.edit');
  ctx.db.exec('UPDATE parties SET price_list_id = ? WHERE id = ?', [input.listId, input.partyId]);
  return true;
}

/** itemId → base-unit price from the customer's price list (empty when none). */
export function partyPrices(ctx: Ctx, partyId: number): Record<number, number> {
  const rows = ctx.db.query<{ item_id: number; price: number }>(
    `SELECT pi.item_id, pi.price FROM parties p JOIN price_lists l ON l.id = p.price_list_id AND l.active = 1 JOIN price_list_items pi ON pi.list_id = l.id WHERE p.id = ?`,
    [partyId],
  );
  return Object.fromEntries(rows.map((r) => [r.item_id, r.price]));
}

/* ───────── coupons ───────── */

export interface Coupon {
  id: number;
  code: string;
  kind: 'pct' | 'flat';
  value: number; // % for pct, paise for flat
  min_bill: number;
  max_uses: number | null;
  valid_from: string | null;
  valid_to: string | null;
  active: number;
  used?: number;
}

export function listCoupons(ctx: Ctx): Coupon[] {
  guard(ctx, 'sale.view');
  return ctx.db.query<Coupon>('SELECT c.*, (SELECT COUNT(*) FROM coupon_uses WHERE coupon_id = c.id) AS used FROM coupons c ORDER BY c.active DESC, c.code');
}

export function saveCoupon(ctx: Ctx, c: Omit<Coupon, 'id' | 'active' | 'used'> & { id?: number; active?: boolean }) {
  guard(ctx, 'discount.any');
  const code = c.code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{3,20}$/.test(code)) throw new AppError('Coupon code: 3–20 letters or digits.');
  if (c.kind === 'pct' && !(c.value > 0 && c.value <= 90)) throw new AppError('Percentage must be between 0 and 90.');
  if (c.kind === 'flat' && !(c.value > 0)) throw new AppError('Enter the discount amount.');
  if (ctx.db.get('SELECT 1 FROM coupons WHERE code = ? COLLATE NOCASE AND id <> ?', [code, c.id ?? 0])) throw new AppError('This coupon code already exists.');
  const vals = [code, c.kind, c.value, c.min_bill ?? 0, c.max_uses ?? null, c.valid_from || null, c.valid_to || null, c.active === false ? 0 : 1];
  if (c.id) {
    ctx.db.exec('UPDATE coupons SET code = ?, kind = ?, value = ?, min_bill = ?, max_uses = ?, valid_from = ?, valid_to = ?, active = ? WHERE id = ?', [...vals, c.id]);
    return c.id;
  }
  return ctx.db.exec('INSERT INTO coupons (code, kind, value, min_bill, max_uses, valid_from, valid_to, active) VALUES (?,?,?,?,?,?,?,?)', vals).lastId;
}

/* ───────── loyalty ───────── */

export function pointsBalance(ctx: Ctx, partyId: number): number {
  return Math.round((ctx.db.get<{ p: number }>('SELECT COALESCE(SUM(points), 0) AS p FROM loyalty_moves WHERE party_id = ?', [partyId])!.p) * 100) / 100;
}

export function loyaltyFor(ctx: Ctx, partyId: number) {
  guard(ctx, 'party.view');
  const c = ctx.db.get<Company>('SELECT loyalty_enabled, loyalty_point_value FROM company WHERE id = 1')!;
  const points = pointsBalance(ctx, partyId);
  return { enabled: !!c.loyalty_enabled, points, worth: Math.floor(points * c.loyalty_point_value) };
}

export function adjustPoints(ctx: Ctx, input: { partyId: number; points: number; note?: string }) {
  guard(ctx, 'discount.any');
  ctx.db.transaction(() => {
    ctx.db.exec("INSERT INTO loyalty_moves (party_id, points, kind, date) VALUES (?, ?, 'adjust', ?)", [input.partyId, input.points, ctx.today()]);
    audit(ctx, 'loyalty.adjust', 'party', input.partyId, { points: input.points, note: input.note });
  });
  return pointsBalance(ctx, input.partyId);
}

/* ───────── applied on a bill (from buildInvoice / createInvoice) ───────── */

export interface Promo {
  couponId: number | null;
  couponCode: string | null;
  couponAmount: number;
  points: number;
  pointsAmount: number;
}

export const NO_PROMO: Promo = { couponId: null, couponCode: null, couponAmount: 0, points: 0, pointsAmount: 0 };

/** Work out a coupon and/or points redemption against a bill of `grand` paise. Throws a plain message when not allowed. */
export function resolvePromo(ctx: Ctx, company: Company, party: { id: number; is_walkin: number }, input: { couponCode?: string | null; redeemPoints?: number | null }, grand: number, today: string): Promo {
  const p: Promo = { ...NO_PROMO };
  if (input.couponCode?.trim()) {
    const c = ctx.db.get<Coupon>('SELECT * FROM coupons WHERE code = ? COLLATE NOCASE', [input.couponCode.trim()]);
    if (!c || !c.active) throw new AppError('This coupon code is not valid.', 'COUPON');
    if ((c.valid_from && today < c.valid_from) || (c.valid_to && today > c.valid_to)) throw new AppError('This coupon is not valid today.', 'COUPON');
    if (grand < c.min_bill) throw new AppError(`This coupon needs a bill of at least ₹${(c.min_bill / 100).toFixed(0)}.`, 'COUPON');
    const used = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM coupon_uses WHERE coupon_id = ?', [c.id])!.n;
    if (c.max_uses != null && used >= c.max_uses) throw new AppError('This coupon has been fully used.', 'COUPON');
    p.couponId = c.id;
    p.couponCode = c.code;
    p.couponAmount = Math.min(grand, c.kind === 'pct' ? Math.round((grand * c.value) / 100) : Math.round(c.value));
  }
  if (input.redeemPoints && input.redeemPoints > 0) {
    if (!company.loyalty_enabled) throw new AppError('Loyalty points are switched off in settings.');
    if (party.is_walkin) throw new AppError('Pick the customer to use their points.');
    const have = pointsBalance(ctx, party.id);
    if (input.redeemPoints > have + 1e-9) throw new AppError(`This customer has only ${have} points.`);
    const room = grand - p.couponAmount;
    const worth = Math.floor(input.redeemPoints * company.loyalty_point_value);
    p.pointsAmount = Math.max(0, Math.min(room, worth));
    p.points = company.loyalty_point_value > 0 ? Math.round((p.pointsAmount / company.loyalty_point_value) * 100) / 100 : 0;
  }
  return p;
}

/** After the invoice row exists: record coupon use, redeemed points and points earned. */
export function recordPromo(ctx: Ctx, company: Company, party: { id: number; is_walkin: number }, invoiceId: number, total: number, promo: Promo, applied: number, date: string) {
  if (applied > 0) ctx.db.exec('UPDATE invoices SET promo_discount = ? WHERE id = ?', [applied, invoiceId]);
  if (promo.couponId) ctx.db.exec('INSERT INTO coupon_uses (coupon_id, invoice_id, amount) VALUES (?, ?, ?)', [promo.couponId, invoiceId, Math.min(applied, promo.couponAmount)]);
  if (promo.points > 0) ctx.db.exec("INSERT INTO loyalty_moves (party_id, invoice_id, points, kind, date) VALUES (?, ?, ?, 'redeem', ?)", [party.id, invoiceId, -promo.points, date]);
  if (company.loyalty_enabled && !party.is_walkin) {
    const earned = Math.floor(((total / 100) * company.loyalty_points_per_100) / 100 * 100) / 100;
    if (earned > 0) ctx.db.exec("INSERT INTO loyalty_moves (party_id, invoice_id, points, kind, date) VALUES (?, ?, ?, 'earn', ?)", [party.id, invoiceId, earned, date]);
  }
}

/** Cancelling a bill gives back redeemed points, takes back earned ones and frees the coupon use. */
export function reversePromo(ctx: Ctx, invoiceId: number, date: string) {
  const rows = ctx.db.query<{ party_id: number; s: number }>('SELECT party_id, SUM(points) AS s FROM loyalty_moves WHERE invoice_id = ? GROUP BY party_id', [invoiceId]);
  for (const r of rows) if (Math.abs(r.s) > 1e-9) ctx.db.exec("INSERT INTO loyalty_moves (party_id, invoice_id, points, kind, date) VALUES (?, ?, ?, 'reverse', ?)", [r.party_id, invoiceId, -r.s, date]);
  ctx.db.exec('DELETE FROM coupon_uses WHERE invoice_id = ?', [invoiceId]);
}

/* ───────── payment reminders ───────── */

/**
 * Queue WhatsApp reminders for customers whose oldest unpaid bill is older than the setting, at most
 * once every N days each. Only the shop's first device raises them (so they aren't duplicated).
 */
export function refreshReminders(ctx: Ctx): number {
  guard(ctx, 'party.view');
  if (seriesCode(ctx.db as SqlJsAdapter)) return 0;
  const c = ctx.db.get<Company>('SELECT reminder_after_days, reminder_every_days FROM company WHERE id = 1');
  if (!c || !c.reminder_after_days) return 0;
  const today = ctx.today();
  const due = ctx.db.query<{ id: number; balance: number; oldest: string }>(
    `SELECT * FROM (SELECT p.id, (SELECT COALESCE(SUM(debit - credit), 0) FROM ledger_entries WHERE account = 'PARTY' AND party_id = p.id) AS balance,
       (SELECT MIN(date) FROM invoices WHERE party_id = p.id AND kind = 'sale' AND status = 'final' AND paid < total) AS oldest
     FROM parties p WHERE p.kind = 'customer' AND p.is_walkin = 0 AND p.active = 1 AND p.phone IS NOT NULL AND p.phone <> '')
     WHERE balance > 0 AND oldest IS NOT NULL AND julianday(?) - julianday(oldest) >= ?`,
    [today, c.reminder_after_days],
  );
  let n = 0;
  ctx.db.transaction(() => {
    for (const d of due) {
      const last = ctx.db.get<{ status: string; at: string }>("SELECT status, COALESCE(sent_at, due_on) AS at FROM reminders WHERE party_id = ? ORDER BY id DESC LIMIT 1", [d.id]);
      if (last?.status === 'pending') {
        ctx.db.exec("UPDATE reminders SET amount = ? WHERE party_id = ? AND status = 'pending'", [d.balance, d.id]);
        continue;
      }
      if (last && ctx.db.get<{ d: number }>('SELECT julianday(?) - julianday(?) AS d', [today, last.at.slice(0, 10)])!.d < c.reminder_every_days) continue;
      ctx.db.exec("INSERT INTO reminders (party_id, due_on, amount, status, created_at) VALUES (?, ?, ?, 'pending', ?)", [d.id, today, d.balance, `${today} 00:00:00`]);
      n++;
    }
  });
  return n;
}

export function dueReminders(ctx: Ctx) {
  guard(ctx, 'party.view');
  return ctx.db.query<{ id: number; party_id: number; name: string; phone: string; amount: number; due_on: string }>(
    "SELECT r.id, r.party_id, p.name, p.phone, r.amount, r.due_on FROM reminders r JOIN parties p ON p.id = r.party_id WHERE r.status = 'pending' AND r.due_on <= ? ORDER BY r.amount DESC",
    [ctx.today()],
  );
}

export function markReminder(ctx: Ctx, input: { id: number; status: 'sent' | 'skipped' }) {
  guard(ctx, 'party.view');
  ctx.db.exec("UPDATE reminders SET status = ?, sent_at = datetime('now') WHERE id = ? AND status = 'pending'", [input.status, input.id]);
  return true;
}

