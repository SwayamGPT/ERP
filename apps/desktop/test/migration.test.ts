import initSqlJs from 'sql.js';
import { checkItems, checkParties, fileTotals, gstinCheckChar, makeEan13, type ItemRecord, type PartyRecord } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function shop(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-14' };
  api['company.setup'](ctx, {
    name: 'Shree Medical', businessType: 'kirana', gstin: `27AAPFU0939F1Z${gstinCheckChar('27AAPFU0939F1Z')}`, fssai: '11523999000123', phone: '9822012345',
    email: 'a@b.in', address: 'Shop 1, Main Road', city: 'Pune', pincode: '411001', ownerName: 'Owner', ownerPin: '1234',
  } as never);
  api['auth.login'](ctx, { userId: db.get<{ id: number }>("SELECT id FROM users WHERE role = 'owner'")!.id, pin: '1234' });
  return ctx;
}

/** A medical store's batch-wise stock statement: every medicine in two batches with their own cost and expiry. */
function medicalStore(n: number): ItemRecord[] {
  const recs: ItemRecord[] = [];
  let row = 2;
  for (let i = 1; i <= n; i++)
    for (let b = 0; b < 2; b++)
      recs.push({ row: row++, name: `Medicine ${i} Tab 10s`, barcode: makeEan13(`8907${String(i).padStart(8, '0')}`), hsn: '3004', gst: 12, unit: 'Pcs', mrp: 10000, rate: 9500, cost: 7000 + b * 100, qty: 10 + b, batch: `B${i}-${b}`, expiry: `2027-0${1 + b}-28`, warnings: [] });
  return recs;
}

const dump = (ctx: Ctx) => ['items', 'batches', 'stock_moves', 'ledger_entries', 'parties', 'audit_log'].map((t) => ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n);

describe('migrating a shop', () => {
  it('a trial run reports exactly what the import will do, and changes nothing', () => {
    const ctx = shop();
    const recs = medicalStore(200);
    const before = dump(ctx);
    const trial = api['import.trial'](ctx, { kind: 'items', records: recs });
    expect(dump(ctx)).toEqual(before);
    expect(trial.result.created).toBe(200);
    expect(trial.result.batches).toBe(400);
    const file = fileTotals('items', recs);
    expect(trial.delta.items).toBe(file.items);
    expect(trial.delta.stockQty).toBe(file.stockQty);
    expect(trial.delta.stockValue).toBe(file.stockValue); // each batch keeps its own cost
    expect(trial.delta.stockValue).toBe(200 * (10 * 7000 + 11 * 7100));

    const real = api['import.items'](ctx, { records: recs });
    expect(real.created).toBe(trial.result.created);
    expect(api['import.totals'](ctx)).toEqual(trial.after);
    expect(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM batches WHERE batch_no LIKE 'B1-%' AND expiry IS NOT NULL")!.n).toBe(2);
  });

  it('party balances match the old software: receivable and payable', () => {
    const ctx = shop();
    const recs: PartyRecord[] = [
      { row: 2, name: 'Apollo Clinic', kind: 'customer', balance: 345000, warnings: [] },
      { row: 3, name: 'Dr Mehta', kind: 'customer', balance: 120050, warnings: [] },
      { row: 4, name: 'Cipla Distributor', kind: 'supplier', balance: -1800000, warnings: [] },
    ];
    const trial = api['import.trial'](ctx, { kind: 'parties', records: recs });
    const file = fileTotals('parties', recs);
    expect(file.receivable).toBe(465050);
    expect(trial.delta.receivable).toBe(465050);
    expect(trial.delta.payable).toBe(1800000);
    expect(dump(ctx)[4]).toBe(1); // only the walk-in party still
    api['import.parties'](ctx, { records: recs });
    const health = api['reports.health'](ctx);
    expect(health.balanced).toBe(true);
  });

  it('flags what needs a look before importing', () => {
    const items = checkItems(
      [
        { row: 2, name: 'A', barcode: '890', unit: 'Pcs', qty: 5, gst: 12, rate: 100, warnings: [] },
        { row: 3, name: 'B', barcode: '890', unit: 'Pcs', qty: 5, gst: 13, rate: 100, warnings: [] },
        { row: 4, name: 'C', unit: 'Pcs', qty: 2, expiry: '2025-01-31', gst: 5, rate: 100, cost: 200, mrp: 150, warnings: [] },
        { row: 5, name: 'D', unit: 'Pcs', batch: 'X1', gst: 5, warnings: [] },
      ],
      '2026-11-14',
    );
    expect(items[0].warnings.join()).toContain('Barcode 890 is on 2 different items');
    expect(items[1].warnings.join()).toContain('GST 13% is not a GST rate');
    expect(items[2].warnings.join()).toMatch(/Stock already expired.*Cost is above MRP/);
    expect(items[3].warnings.join()).toMatch(/No selling price.*Batch line with no quantity/);
    // Checks are not added twice when run again
    expect(checkItems(items, '2026-11-14')[0].warnings).toEqual(items[0].warnings);
    const parties = checkParties([
      { row: 2, name: 'Ramesh', kind: 'customer', warnings: [] },
      { row: 3, name: 'ramesh', kind: 'customer', warnings: [] },
      { row: 4, name: 'Ramesh', kind: 'supplier', warnings: [] },
    ]);
    expect(parties[0].warnings).toHaveLength(1);
    expect(parties[2].warnings).toHaveLength(0);
  });

  it('a 2,000-medicine store with 4,000 batches imports in seconds', () => {
    const ctx = shop();
    const t0 = performance.now();
    const r = api['import.items'](ctx, { records: medicalStore(2000) });
    expect(r.created).toBe(2000);
    expect(r.batches).toBe(4000);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 60_000);
});

const perf = process.env.HISAAB_PERF ? describe : describe.skip;
perf('migration performance budget', () => {
  it('15,000 medicines with 30,000 batches: trial run and import each under 30 s', () => {
    const ctx = shop();
    const recs = medicalStore(15_000);
    let t0 = performance.now();
    const trial = api['import.trial'](ctx, { kind: 'items', records: recs });
    const trialMs = performance.now() - t0;
    t0 = performance.now();
    const r = api['import.items'](ctx, { records: recs });
    const importMs = performance.now() - t0;
    console.log(JSON.stringify({ items: 15000, batches: 30000, trialMs: Math.round(trialMs), importMs: Math.round(importMs) }));
    expect(trial.result.created).toBe(15_000);
    expect(r.batches).toBe(30_000);
    expect(trialMs).toBeLessThan(30_000);
    expect(importMs).toBeLessThan(30_000);
  }, 300_000);
});
