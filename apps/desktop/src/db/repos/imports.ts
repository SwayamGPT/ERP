import { cessForHsn, gstRateForHsn, roundQty, type ItemRecord, type PartyRecord } from '@hisaab/core';
import { AppError, audit, guard, type Ctx } from './base';
import { adjustStock, saveItem } from './items';
import { saveParty } from './parties';

/**
 * Bring masters and opening balances over from Marg, Tally, Busy or any spreadsheet. Records come
 * from the smart parser (@hisaab/core smartImport). Everything runs in one transaction; a row that
 * fails is rolled back on its own and reported, the rest still import.
 */

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  batches: number;
  errors: Array<{ row: number; name: string; reason: string }>;
  notes: string[];
}

const LOOSE = new Set(['Kg', 'g', 'Ltr', 'ml']);

export function importItems(ctx: Ctx, input: { records: ItemRecord[]; updateExisting?: boolean; ratesIncludeGst?: boolean }): ImportResult {
  guard(ctx, 'settings.edit');
  const res: ImportResult = { created: 0, updated: 0, unchanged: 0, batches: 0, errors: [], notes: [] };
  // One item can appear on several lines (one per batch in a stock statement).
  const groups = new Map<string, ItemRecord[]>();
  for (const r of input.records) {
    const key = (r.barcode || r.code || r.name).trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let stockNotChanged = 0;
  // Look-ups by barcode / code / name, built once: a per-row case-insensitive search scans the whole
  // items table, which makes a 15,000-item migration quadratic.
  const byBarcode = new Map<string, number>();
  const byCode = new Map<string, number>();
  const byName = new Map<string, number>();
  for (const it of ctx.db.query<{ id: number; barcode: string | null; short_code: string | null; name: string; active: number }>('SELECT id, barcode, short_code, name, active FROM items ORDER BY id')) {
    if (it.barcode && !byBarcode.has(it.barcode)) byBarcode.set(it.barcode, it.id);
    if (!it.active) continue;
    if (it.short_code && !byCode.has(it.short_code.toLowerCase())) byCode.set(it.short_code.toLowerCase(), it.id);
    if (!byName.has(it.name.toLowerCase())) byName.set(it.name.toLowerCase(), it.id);
  }
  const unitBarcodes = new Set(ctx.db.query<{ b: string }>("SELECT barcode AS b FROM item_units WHERE barcode IS NOT NULL AND barcode <> ''").map((x) => x.b));
  ctx.db.transaction(() => {
    for (const recs of groups.values()) {
      const r = recs[0];
      try {
        ctx.db.transaction(() => {
          const found = (r.barcode && byBarcode.get(r.barcode)) || (r.code && byCode.get(r.code.toLowerCase())) || byName.get(r.name.toLowerCase());
          const existing = found ? { id: found } : null;
          if (existing) {
            if (recs.some((x) => x.qty)) stockNotChanged++;
            if (!input.updateExisting) return void res.unchanged++;
            const set: string[] = [];
            const vals: unknown[] = [];
            const put = (col: string, v: unknown) => v != null && v !== '' && (set.push(`${col} = ?`), vals.push(v));
            put('mrp', r.mrp);
            put('retail_price', r.rate);
            put('wholesale_price', r.wholesale);
            put('purchase_price', r.cost);
            put('gst_rate', r.gst);
            put('hsn', r.hsn);
            put('category', r.category);
            put('brand', r.brand);
            put('reorder_level', r.reorder);
            if (set.length) ctx.db.exec(`UPDATE items SET ${set.join(', ')} WHERE id = ?`, [...vals, existing.id] as never);
            return void res.updated++;
          }
          const stock = recs.filter((x) => (x.qty ?? 0) !== 0);
          for (const x of stock) if ((x.qty ?? 0) < 0) throw new AppError('Negative stock cannot be imported as opening stock.');
          const [first, ...more] = stock;
          const tracked = recs.some((x) => x.batch || x.expiry);
          const id = saveItem(ctx, {
            name: r.name,
            short_code: r.code ?? null,
            barcode: r.barcode && !unitBarcodes.has(r.barcode) ? r.barcode : null,
            category: r.category ?? null,
            brand: r.brand ?? null,
            hsn: r.hsn ?? null,
            gst_rate: r.gst ?? gstRateForHsn(r.hsn) ?? 0, // no GST column: the usual rate for its HSN code
            ...(r.gst == null ? { cess_rate: cessForHsn(r.hsn) } : {}),
            base_unit: r.unit,
            is_loose: LOOSE.has(r.unit),
            tax_inclusive: input.ratesIncludeGst !== false,
            mrp: r.mrp ?? r.rate ?? 0,
            retail_price: r.rate ?? r.mrp ?? 0,
            wholesale_price: r.wholesale ?? null,
            purchase_price: r.cost ?? 0,
            reorder_level: r.reorder ?? 0,
            track_batch: tracked,
            opening: first ? { qty: roundQty(first.qty!), cost: first.cost ?? r.cost ?? 0, batchNo: first.batch ?? null, expiry: first.expiry ?? null } : null,
          });
          for (const b of more) {
            adjustStock(ctx, { itemId: id, delta: roundQty(b.qty!), note: 'Opening stock (import)', batchNo: b.batch ?? null, expiry: b.expiry ?? null });
            const cost = b.cost ?? r.cost;
            if (cost != null) {
              // Keep each batch's own purchase cost (stock value at cost depends on it).
              ctx.db.exec('UPDATE batches SET cost = ?, mrp = COALESCE(?, mrp) WHERE id = (SELECT MAX(id) FROM batches WHERE item_id = ?)', [cost, b.mrp ?? null, id]);
              ctx.db.exec('UPDATE stock_moves SET cost = ? WHERE id = (SELECT MAX(id) FROM stock_moves WHERE item_id = ?)', [cost, id]);
            }
          }
          res.batches += stock.length;
          res.created++;
          if (r.barcode) byBarcode.set(r.barcode, id);
          if (r.code) byCode.set(r.code.toLowerCase(), id);
          byName.set(r.name.toLowerCase(), id);
        });
      } catch (e) {
        res.errors.push({ row: r.row, name: r.name, reason: (e as Error).message });
      }
    }
    audit(ctx, 'import.items', 'items', undefined, { created: res.created, updated: res.updated, errors: res.errors.length });
  });
  if (stockNotChanged) res.notes.push(`${stockNotChanged} items already existed, so their stock was left as it is. Use stock adjustment if it differs.`);
  return res;
}

export function importParties(ctx: Ctx, input: { records: PartyRecord[]; defaultKind?: 'customer' | 'supplier'; updateExisting?: boolean }): ImportResult {
  guard(ctx, 'settings.edit');
  const res: ImportResult = { created: 0, updated: 0, unchanged: 0, batches: 0, errors: [], notes: [] };
  let balanceSkipped = 0;
  ctx.db.transaction(() => {
    for (const r of input.records) {
      try {
        ctx.db.transaction(() => {
          const kind = r.kind ?? input.defaultKind;
          if (!kind) throw new AppError('Customer or supplier? Choose a default in the import options.');
          const phone = r.phone && /^\d{10}$/.test(r.phone) ? r.phone : null;
          const existing =
            (r.gstin && ctx.db.get<{ id: number }>('SELECT id FROM parties WHERE gstin = ? AND kind = ?', [r.gstin, kind])) ||
            ctx.db.get<{ id: number }>('SELECT id FROM parties WHERE name = ? COLLATE NOCASE AND kind = ? AND is_walkin = 0', [r.name, kind]);
          if (existing) {
            if (r.balance) balanceSkipped++;
            if (!input.updateExisting) return void res.unchanged++;
            ctx.db.exec(
              `UPDATE parties SET phone = COALESCE(?, phone), gstin = COALESCE(?, gstin), state_code = COALESCE(?, state_code), address = COALESCE(?, address),
                 city = COALESCE(?, city), pincode = COALESCE(?, pincode), credit_limit = COALESCE(?, credit_limit), credit_days = COALESCE(?, credit_days) WHERE id = ?`,
              [phone, r.gstin ?? null, r.stateCode ?? null, r.address ?? null, r.city ?? null, r.pincode ?? null, r.creditLimit ?? null, r.creditDays ?? null, existing.id],
            );
            return void res.updated++;
          }
          saveParty(ctx, {
            kind, name: r.name, phone, gstin: r.gstin ?? null, state_code: r.stateCode ?? null, address: r.address ?? null, city: r.city ?? null, pincode: r.pincode ?? null,
            credit_limit: r.creditLimit ?? 0, credit_days: r.creditDays ?? 0, opening_balance: r.balance ?? 0,
          });
          res.created++;
        });
      } catch (e) {
        res.errors.push({ row: r.row, name: r.name, reason: (e as Error).message });
      }
    }
    audit(ctx, 'import.parties', 'parties', undefined, { created: res.created, updated: res.updated, errors: res.errors.length });
  });
  if (balanceSkipped) res.notes.push(`${balanceSkipped} parties already existed, so their balance was not added again.`);
  return res;
}

/* ───────── migration safety: trial run and reconciliation ───────── */

/** What the books hold, for comparing an import with the old software's own totals. Money in paise. */
export interface BookTotals {
  items: number;
  batches: number;
  stockQty: number;
  stockValue: number;
  parties: number;
  receivable: number;
  payable: number;
}

export function bookTotals(ctx: Ctx): BookTotals {
  const g = <T>(sql: string) => ctx.db.get<T>(sql)!;
  const party = g<{ r: number; p: number }>(
    `SELECT COALESCE(SUM(CASE WHEN b > 0 THEN b ELSE 0 END), 0) AS r, COALESCE(SUM(CASE WHEN b < 0 THEN -b ELSE 0 END), 0) AS p
       FROM (SELECT party_id, SUM(debit - credit) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id IS NOT NULL GROUP BY party_id)`,
  );
  return {
    items: g<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE active = 1').n,
    batches: g<{ n: number }>('SELECT COUNT(*) AS n FROM batches WHERE qty <> 0').n,
    stockQty: Math.round(g<{ q: number }>('SELECT COALESCE(SUM(qty), 0) AS q FROM batches').q * 1000) / 1000,
    stockValue: Math.round(g<{ v: number }>('SELECT COALESCE(SUM(qty * cost), 0) AS v FROM batches WHERE qty > 0').v),
    parties: g<{ n: number }>('SELECT COUNT(*) AS n FROM parties WHERE is_walkin = 0 AND active = 1').n,
    receivable: party.r,
    payable: party.p,
  };
}

const ROLLBACK = new Error('trial run');

/**
 * Run an import for real inside a transaction, measure what it would do, then roll everything
 * back. Nothing is saved, synced or audited; the owner sees the outcome first.
 */
export function trialImport(
  ctx: Ctx,
  input: { kind: 'items'; records: ItemRecord[]; updateExisting?: boolean; ratesIncludeGst?: boolean } | { kind: 'parties'; records: PartyRecord[]; defaultKind?: 'customer' | 'supplier'; updateExisting?: boolean },
) {
  guard(ctx, 'settings.edit');
  const before = bookTotals(ctx);
  let out: { result: ImportResult; after: BookTotals } | null = null;
  try {
    ctx.db.transaction(() => {
      const result = input.kind === 'items' ? importItems(ctx, input) : importParties(ctx, input);
      out = { result, after: bookTotals(ctx) };
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  const { result, after } = out!;
  const delta = Object.fromEntries(Object.keys(before).map((k) => [k, Math.round(((after as never)[k] - (before as never)[k]) * 1000) / 1000])) as unknown as BookTotals;
  return { result, before, after, delta };
}
