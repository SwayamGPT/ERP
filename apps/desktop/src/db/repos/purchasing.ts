import { roundQty } from '@hisaab/core';
import type { SqlJsAdapter } from '../adapter';
import { nextSeriesNo, seriesCode } from '../sync/engine';
import { AppError, allowed, audit, guard, localNow, stripCost, type Ctx } from './base';

/* ───────── godowns ───────── */

export function defaultGodown(ctx: Ctx): number {
  return ctx.db.get<{ id: number }>('SELECT id FROM godowns WHERE is_default = 1 AND active = 1 ORDER BY id LIMIT 1')?.id ?? 1;
}

/* ───────── purchase orders ───────── */

export interface PoInput {
  partyId: number;
  expectedDate?: string | null;
  notes?: string;
  lines: Array<{ itemId: number; unit?: string; factor?: number; qty: number; rate?: number }>;
}

export interface PurchaseOrder {
  id: number;
  number: string;
  date: string;
  party_id: number;
  party_name: string;
  expected_date: string | null;
  status: 'open' | 'partial' | 'received' | 'cancelled';
  total: number;
  notes: string | null;
  created_at: string;
  lines?: Array<{ id: number; item_id: number; name: string; unit: string; factor: number; qty: number; received_qty: number; rate: number; pending: number }>;
}

export function createPO(ctx: Ctx, input: PoInput): PurchaseOrder {
  const s = guard(ctx, 'purchase.create');
  const party = ctx.db.get<{ id: number; name: string; kind: string }>('SELECT id, name, kind FROM parties WHERE id = ?', [input.partyId]);
  if (!party || party.kind !== 'supplier') throw new AppError('Pick the supplier.');
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new AppError('Add at least one item.');
  return ctx.db.transaction(() => {
    const code = seriesCode(ctx.db as SqlJsAdapter);
    const number = `PO-${code ? `${code}-` : ''}${nextSeriesNo(ctx.db as SqlJsAdapter, 'purchase_order')}`;
    const id = ctx.db.exec('INSERT INTO purchase_orders (number, date, party_id, party_name, expected_date, status, total, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
      number, ctx.today(), party.id, party.name, input.expectedDate || null, 'open', 0, input.notes?.trim() || null, s.userId, localNow(),
    ]).lastId;
    let total = 0;
    for (const l of lines) {
      const it = ctx.db.get<{ name: string; base_unit: string; purchase_price: number }>('SELECT name, base_unit, purchase_price FROM items WHERE id = ?', [l.itemId]);
      if (!it) throw new AppError('An item on this order no longer exists.');
      const factor = l.factor ?? 1;
      const rate = l.rate ?? Math.round(it.purchase_price * factor);
      total += Math.round(rate * l.qty);
      ctx.db.exec('INSERT INTO purchase_order_lines (po_id, item_id, name, unit, factor, qty, rate) VALUES (?,?,?,?,?,?,?)', [id, l.itemId, it.name, l.unit ?? it.base_unit, factor, roundQty(l.qty), rate]);
    }
    ctx.db.exec('UPDATE purchase_orders SET total = ? WHERE id = ?', [total, id]);
    audit(ctx, 'po.create', 'purchase_order', id, { number, total });
    return getPO(ctx, id);
  });
}

export function getPO(ctx: Ctx, id: number): PurchaseOrder {
  guard(ctx, 'purchase.view');
  const po = ctx.db.get<PurchaseOrder>('SELECT * FROM purchase_orders WHERE id = ?', [id]);
  if (!po) throw new AppError('Purchase order not found.');
  po.lines = ctx.db.query('SELECT *, MAX(0, ROUND(qty - received_qty, 3)) AS pending FROM purchase_order_lines WHERE po_id = ? ORDER BY id', [id]);
  return stripCost(ctx, po, ['total']);
}

export function listPOs(ctx: Ctx, opts: { status?: 'open' | 'all' } = {}): PurchaseOrder[] {
  guard(ctx, 'purchase.view');
  const where = opts.status === 'all' ? '' : "WHERE status IN ('open','partial')";
  return ctx.db.query<PurchaseOrder>(`SELECT * FROM purchase_orders ${where} ORDER BY date DESC, id DESC LIMIT 300`).map((p) => stripCost(ctx, p, ['total']));
}

export function cancelPO(ctx: Ctx, id: number) {
  guard(ctx, 'purchase.create');
  const po = getPO(ctx, id);
  if (po.status === 'received' || po.status === 'cancelled') throw new AppError(`This order is already ${po.status}.`);
  ctx.db.exec("UPDATE purchase_orders SET status = 'cancelled' WHERE id = ?", [id]);
  audit(ctx, 'po.cancel', 'purchase_order', id);
  return true;
}

