import { lineGross, priceForUnit, resolvePrice, roundQty, type PriceTier } from '@hisaab/core';
import type { SqlJsAdapter } from '../adapter';
import { nextSeriesNo, seriesCode } from '../sync/engine';
import { AppError, allowed, audit, guard, localNow, type Ctx } from './base';

/**
 * Sale orders: a salesman takes them on the phone (offline too); they sync to the counter, where
 * the cashier loads one into a bill. Billing it marks the order billed. Stock moves only at billing.
 */

export interface OrderInput {
  partyId: number;
  notes?: string;
  lines: Array<{ itemId: number; unit?: string; qty: number; rate?: number }>;
}

export interface SaleOrder {
  id: number;
  number: string;
  date: string;
  party_id: number;
  party_name: string;
  party_phone?: string | null;
  status: 'open' | 'billed' | 'cancelled';
  total: number;
  notes: string | null;
  created_by: number | null;
  created_by_name?: string | null;
  created_at: string;
  invoice_id: number | null;
  invoice_number?: string | null;
  lines?: OrderLine[];
}

export interface OrderLine {
  id: number;
  order_id: number;
  item_id: number;
  name: string;
  unit: string;
  factor: number;
  qty: number;
  rate: number;
  total: number;
}

function priceFor(ctx: Ctx, itemId: number, wanted: string | undefined, tier: PriceTier) {
  const it = ctx.db.get<{ id: number; name: string; base_unit: string; mrp: number; retail_price: number; wholesale_price: number | null; super_price: number | null; active: number }>(
    'SELECT id, name, base_unit, mrp, retail_price, wholesale_price, super_price, active FROM items WHERE id = ?',
    [itemId],
  );
  if (!it || !it.active) throw new AppError('One of the items is no longer available.');
  const unitName = wanted || it.base_unit;
  const unit = unitName === it.base_unit ? { name: it.base_unit, factor: 1, price: null as number | null, wholesale_price: null as number | null } : ctx.db.get<{ name: string; factor: number; price: number | null; wholesale_price: number | null }>('SELECT name, factor, price, wholesale_price FROM item_units WHERE item_id = ? AND name = ?', [itemId, unitName]);
  if (!unit) throw new AppError(`${it.name} is not sold in ${unitName}.`);
  const base = resolvePrice({ mrp: it.mrp, retail: it.retail_price, wholesale: it.wholesale_price, super: it.super_price }, tier);
  const override = base.tier === 'wholesale' || base.tier === 'super' ? unit.wholesale_price ?? unit.price : unit.price;
  const rate = unit.factor === 1 ? base.price : priceForUnit(base.price, { factor: unit.factor, price: override ?? null });
  return { item: it, unit, rate };
}

export function createOrder(ctx: Ctx, input: OrderInput) {
  const s = guard(ctx, 'order.create');
  const party = ctx.db.get<{ id: number; name: string; kind: string; price_tier: PriceTier; is_walkin: number }>('SELECT id, name, kind, price_tier, is_walkin FROM parties WHERE id = ? AND active = 1', [input.partyId]);
  if (!party || party.kind !== 'customer') throw new AppError('Pick the customer for this order.');
  if (party.is_walkin) throw new AppError('Orders are for named customers. Pick or add the customer.');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new AppError('Add at least one item to the order.');
  const date = ctx.today();
  return ctx.db.transaction(() => {
    const code = seriesCode(ctx.db as SqlJsAdapter);
    const number = `SO-${code ? `${code}-` : ''}${nextSeriesNo(ctx.db as SqlJsAdapter, 'sale_order')}`;
    const priced = lines.map((l) => {
      const pp = priceFor(ctx, l.itemId, l.unit, party.price_tier);
      const unit = pp.unit.name;
      // Only someone allowed to give any discount may change the price on an order.
      const rate = l.rate != null && allowed(ctx, 'discount.any') ? Math.max(0, Math.round(l.rate)) : pp.rate;
      const qty = roundQty(l.qty);
      return { ...pp, unitName: unit, qty, rate, total: lineGross(qty, rate) };
    });
    const total = priced.reduce((a, l) => a + l.total, 0);
    const id = ctx.db.exec(
      'INSERT INTO sale_orders (number, date, party_id, party_name, status, total, notes, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [number, date, party.id, party.name, 'open', total, input.notes?.trim() || null, s.userId, localNow()],
    ).lastId;
    for (const l of priced) {
      ctx.db.exec('INSERT INTO sale_order_lines (order_id, item_id, name, unit, factor, qty, rate, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        id, l.item.id, l.item.name, l.unitName, l.unit.factor, l.qty, l.rate, l.total,
      ]);
    }
    audit(ctx, 'order.create', 'sale_order', id, { number, total });
    return getOrder(ctx, id);
  });
}

const SELECT = `SELECT o.*, p.phone AS party_phone, u.name AS created_by_name, i.number AS invoice_number
  FROM sale_orders o LEFT JOIN parties p ON p.id = o.party_id LEFT JOIN users u ON u.id = o.created_by LEFT JOIN invoices i ON i.id = o.invoice_id`;

export function getOrder(ctx: Ctx, id: number): SaleOrder {
  const s = guard(ctx, allowed(ctx, 'order.view') ? 'order.view' : 'order.create');
  const o = ctx.db.get<SaleOrder>(`${SELECT} WHERE o.id = ?`, [id]);
  if (!o || (!allowed(ctx, 'order.view') && o.created_by !== s.userId)) throw new AppError('Order not found.');
  o.lines = ctx.db.query<OrderLine>('SELECT * FROM sale_order_lines WHERE order_id = ? ORDER BY id', [id]);
  return o;
}

/** Counter: all orders. Salesman: only the ones they took. */
export function listOrders(ctx: Ctx, opts: { status?: SaleOrder['status']; limit?: number } = {}): SaleOrder[] {
  const s = guard(ctx, allowed(ctx, 'order.view') ? 'order.view' : 'order.create');
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.status) where.push('o.status = ?'), params.push(opts.status);
  if (!allowed(ctx, 'order.view')) where.push('o.created_by = ?'), params.push(s.userId);
  return ctx.db.query<SaleOrder>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC, o.id DESC LIMIT ?`, [...params, opts.limit ?? 200]);
}

export function openOrderCount(ctx: Ctx): number {
  if (!allowed(ctx, 'order.view')) return 0;
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sale_orders WHERE status = 'open'")!.n;
}

export function cancelOrder(ctx: Ctx, id: number) {
  const o = getOrder(ctx, id);
  if (o.status !== 'open') throw new AppError(o.status === 'billed' ? 'This order is already billed.' : 'Already cancelled.');
  ctx.db.transaction(() => {
    ctx.db.exec("UPDATE sale_orders SET status = 'cancelled' WHERE id = ?", [id]);
    audit(ctx, 'order.cancel', 'sale_order', id);
  });
  return true;
}

/** Called inside createInvoice's transaction when a bill is made from an order. */
export function markBilled(ctx: Ctx, orderId: number, invoiceId: number) {
  const o = ctx.db.get<{ status: string }>('SELECT status FROM sale_orders WHERE id = ?', [orderId]);
  if (!o) throw new AppError('That order no longer exists.');
  if (o.status !== 'open') throw new AppError(o.status === 'billed' ? 'This order was already billed (maybe on another counter).' : 'This order was cancelled.');
  ctx.db.exec("UPDATE sale_orders SET status = 'billed', invoice_id = ?, billed_at = ? WHERE id = ?", [invoiceId, localNow(), orderId]);
}
