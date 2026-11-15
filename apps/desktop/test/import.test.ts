import initSqlJs from 'sql.js';
import { detect, gstinCheckChar, toItems, toParties } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const G = (s: string) => s + gstinCheckChar(s);

function shop(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-15' };
  api['company.setup'](ctx, {
    name: 'Test Store', businessType: 'kirana', gstin: G('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345', email: 'o@t.in', address: 'Shop 4', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
  });
  return ctx;
}

describe('import from Marg / Excel', () => {
  it('items with batch-wise opening stock land with the right stock and value', () => {
    const ctx = shop();
    const d = detect([
      ['Stock Statement'],
      ['Item Name', 'Unit', 'Batch', 'Exp.', 'Qty', 'MRP', 'P.Rate', 'S.Rate', 'GST%', 'HSN'],
      ['BEVERAGES'],
      ['Tata Tea Gold 250g', 'NOS', 'TG11', '11/27', '24', '150', '118.50', '145', '5', '0902'],
      ['Tata Tea Gold 250g', 'NOS', 'TG12', '03/28', '12', '150', '120.00', '145', '5', '0902'],
      ['Sugar Loose', 'KGS', '', '', '48.5', '0', '40', '46', '5', '1701'],
      ['Bad Item', 'NOS', '', '', '-3', '10', '5', '9', '5', ''],
      ['Total', '', '', '', '81.5'],
    ]);
    const { records } = toItems(d);
    const r = api['import.items'](ctx, { records });
    expect(r).toMatchObject({ created: 2, batches: 3, updated: 0 });
    expect(r.errors).toEqual([{ row: 7, name: 'Bad Item', reason: 'Negative stock cannot be imported as opening stock.' }]);
    const tea = ctx.db.get<{ id: number; category: string; hsn: string; gst_rate: number; mrp: number; retail_price: number; purchase_price: number; track_batch: number }>("SELECT * FROM items WHERE name = 'Tata Tea Gold 250g'")!;
    expect(tea).toMatchObject({ category: 'BEVERAGES', hsn: '0902', gst_rate: 5, mrp: 15000, retail_price: 14500, purchase_price: 11850, track_batch: 1 });
    expect(ctx.db.query('SELECT batch_no, expiry, qty, cost FROM batches WHERE item_id = ? ORDER BY id', [tea.id])).toEqual([
      { batch_no: 'TG11', expiry: '2027-11-30', qty: 24, cost: 11850 },
      { batch_no: 'TG12', expiry: '2028-03-31', qty: 12, cost: 12000 },
    ]);
    const s = api['reports.stockDetail'](ctx, {});
    expect(s.totals.costValue).toBe(24 * 11850 + 12 * 12000 + Math.round(48.5 * 4000));
    expect(ctx.db.get<{ is_loose: number; base_unit: string }>("SELECT is_loose, base_unit FROM items WHERE name = 'Sugar Loose'")).toEqual({ is_loose: 1, base_unit: 'Kg' });

    // Importing again: nothing duplicated, stock untouched; with update on, prices refresh.
    expect(api['import.items'](ctx, { records })).toMatchObject({ created: 0, unchanged: 2 });
    const again = api['import.items'](ctx, { records: records.map((x) => ({ ...x, rate: x.rate! + 500 })), updateExisting: true });
    expect(again.updated).toBe(2);
    expect(again.notes[0]).toMatch(/stock was left as it is/);
    expect(ctx.db.get<{ p: number }>("SELECT retail_price AS p FROM items WHERE name = 'Tata Tea Gold 250g'")!.p).toBe(15000);
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('customers and suppliers with Dr / Cr balances become opening balances', () => {
    const ctx = shop();
    const d = detect([
      ['Party Name', 'Station', 'Mobile', 'GSTIN', 'Balance', 'Dr/Cr'],
      ['No Type Here', 'Nashik', '', '', '500', 'Dr'], // before any group heading: type unknown
      ['SUNDRY DEBTORS'],
      ['Meena Aunty', 'Pune', '98220 12345', '', '1,250.00', 'Dr'],
      ['Hotel Annapurna', 'Pune', '12', G('27AAKFM4821K1Z'), '8,400.00', 'Dr'],
      ['SUNDRY CREDITORS'],
      ['Mahalaxmi Distributors', 'Pune', '9822012345', '', '45,000.00', 'Cr'],
    ]);
    const { records } = toParties(d);
    const r = api['import.parties'](ctx, { records });
    expect(r.created).toBe(3);
    expect(r.errors.map((e) => e.name)).toEqual(['No Type Here']);
    const bal = (name: string) => api['parties.get'](ctx, { id: ctx.db.get<{ id: number }>('SELECT id FROM parties WHERE name = ?', [name])!.id }).balance;
    expect(bal('Meena Aunty')).toBe(125000);
    expect(bal('Mahalaxmi Distributors')).toBe(-4500000);
    expect(ctx.db.get<{ phone: string | null; state_code: string }>("SELECT phone, state_code FROM parties WHERE name = 'Hotel Annapurna'")).toEqual({ phone: null, state_code: '27' });
    expect(api['import.parties'](ctx, { records, defaultKind: 'customer' })).toMatchObject({ created: 1, unchanged: 3 }); // balances not added twice
    expect(api['reports.health'](ctx).balanced).toBe(true);
  });

  it('only the owner can import', () => {
    const ctx = shop();
    const id = api['users.save'](ctx, { name: 'M', role: 'manager', pin: '5555' }) as number;
    api['auth.login'](ctx, { userId: id, pin: '5555' });
    expect(() => api['import.items'](ctx, { records: [] })).toThrow(/permission/);
  });
});
