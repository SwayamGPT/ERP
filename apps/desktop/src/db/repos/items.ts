import { recostBatches } from './invoices';
import { parseWeightBarcode, roundQty, type Scheme } from '@hisaab/core';
import type { Batch, Item, ItemUnit } from '../types';
import { AppError, allowed, audit, guard, stripCost, type Ctx } from './base';
import { mustCompany } from './company';

type ItemRow = Omit<Item, 'scheme' | 'units' | 'stock'> & { scheme: string | null; stock: number };

const STOCK_SQL = '(SELECT COALESCE(SUM(qty), 0) FROM batches b WHERE b.item_id = i.id)';

function hydrate(ctx: Ctx, rows: ItemRow[], withBatches = false): Item[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const units = ctx.db.query<ItemUnit & { item_id: number }>(`SELECT * FROM item_units WHERE item_id IN (${ph}) ORDER BY factor`, ids);
  const batches = withBatches
    ? ctx.db.query<Batch>(`SELECT * FROM batches WHERE item_id IN (${ph}) AND qty <> 0 ORDER BY expiry IS NULL, expiry, received_at`, ids)
    : [];
  return rows.map((r) => {
    const item: Item = {
      ...r,
      stock: roundQty(r.stock),
      scheme: r.scheme ? (JSON.parse(r.scheme) as Scheme) : null,
      units: [{ name: r.base_unit, factor: 1, price: null }, ...units.filter((u) => u.item_id === r.id)],
    };
    if (withBatches) item.batches = batches.filter((b) => b.item_id === r.id).map((b) => stripCost(ctx, { ...b }));
    return stripCost(ctx, item);
  });
}

export function listItems(
  ctx: Ctx,
  opts: { q?: string; category?: string; filter?: 'low' | 'out' | 'expiring' | 'all'; limit?: number; includeInactive?: boolean } = {},
): Item[] {
  guard(ctx, 'item.view');
  const where: string[] = [];
  const params: unknown[] = [];
  if (!opts.includeInactive) where.push('i.active = 1');
  if (opts.q?.trim()) {
    for (const w of opts.q.trim().split(/\s+/)) {
      where.push('(i.name LIKE ? OR i.short_code = ? OR i.barcode = ? OR i.brand LIKE ? OR i.hsn LIKE ?)');
      params.push(`%${w}%`, w, w, `%${w}%`, `${w}%`);
    }
  }
  if (opts.category) {
    where.push('i.category = ?');
    params.push(opts.category);
  }
  if (opts.filter === 'low') where.push(`i.reorder_level > 0 AND ${STOCK_SQL} <= i.reorder_level`);
  if (opts.filter === 'out') where.push(`${STOCK_SQL} <= 0`);
  if (opts.filter === 'expiring')
    where.push(`EXISTS (SELECT 1 FROM batches b WHERE b.item_id = i.id AND b.qty > 0 AND b.expiry IS NOT NULL AND b.expiry <= date(?, '+30 day'))`), params.push(ctx.today());
  const rows = ctx.db.query<ItemRow>(
    `SELECT i.*, ${STOCK_SQL} AS stock FROM items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.name LIMIT ?`,
    [...params, opts.limit ?? 500] as never,
  );
  return hydrate(ctx, rows);
}

export function getItem(ctx: Ctx, id: number): Item & { moves?: unknown[] } {
  guard(ctx, 'item.view');
  const row = ctx.db.get<ItemRow>(`SELECT i.*, ${STOCK_SQL} AS stock FROM items i WHERE i.id = ?`, [id]);
  if (!row) throw new AppError('Item not found.', 'NOT_FOUND');
  const [item] = hydrate(ctx, [row], true);
  const moves = ctx.db.query(
    `SELECT m.*, b.batch_no, inv.number AS ref_number FROM stock_moves m
     LEFT JOIN batches b ON b.id = m.batch_id
     LEFT JOIN invoices inv ON inv.id = m.ref_id AND m.reason IN ('sale','purchase','sale_return','purchase_return','cancel')
     WHERE m.item_id = ? ORDER BY m.id DESC LIMIT 50`,
    [id],
  );
  return { ...item, moves: moves.map((m) => stripCost(ctx, m)) };
}

