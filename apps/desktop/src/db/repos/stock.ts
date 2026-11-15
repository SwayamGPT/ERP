import { allocateFifo, roundQty } from '@hisaab/core';
import { AppError, audit, guard, localNow, type Ctx } from './base';

/* ───────── godowns ───────── */

export function listGodowns(ctx: Ctx) {
  guard(ctx, 'item.view');
  return ctx.db.query<{ id: number; name: string; is_default: number; active: number; items: number; units: number }>(
    `SELECT g.*, (SELECT COUNT(DISTINCT item_id) FROM batches WHERE godown_id = g.id AND qty > 0) AS items,
       (SELECT COALESCE(SUM(qty), 0) FROM batches WHERE godown_id = g.id AND qty > 0) AS units
     FROM godowns g ORDER BY g.is_default DESC, g.name`,
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
