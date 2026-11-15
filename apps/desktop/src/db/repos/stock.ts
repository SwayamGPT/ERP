import { allocateFifo, roundQty } from '@hisaab/core';
import type { PayMode } from '../types';
import { AppError, allowed, audit, guard, localNow, type Ctx } from './base';
import { saveRecurring } from './expenses';

/* ───────── godowns ───────── */

export interface GodownRow {
  id: number;
  name: string;
  is_default: number;
  active: number;
  items: number;
  units: number;
  rented: number;
  landlord: string | null;
  rent: number;
  rent_due_day: number;
  recurring_id: number | null;
  /** Only for users who can see expenses. */
  rent_due?: number;
  rent_paid_year?: number;
}

export function listGodowns(ctx: Ctx): GodownRow[] {
  guard(ctx, 'item.view');
  const year = ctx.today().slice(0, 4);
  const rows = ctx.db.query<GodownRow>(
    `SELECT g.*, (SELECT COUNT(DISTINCT item_id) FROM batches WHERE godown_id = g.id AND qty > 0) AS items,
       (SELECT COALESCE(SUM(qty), 0) FROM batches WHERE godown_id = g.id AND qty > 0) AS units,
       (SELECT COALESCE(SUM(amount - paid), 0) FROM expenses WHERE godown_id = g.id AND status IN ('unpaid','partial')) AS rent_due,
       (SELECT COALESCE(SUM(paid), 0) FROM expenses WHERE godown_id = g.id AND status <> 'cancelled' AND substr(date, 1, 4) = ?) AS rent_paid_year
     FROM godowns g ORDER BY g.is_default DESC, g.name`,
    [year],
  );
  if (!allowed(ctx, 'expense.view')) for (const r of rows) (r.rent = 0), delete r.rent_due, delete r.rent_paid_year;
  return rows;
}

/**
 * Rent for a godown: one monthly recurring expense ("Godown rent", payee = landlord) linked to the
 * godown, so each month's bill shows in Bills to pay, is paid like any expense, and lands in cash
 * flow and P&L. Turning rent off pauses the schedule; past bills stay.
 */
export function saveGodownRent(
  ctx: Ctx,
  input: { godownId: number; rented: boolean; landlord?: string; rent?: number; per?: 'month' | 'day'; startDate?: string; dueDay?: number; startMonth?: string; gstRate?: number; landlordGstin?: string | null; autoPayMode?: PayMode | null },
) {
  guard(ctx, 'expense.create');
  const g = ctx.db.get<{ id: number; name: string; recurring_id: number | null }>('SELECT id, name, recurring_id FROM godowns WHERE id = ?', [input.godownId]);
  if (!g) throw new AppError('Godown not found.');
  return ctx.db.transaction(() => {
    if (!input.rented) {
      if (g.recurring_id) ctx.db.exec('UPDATE recurring_expenses SET active = 0 WHERE id = ?', [g.recurring_id]);
      ctx.db.exec('UPDATE godowns SET rented = 0 WHERE id = ?', [g.id]);
      audit(ctx, 'godown.rent.off', 'godown', g.id);
      return g.id;
    }
    const rent = input.rent ?? 0;
    if (!(rent > 0) || !Number.isSafeInteger(rent)) throw new AppError(input.per === 'day' ? 'Enter the rent per day.' : 'Enter the monthly rent.');
    const landlord = input.landlord?.trim();
    if (!landlord) throw new AppError("Enter the landlord's name.");
    const daily = input.per === 'day';
    const day = Math.round(input.dueDay ?? 1);
    if (!daily && (day < 1 || day > 28)) throw new AppError('Rent due day must be between 1 and 28.');
    const month = input.startMonth ?? ctx.today().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError('Pick the month rent starts.');
    const cat = ctx.db.get<{ id: number }>("SELECT id FROM expense_categories WHERE name = 'Godown rent'")!.id;
    const recurringId = saveRecurring(ctx, {
      id: g.recurring_id ?? undefined, categoryId: cat, amount: rent, every: daily ? 'day' : 'month', anchorDate: daily ? input.startDate ?? ctx.today() : `${month}-${String(day).padStart(2, '0')}`,
      payee: landlord, description: `Rent — ${g.name}`, gstRate: input.gstRate ?? 0, payeeGstin: input.landlordGstin ?? null, autoPayMode: input.autoPayMode ?? null, active: true,
    }, g.id);
    ctx.db.exec('UPDATE godowns SET rented = 1, landlord = ?, rent = ?, rent_due_day = ?, recurring_id = ? WHERE id = ?', [landlord, rent, day, recurringId, g.id]);
    audit(ctx, 'godown.rent', 'godown', g.id, { rent, landlord, day });
    return g.id;
  });
}