/** POS search: exact barcode/code/weight-barcode hits first, then name tokens. */
export function searchForBilling(ctx: Ctx, q: string, perm: 'sale.create' | 'order.create' = 'sale.create'): { items: Item[]; scale?: { itemId: number; qty?: number; amount?: number } } {
  guard(ctx, perm);
  const s = q.trim();
  if (!s) return { items: [] };
  const exact = (sql: string, p: unknown[]) => ctx.db.query<ItemRow>(`SELECT i.*, ${STOCK_SQL} AS stock FROM items i WHERE i.active = 1 AND ${sql}`, p as never);

  if (/^\d{8,14}$/.test(s)) {
    const company = mustCompany(ctx);
    const wb = parseWeightBarcode(s, company.weight_barcode_mode);
    if (wb) {
      const rows = exact('i.plu = ?', [wb.plu]);
      if (rows.length) {
        const [item] = hydrate(ctx, rows, true);
        return wb.mode === 'weight'
          ? { items: [item], scale: { itemId: item.id, qty: roundQty(wb.value / 1000) } }
          : { items: [item], scale: { itemId: item.id, amount: wb.value } };
      }
    }
    let rows = exact('i.barcode = ?', [s]);
    if (!rows.length) {
      const u = ctx.db.get<{ item_id: number }>('SELECT item_id FROM item_units WHERE barcode = ?', [s]);
      if (u) rows = exact('i.id = ?', [u.item_id]);
    }
    if (rows.length) return { items: hydrate(ctx, rows, true) };
  }
  const code = exact('LOWER(i.short_code) = LOWER(?)', [s]);
  const words = s.split(/\s+/).filter(Boolean);
  const nameRows = ctx.db.query<ItemRow>(
    `SELECT i.*, ${STOCK_SQL} AS stock FROM items i WHERE i.active = 1 AND ${words.map(() => '(i.name LIKE ? OR i.brand LIKE ?)').join(' AND ')}
     ORDER BY CASE WHEN i.name LIKE ? THEN 0 ELSE 1 END, i.name LIMIT 20`,
    [...words.flatMap((w) => [`%${w}%`, `%${w}%`]), `${s}%`] as never,
  );
  const seen = new Set<number>();
  const merged = [...code, ...nameRows].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  return { items: hydrate(ctx, merged.slice(0, 20), true) };
}

export interface ItemInput {
  id?: number;
  name: string;
  short_code?: string | null;
  barcode?: string | null;
  plu?: string | null;
  category?: string | null;
  brand?: string | null;
  hsn?: string | null;
  gst_rate: number;
  cess_rate?: number;
  base_unit: string;
  is_loose?: boolean;
  tax_inclusive?: boolean;
  mrp: number;
  retail_price: number;
  wholesale_price?: number | null;
  super_price?: number | null;
  purchase_price?: number;
  reorder_level?: number;
  track_batch?: boolean;
  scheme?: Scheme | null;
  active?: boolean;
  units?: ItemUnit[];
  opening?: { qty: number; cost?: number; batchNo?: string | null; expiry?: string | null } | null;
  /** Supplier coupon / scheme: paise per coupon, base units per coupon (0 = none). */
  coupon_value?: number;
  coupon_per?: number;
}