function refreshPOStatus(ctx: Ctx, poId: number) {
  const r = ctx.db.get<{ pending: number; got: number }>('SELECT SUM(MAX(0, qty - received_qty)) AS pending, SUM(received_qty) AS got FROM purchase_order_lines WHERE po_id = ?', [poId])!;
  const status = r.pending <= 1e-9 ? 'received' : r.got > 0 ? 'partial' : 'open';
  ctx.db.exec("UPDATE purchase_orders SET status = ? WHERE id = ? AND status <> 'cancelled'", [status, poId]);
}

/** A purchase bill received goods against an order (called inside createInvoice's transaction). */
export function receivePO(ctx: Ctx, poId: number, invoiceId: number, lines: Array<{ itemId: number; baseQty: number }>) {
  const po = ctx.db.get<{ status: string; party_id: number }>('SELECT status, party_id FROM purchase_orders WHERE id = ?', [poId]);
  if (!po) throw new AppError('That purchase order no longer exists.');
  if (po.status === 'cancelled' || po.status === 'received') throw new AppError(`That purchase order is already ${po.status}.`);
  ctx.db.exec('UPDATE invoices SET po_id = ? WHERE id = ?', [poId, invoiceId]);
  const pol = ctx.db.query<{ id: number; item_id: number; factor: number; qty: number; received_qty: number }>('SELECT id, item_id, factor, qty, received_qty FROM purchase_order_lines WHERE po_id = ? ORDER BY id', [poId]);
  for (const l of lines) {
    let left = l.baseQty;
    for (const p of pol.filter((x) => x.item_id === l.itemId)) {
      if (left <= 0) break;
      const room = Math.max(0, (p.qty - p.received_qty) * p.factor);
      const take = Math.min(left, room) || 0;
      const last = p === pol.filter((x) => x.item_id === l.itemId).at(-1);
      const add = last ? left : take; // extra goods beyond the order count against the last line
      p.received_qty = roundQty(p.received_qty + add / p.factor);
      ctx.db.exec('UPDATE purchase_order_lines SET received_qty = ? WHERE id = ?', [p.received_qty, p.id]);
      left -= add;
    }
  }
  refreshPOStatus(ctx, poId);
}