/** A godown's rent bills, newest first. */
export function godownRentBills(ctx: Ctx, godownId: number) {
  guard(ctx, 'expense.view');
  return ctx.db.query<{ id: number; date: string; due_date: string | null; amount: number; paid: number; status: string }>(
    "SELECT id, date, due_date, amount, paid, status FROM expenses WHERE godown_id = ? AND status <> 'cancelled' ORDER BY date DESC LIMIT 24",
    [godownId],
  );
}

export function saveGodown(ctx: Ctx, input: { id?: number; name: string; isDefault?: boolean; active?: boolean }) {
  guard(ctx, 'stock.adjust');
  const name = input.name.trim();
  if (!name) throw new AppError('Enter the godown name.');
  if (ctx.db.get('SELECT 1 FROM godowns WHERE name = ? COLLATE NOCASE AND id <> ?', [name, input.id ?? 0])) throw new AppError('A godown with this name already exists.');
  return ctx.db.transaction(() => {
    let id = input.id;
    if (id) ctx.db.exec('UPDATE godowns SET name = ?, active = ? WHERE id = ?', [name, input.active === false ? 0 : 1, id]);
    else id = ctx.db.exec('INSERT INTO godowns (name, is_default, active) VALUES (?, 0, 1)', [name]).lastId;
    if (input.isDefault) {
      ctx.db.exec('UPDATE godowns SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END', [id]);
    }
    audit(ctx, 'godown.save', 'godown', id, { name, isDefault: !!input.isDefault });
    return id;
  });
}

/** Stock of one item by godown. */
export function itemByGodown(ctx: Ctx, itemId: number) {
  guard(ctx, 'item.view');
  return ctx.db.query<{ godown_id: number; name: string; qty: number }>(
    'SELECT g.id AS godown_id, g.name, ROUND(COALESCE(SUM(b.qty), 0), 3) AS qty FROM godowns g LEFT JOIN batches b ON b.godown_id = g.id AND b.item_id = ? WHERE g.active = 1 GROUP BY g.id ORDER BY g.is_default DESC, g.name',
    [itemId],
  );
}

/**
 * Move stock between godowns. Batches keep their number, expiry, MRP and cost; each movement is a
 * pair of stock moves (out of one batch, into its twin in the other godown), so stock always equals
 * the sum of moves and syncs like any other change.
 */
export function transferStock(ctx: Ctx, input: { from: number; to: number; date?: string; notes?: string; lines: Array<{ itemId: number; qty: number }> }) {
  const s = guard(ctx, 'stock.adjust');
  if (input.from === input.to) throw new AppError('Pick two different godowns.');
  const g = ctx.db.query<{ id: number; name: string }>('SELECT id, name FROM godowns WHERE id IN (?, ?) AND active = 1', [input.from, input.to]);
  if (g.length !== 2) throw new AppError('Godown not found.');
  const toName = g.find((x) => x.id === input.to)!.name;
  const fromName = g.find((x) => x.id === input.from)!.name;
  const date = input.date ?? ctx.today();
  const lines = input.lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new AppError('Add the items to move.');
  return ctx.db.transaction(() => {
    const id = ctx.db.exec('INSERT INTO stock_transfers (date, from_godown, to_godown, notes, created_by, created_at) VALUES (?,?,?,?,?,?)', [
      date, input.from, input.to, input.notes?.trim() || null, s.userId, localNow(),
    ]).lastId;
    for (const l of lines) {
      const batches = ctx.db.query<{ id: number; qty: number; expiry: string | null; received_at: string; cost: number; batch_no: string | null; mrp: number | null; name: string }>(
        'SELECT b.id, b.qty, b.expiry, b.received_at, b.cost, b.batch_no, b.mrp, i.name FROM batches b JOIN items i ON i.id = b.item_id WHERE b.item_id = ? AND b.godown_id = ? AND b.qty > 0',
        [l.itemId, input.from],
      );
      const r = allocateFifo(batches.map((b) => ({ id: b.id, qty: b.qty, expiry: b.expiry, receivedAt: b.received_at, cost: b.cost })), roundQty(l.qty));
      if (r.shortfall > 0) {
        const name = batches[0]?.name ?? ctx.db.get<{ name: string }>('SELECT name FROM items WHERE id = ?', [l.itemId])?.name;
        throw new AppError(`Only ${roundQty(l.qty - r.shortfall)} of ${name} is in ${fromName}.`);
      }
      for (const a of r.allocations) {
        const src = batches.find((b) => b.id === a.batchId)!;
        let twin = ctx.db.get<{ id: number }>(
          'SELECT id FROM batches WHERE item_id = ? AND godown_id = ? AND batch_no IS ? AND expiry IS ? AND cost = ? AND mrp IS ?',
          [l.itemId, input.to, src.batch_no, src.expiry, src.cost, src.mrp],
        )?.id;
        if (!twin) {
          twin = ctx.db.exec('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at, godown_id) VALUES (?,?,?,?,?,0,?,?)', [
            l.itemId, src.batch_no, src.expiry, src.mrp, src.cost, src.received_at, input.to,
          ]).lastId;
        }
        ctx.db.exec('UPDATE batches SET qty = ROUND(qty - ?, 3) WHERE id = ?', [a.qty, src.id]);
        ctx.db.exec('UPDATE batches SET qty = ROUND(qty + ?, 3) WHERE id = ?', [a.qty, twin]);
        const note = `Transfer #${id}: ${fromName} → ${toName}`;
        ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, note, date) VALUES (?,?,?,?, 'adjust', ?, ?, ?)", [l.itemId, src.id, -a.qty, src.cost, id, note, date]);
        ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, note, date) VALUES (?,?,?,?, 'adjust', ?, ?, ?)", [l.itemId, twin, a.qty, src.cost, id, note, date]);
      }
    }
    audit(ctx, 'stock.transfer', 'stock_transfer', id, { from: fromName, to: toName, lines: lines.length });
    return id;
  });
}

