import initSqlJs from 'sql.js';
import { gstinCheckChar, makeEan13 } from '@hisaab/core';
import { describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';

/**
 * Performance budget (quality gate): saving a bill stays under 50 ms with 50,000 items and
 * 100,000 past invoices. Run with: HISAAB_PERF=1 npx vitest run apps/desktop/test/perf.test.ts
 */
const ITEMS = 50_000;
const INVOICES = 100_000;
const run = process.env.HISAAB_PERF ? describe : describe.skip;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

/** Bulk-load a big shop directly in SQL (the real posting engine would take minutes). */
function bigShop(SQL: Awaited<ReturnType<typeof initSqlJs>>) {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-14' };
  api['company.setup'](ctx, {
    name: 'Big Mart', businessType: 'supermarket', gstin: `27AAPFU0939F1Z${gstinCheckChar('27AAPFU0939F1Z')}`, fssai: '11523999000123', phone: '9822012345',
    email: 'a@b.in', address: 'Shop 1, Main Road', city: 'Pune', pincode: '411001', ownerName: 'Owner', ownerPin: '1234',
  });
  const raw = db.db;
  raw.run('BEGIN');
  const ins = raw.prepare('INSERT INTO items (id, name, short_code, barcode, hsn, gst_rate, base_unit, mrp, retail_price, purchase_price, reorder_level, track_batch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const bat = raw.prepare('INSERT INTO batches (item_id, batch_no, expiry, mrp, cost, qty, received_at) VALUES (?,?,?,?,?,?,?)');
  const words = ['Rice', 'Atta', 'Dal', 'Oil', 'Sugar', 'Tea', 'Soap', 'Biscuit', 'Noodles', 'Ghee', 'Salt', 'Masala', 'Juice', 'Shampoo', 'Detergent'];
  for (let i = 1; i <= ITEMS; i++) {
    const price = 1000 + (i % 500) * 100;
    ins.run([i, `${words[i % words.length]} Brand${i % 997} ${i % 7 === 0 ? '5kg' : '1kg'} #${i}`, `C${i}`, makeEan13(`8907${String(i).padStart(8, '0')}`), '1006', [0, 5, 18, 40][i % 4], 'Pcs', price, price, Math.round(price * 0.8), 5, i % 3 === 0 ? 1 : 0]);
    bat.run([i, i % 3 === 0 ? `B${i}` : null, i % 3 === 0 ? '2027-06-30' : null, price, Math.round(price * 0.8), 100000, '2026-01-01 09:00:00']);
  }
  ins.free();
  bat.free();
  const walkin = db.get<{ id: number }>('SELECT id FROM parties WHERE is_walkin = 1')!.id;
  const inv = raw.prepare(`INSERT INTO invoices (id, kind, number, date, party_id, party_name, place_of_supply, inter_state, gross, taxable, cgst, sgst, total, paid, payment_mode, cost_total, created_by, created_at)
    VALUES (?, 'sale', ?, ?, ?, 'Walk-in Customer', '27', 0, ?, ?, ?, ?, ?, ?, 'cash', ?, 1, ?)`);
  const line = raw.prepare(`INSERT INTO invoice_lines (invoice_id, item_id, name, hsn, unit, qty, rate, gross, taxable, gst_rate, cgst, sgst, total, cost, allocations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const pay = raw.prepare("INSERT INTO payments (direction, kind, party_id, invoice_id, amount, mode, date, created_by) VALUES ('in', 'party', ?, ?, ?, 'cash', ?, 1)");
  const led = raw.prepare('INSERT INTO ledger_entries (voucher_type, voucher_id, date, account, party_id, debit, credit) VALUES (?,?,?,?,?,?,?)');
  const mv = raw.prepare("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date) VALUES (?,?,?,?, 'sale', ?, ?)");
  for (let n = 1; n <= INVOICES; n++) {
    const d = new Date(Date.UTC(2025, 0, 1) + Math.floor((n / INVOICES) * 680) * 86400000).toISOString().slice(0, 10);
    const total = 31500;
    inv.run([n, `INV-${n}`, d, walkin, total, 30000, 750, 750, total, total, 24000, `${d} 10:00:00`]);
    for (let k = 0; k < 3; k++) {
      const item = ((n * 7 + k * 13) % ITEMS) + 1;
      line.run([n, item, `Item ${item}`, '1006', 'Pcs', 1, 10500, 10500, 10000, 5, 250, 250, 10500, 8000, `[{"b":${item},"q":1,"c":8000}]`]);
      mv.run([item, item, -1, 8000, n, d]);
    }
    pay.run([walkin, n, total, d]);
    for (const [acc, dr, cr] of [['PARTY', total, 0], ['SALES', 0, 30000], ['OUT_CGST', 0, 750], ['OUT_SGST', 0, 750]] as const) led.run(['sale', n, d, acc, acc === 'PARTY' ? walkin : null, dr, cr]);
    led.run(['payment', n, d, 'CASH', null, total, 0]);
    led.run(['payment', n, d, 'PARTY', walkin, 0, total]);
  }
  for (const s of [inv, line, pay, led, mv]) s.free();
  raw.run(`UPDATE company SET next_invoice_no = ${INVOICES + 1}`);
  raw.run('COMMIT');
  return ctx;
}

run('performance budget', () => {
  it(`saves a bill in < 50 ms with ${ITEMS.toLocaleString()} items and ${INVOICES.toLocaleString()} invoices`, async () => {
    const SQL = await initSqlJs();
    let t = performance.now();
    const ctx = bigShop(SQL);
    console.log(`seeded in ${Math.round(performance.now() - t)} ms`);
    api['auth.login'](ctx, { userId: 1, pin: '1234' });

    const timings: Record<string, number[]> = { save: [], search: [], scan: [], preview: [] };
    for (let i = 0; i < 200; i++) {
      const ids = [1 + ((i * 37) % ITEMS), 1 + ((i * 91) % ITEMS), 1 + ((i * 53) % ITEMS)];
      t = performance.now();
      api['items.search'](ctx, { q: `Brand${i % 997} 1kg` });
      timings.search.push(performance.now() - t);
      t = performance.now();
      api['items.search'](ctx, { q: makeEan13(`8907${String(ids[0]).padStart(8, '0')}`) });
      timings.scan.push(performance.now() - t);
      const lines = ids.map((itemId) => ({ itemId, unit: 'Pcs', factor: 1, qty: 1 + (i % 3), rate: 2000 }));
      t = performance.now();
      const pv = api['invoices.preview'](ctx, { kind: 'sale', lines });
      timings.preview.push(performance.now() - t);
      t = performance.now();
      api['invoices.create'](ctx, { kind: 'sale', lines, payments: [{ mode: 'cash', amount: pv.totals.payable }] });
      timings.save.push(performance.now() - t);
    }
    t = performance.now();
    api['reports.dashboard'](ctx);
    const dash = performance.now() - t;
    t = performance.now();
    const bytes = ctx.db.exportDb();
    const exportMs = performance.now() - t;
    const report = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, { p50: +pct(v, 50).toFixed(1), p95: +pct(v, 95).toFixed(1) }]));
    console.log(JSON.stringify({ ...report, dashboardMs: Math.round(dash), dbMB: +(bytes.length / 1e6).toFixed(1), snapshotMs: Math.round(exportMs) }, null, 1));
    expect(pct(timings.save, 95)).toBeLessThan(50);
    expect(pct(timings.scan, 95)).toBeLessThan(20);
    expect(api['reports.health'](ctx).balanced).toBe(true);
  }, 600_000);
});