/** Cancelling a purchase bill puts its goods back on the order. */
export function unreceivePO(ctx: Ctx, invoiceId: number) {
  const inv = ctx.db.get<{ po_id: number | null }>('SELECT po_id FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv?.po_id) return;
  const got = ctx.db.query<{ item_id: number; q: number }>('SELECT item_id, SUM(qty * factor) AS q FROM invoice_lines WHERE invoice_id = ? GROUP BY item_id', [invoiceId]);
  for (const g of got) {
    let left = g.q;
    for (const p of ctx.db.query<{ id: number; factor: number; received_qty: number }>('SELECT id, factor, received_qty FROM purchase_order_lines WHERE po_id = ? AND item_id = ? ORDER BY id DESC', [inv.po_id, g.item_id])) {
      if (left <= 0) break;
      const take = Math.min(left, p.received_qty * p.factor);
      ctx.db.exec('UPDATE purchase_order_lines SET received_qty = ? WHERE id = ?', [roundQty(p.received_qty - take / p.factor), p.id]);
      left -= take;
    }
  }
  refreshPOStatus(ctx, inv.po_id);
}

/* ───────── reorder suggestions ───────── */

export interface ReorderRow {
  item_id: number;
  name: string;
  base_unit: string;
  stock: number;
  on_order: number;
  per_day: number;
  lead_days: number;
  reorder_level: number;
  suggest: number;
  supplier_id: number | null;
  supplier: string | null;
  last_cost?: number;
}

/**
 * What to buy: average daily sales over the last `days`, enough to cover the supplier's lead time
 * plus `coverDays`, plus the item's reorder level — minus stock in hand and already on order.
 */
export function reorderSuggestions(ctx: Ctx, opts: { days?: number; coverDays?: number } = {}): ReorderRow[] {
  guard(ctx, 'purchase.view');
  const days = opts.days ?? 30;
  const cover = opts.coverDays ?? 7;
  const from = ctx.db.get<{ d: string }>("SELECT date(?, ?) AS d", [ctx.today(), `-${days} day`])!.d;
  const rows = ctx.db.query<Omit<ReorderRow, 'suggest' | 'per_day'> & { sold: number }>(
    `SELECT i.id AS item_id, i.name, i.base_unit, i.reorder_level, i.lead_days, i.purchase_price AS last_cost,
       (SELECT COALESCE(SUM(qty), 0) FROM batches WHERE item_id = i.id) AS stock,
       (SELECT COALESCE(SUM(-m.qty), 0) FROM stock_moves m WHERE m.item_id = i.id AND m.reason = 'sale' AND m.date >= ?) AS sold,
       (SELECT COALESCE(SUM(MAX(0, l.qty - l.received_qty) * l.factor), 0) FROM purchase_order_lines l JOIN purchase_orders o ON o.id = l.po_id
          WHERE l.item_id = i.id AND o.status IN ('open','partial')) AS on_order,
       (SELECT v.party_id FROM invoices v JOIN invoice_lines vl ON vl.invoice_id = v.id WHERE vl.item_id = i.id AND v.kind = 'purchase' AND v.status = 'final' ORDER BY v.date DESC, v.id DESC LIMIT 1) AS supplier_id
     FROM items i WHERE i.active = 1`,
    [from],
  );
  const out: ReorderRow[] = [];
  for (const r of rows) {
    const perDay = r.sold / days;
    const need = perDay * (r.lead_days + cover) + r.reorder_level - r.stock - r.on_order;
    if (need <= 0.0005 || (perDay === 0 && r.reorder_level === 0)) continue;
    const suggest = r.base_unit.toLowerCase() === 'kg' || r.base_unit.toLowerCase() === 'ltr' ? roundQty(need) : Math.ceil(need);
    const supplier = r.supplier_id ? ctx.db.get<{ name: string }>('SELECT name FROM parties WHERE id = ?', [r.supplier_id])?.name ?? null : null;
    const row: ReorderRow = { ...r, per_day: Math.round(perDay * 100) / 100, suggest, supplier };
    delete (row as Partial<{ sold: number }>).sold;
    out.push(allowed(ctx, 'cost.view') ? row : stripCost(ctx, row, ['last_cost']));
  }
  return out.sort((a, b) => (a.supplier ?? '~').localeCompare(b.supplier ?? '~') || b.per_day - a.per_day);
}

/** One click: turn chosen suggestions into one purchase order per supplier. */
export function ordersFromSuggestions(ctx: Ctx, input: { lines: Array<{ itemId: number; qty: number; supplierId: number }> }) {
  guard(ctx, 'purchase.create');
  const bySupplier = new Map<number, PoInput['lines']>();
  for (const l of input.lines) {
    if (!l.supplierId) throw new AppError('Pick a supplier for every item.');
    bySupplier.set(l.supplierId, [...(bySupplier.get(l.supplierId) ?? []), { itemId: l.itemId, qty: l.qty }]);
  }
  return ctx.db.transaction(() => [...bySupplier].map(([partyId, lines]) => createPO(ctx, { partyId, lines })));
}

/* ───────── import a distributor's bill (CSV / Excel rows parsed on the device) ───────── */

export interface ImportRow {
  name?: string;
  barcode?: string;
  hsn?: string;
  qty?: number;
  rate?: number; // paise per unit
  mrp?: number;
  gst?: number;
  batch?: string;
  expiry?: string;
}

/** Match each row to an item: barcode, then exact name, then the closest name. */
export function matchImport(ctx: Ctx, input: { rows: ImportRow[] }) {
  guard(ctx, 'purchase.create');
  return input.rows.map((r) => {
    const name = (r.name ?? '').trim();
    let item: { id: number; name: string; how: 'barcode' | 'name' | 'similar' } | null = null;
    if (r.barcode?.trim()) {
      const it = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM items WHERE barcode = ? AND active = 1', [r.barcode.trim()]) ??
        ctx.db.get<{ id: number; name: string }>('SELECT i.id, i.name FROM item_units u JOIN items i ON i.id = u.item_id WHERE u.barcode = ?', [r.barcode.trim()]);
      if (it) item = { ...it, how: 'barcode' };
    }
    if (!item && name) {
      const it = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM items WHERE name = ? COLLATE NOCASE AND active = 1', [name]);
      if (it) item = { ...it, how: 'name' };
    }
    if (!item && name) {
      const words = name.split(/\s+/).filter((w) => w.length > 2).slice(0, 4);
      if (words.length) {
        const it = ctx.db.get<{ id: number; name: string }>(
          `SELECT id, name FROM items WHERE active = 1 AND ${words.map(() => 'name LIKE ?').join(' AND ')} ORDER BY LENGTH(name) LIMIT 1`,
          words.map((w) => `%${w}%`),
        );
        if (it) item = { ...it, how: 'similar' };
      }
    }
    return { row: r, item };
  });
}