export function listTransfers(ctx: Ctx) {
  guard(ctx, 'item.view');
  return ctx.db.query(
    `SELECT t.*, f.name AS from_name, g.name AS to_name, u.name AS by_name,
       (SELECT COUNT(*) / 2 FROM stock_moves m WHERE m.ref_id = t.id AND m.note LIKE 'Transfer #' || t.id || ':%') AS lines
     FROM stock_transfers t JOIN godowns f ON f.id = t.from_godown JOIN godowns g ON g.id = t.to_godown LEFT JOIN users u ON u.id = t.created_by
     ORDER BY t.id DESC LIMIT 100`,
  );
}

/* ───────── variants ───────── */

/**
 * Create size / colour variants of an item. Each variant is a full item of its own (barcode, price,
 * stock) linked to the parent, so billing, stock and reports need nothing special.
 */
export function createVariants(ctx: Ctx, input: { parentId: number; variants: Array<{ variant: string; barcode?: string | null; retail_price?: number | null; mrp?: number | null }> }) {
  guard(ctx, 'item.edit');
  const parent = ctx.db.get<Record<string, unknown> & { id: number; name: string; parent_id: number | null }>('SELECT * FROM items WHERE id = ?', [input.parentId]);
  if (!parent) throw new AppError('Item not found.');
  if (parent.parent_id) throw new AppError('Add variants to the main item, not to a variant.');
  const copy = ['short_code', 'category', 'brand', 'hsn', 'gst_rate', 'cess_rate', 'base_unit', 'is_loose', 'tax_inclusive', 'mrp', 'retail_price', 'wholesale_price', 'super_price', 'purchase_price', 'reorder_level', 'track_batch', 'scheme', 'lead_days'];
  return ctx.db.transaction(() =>
    input.variants
      .filter((v) => v.variant.trim())
      .map((v) => {
        const label = v.variant.trim();
        if (ctx.db.get('SELECT 1 FROM items WHERE parent_id = ? AND variant = ? COLLATE NOCASE', [parent.id, label])) throw new AppError(`Variant “${label}” already exists.`);
        if (v.barcode && ctx.db.get('SELECT 1 FROM items WHERE barcode = ?', [v.barcode])) throw new AppError(`Barcode ${v.barcode} is already used by another item.`);
        const vals: Record<string, unknown> = Object.fromEntries(copy.map((c) => [c, parent[c]]));
        if (v.retail_price != null) vals.retail_price = v.retail_price;
        if (v.mrp != null) vals.mrp = v.mrp;
        const cols = [...Object.keys(vals), 'name', 'barcode', 'parent_id', 'variant'];
        const id = ctx.db.exec(`INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, [
          ...Object.values(vals), `${parent.name} — ${label}`, v.barcode?.trim() || null, parent.id, label,
        ] as never).lastId;
        audit(ctx, 'item.variant', 'item', id, { parent: parent.name, variant: label });
        return id;
      }),
  );
}

export function variantsOf(ctx: Ctx, parentId: number) {
  guard(ctx, 'item.view');
  return ctx.db.query<{ id: number; name: string; variant: string; barcode: string | null; retail_price: number; mrp: number; stock: number }>(
    'SELECT i.id, i.name, i.variant, i.barcode, i.retail_price, i.mrp, (SELECT COALESCE(SUM(qty), 0) FROM batches WHERE item_id = i.id) AS stock FROM items i WHERE i.parent_id = ? AND i.active = 1 ORDER BY i.id',
    [parentId],
  );
}