export function saveItem(ctx: Ctx, input: ItemInput): number {
  guard(ctx, 'item.edit');
  if (!input.name?.trim()) throw new AppError('Item name is required.');
  if (input.retail_price < 0 || input.mrp < 0) throw new AppError('Prices cannot be negative.');
  if (input.mrp > 0 && input.retail_price > input.mrp) throw new AppError('Selling price cannot be more than MRP.');
  const barcode = input.barcode?.trim() || null;
  if (barcode) {
    const dupe = ctx.db.get<{ id: number; name: string }>('SELECT id, name FROM items WHERE barcode = ? AND id <> ?', [barcode, input.id ?? 0]);
    if (dupe) throw new AppError(`Barcode already used by "${dupe.name}".`);
  }
  const plu = input.plu?.trim() ? input.plu.trim().padStart(5, '0') : null;
  const canCost = allowed(ctx, 'cost.view');
  const cols = {
    name: input.name.trim(),
    short_code: input.short_code?.trim() || null,
    barcode,
    plu,
    category: input.category?.trim() || null,
    brand: input.brand?.trim() || null,
    hsn: input.hsn?.trim() || null,
    gst_rate: input.gst_rate,
    cess_rate: input.cess_rate ?? 0,
    base_unit: input.base_unit.trim() || 'Pcs',
    is_loose: input.is_loose ? 1 : 0,
    tax_inclusive: input.tax_inclusive === false ? 0 : 1,
    mrp: input.mrp,
    retail_price: input.retail_price,
    wholesale_price: input.wholesale_price ?? null,
    super_price: input.super_price ?? null,
    reorder_level: input.reorder_level ?? 0,
    track_batch: input.track_batch ? 1 : 0,
    scheme: input.scheme ? JSON.stringify(input.scheme) : null,
    active: input.active === false ? 0 : 1,
    ...(canCost && input.purchase_price !== undefined ? { purchase_price: input.purchase_price } : {}),
    ...(canCost && input.coupon_value !== undefined ? { coupon_value: Math.max(0, Math.round(input.coupon_value)), coupon_per: Math.max(0, input.coupon_per ?? 0) } : {}),
  };
  const keys = Object.keys(cols) as Array<keyof typeof cols>;
  return ctx.db.transaction(() => {
    let id = input.id;
    if (id) {
      const before = ctx.db.get<{ purchase_price: number }>('SELECT purchase_price FROM items WHERE id = ?', [id])?.purchase_price;
      ctx.db.exec(`UPDATE items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => cols[k] as never), id]);
      audit(ctx, 'item.update', 'item', id);
      // Purchase rate corrected: stock that didn't come from a purchase bill (opening stock,
      // counts) takes the new cost, and so do the sales made from it. Stock from a purchase bill
      // keeps that bill's rate; to fix it, edit the bill.
      if (cols.purchase_price !== undefined && cols.purchase_price !== before) {
        const own = ctx.db.query<{ id: number }>('SELECT id FROM batches WHERE item_id = ? AND source_invoice_id IS NULL', [id]).map((b) => b.id);
        if (own.length) {
          ctx.db.exec('UPDATE batches SET cost = ? WHERE item_id = ? AND source_invoice_id IS NULL', [cols.purchase_price, id]);
          recostBatches(ctx, own);
        }
      }
    } else {
      id = ctx.db.exec(`INSERT INTO items (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => cols[k] as never)).lastId;
      audit(ctx, 'item.create', 'item', id);
    }
    if (input.units) {
      ctx.db.exec('DELETE FROM item_units WHERE item_id = ?', [id]);
      for (const u of input.units) {
        if (u.factor === 1 && u.name === cols.base_unit) continue;
        if (!u.name.trim() || !(u.factor > 0)) continue;
        ctx.db.exec('INSERT INTO item_units (item_id, name, factor, barcode, price, wholesale_price) VALUES (?,?,?,?,?,?)', [
          id, u.name.trim(), u.factor, u.barcode?.trim() || null, u.price ?? null, u.wholesale_price ?? null,
        ]);
      }
    }
    if (input.opening && input.opening.qty !== 0) {
      const cost = input.opening.cost ?? input.purchase_price ?? 0;
      const b = ctx.db.exec('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at) VALUES (?,?,?,?,?,?,?)', [
        id, input.opening.batchNo ?? null, input.opening.expiry ?? null, input.mrp || null, cost, roundQty(input.opening.qty), `${ctx.today()} 00:00:00`,
      ]);
      ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, date, note) VALUES (?,?,?,?, 'opening', ?, 'Opening stock')", [
        id, b.lastId, roundQty(input.opening.qty), cost, ctx.today(),
      ]);
      if (!cols.purchase_price && cost) ctx.db.exec('UPDATE items SET purchase_price = ? WHERE id = ?', [cost, id]);
    }
    return id!;
  });
}

export function adjustStock(ctx: Ctx, input: { itemId: number; batchId?: number | null; delta: number; note?: string; expiry?: string | null; batchNo?: string | null }) {
  guard(ctx, 'stock.adjust');
  const delta = roundQty(input.delta);
  if (!delta) throw new AppError('Enter a quantity to add or remove.');
  return ctx.db.transaction(() => {
    const item = ctx.db.get<{ purchase_price: number; mrp: number }>('SELECT purchase_price, mrp FROM items WHERE id = ?', [input.itemId]);
    if (!item) throw new AppError('Item not found.');
    let batchId = input.batchId ?? null;
    if (batchId) {
      ctx.db.exec('UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ? AND item_id = ?', [delta, batchId, input.itemId]);
    } else if (delta > 0) {
      batchId = ctx.db.exec('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at) VALUES (?,?,?,?,?,?,?)', [
        input.itemId, input.batchNo ?? null, input.expiry ?? null, item.mrp || null, item.purchase_price, delta, `${ctx.today()} ${new Date().toTimeString().slice(0, 8)}`,
      ]).lastId;
    } else {
      const latest = ctx.db.get<{ id: number }>('SELECT id FROM batches WHERE item_id = ? ORDER BY qty > 0 DESC, expiry IS NULL, expiry, received_at LIMIT 1', [input.itemId]);
      if (!latest) throw new AppError('No stock to remove.');
      batchId = latest.id;
      ctx.db.exec('UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?', [delta, batchId]);
    }
    ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, note, date) VALUES (?,?,?,?, 'adjust', ?, ?)", [
      input.itemId, batchId, delta, item.purchase_price, input.note ?? null, ctx.today(),
    ]);
    audit(ctx, 'stock.adjust', 'item', input.itemId, { delta, note: input.note });
    return true;
  });
}

export function categories(ctx: Ctx): string[] {
  guard(ctx, 'item.view');
  return ctx.db.query<{ category: string }>('SELECT DISTINCT category FROM items WHERE category IS NOT NULL AND active = 1 ORDER BY category').map((r) => r.category);
}

export function nextPlu(ctx: Ctx): string {
  const r = ctx.db.get<{ m: number | null }>('SELECT MAX(CAST(plu AS INTEGER)) AS m FROM items');
  return String((r?.m ?? 0) + 1).padStart(5, '0');
}
