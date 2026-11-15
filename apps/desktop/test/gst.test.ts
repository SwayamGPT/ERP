import initSqlJs from 'sql.js';
import { gstinCheckChar, irnFor } from '@hisaab/core';
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
const MY = G('27AAPFU0939F1Z');
const BUYER = G('27AAKFM4821K1Z');
const SUP = G('27AAGFO7734P1Z');

function shop(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  const ctx: Ctx = { db, session: null, today: () => '2026-11-13' };
  api['company.setup'](ctx, {
    name: 'Test Store', businessType: 'wholesaler', gstin: MY, fssai: '11523999000123', phone: '9822012345', email: 'o@t.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234',
  });
  return ctx;
}

describe('e-invoice and e-way bill', () => {
  it('prepares the IRP JSON, blocks what the portal would reject, and records IRNs', () => {
    const ctx = shop();
    const rice = api['items.save'](ctx, { name: 'Basmati Rice 25kg', hsn: '1006', gst_rate: 5, base_unit: 'Bag', mrp: 200000, retail_price: 180000, purchase_price: 150000 } as never) as number;
    const noHsn = api['items.save'](ctx, { name: 'Gift box', gst_rate: 18, base_unit: 'Pcs', mrp: 10000, retail_price: 10000 } as never) as number;
    const hotel = api['parties.save'](ctx, { kind: 'customer', name: 'Hotel Annapurna', gstin: BUYER, state_code: '27', address: 'FC Road', city: 'Pune', pincode: '411004', credit_limit: 1e9 } as never) as number;
    const inv = api['invoices.create'](ctx, { kind: 'sale', partyId: hotel, lines: [{ itemId: rice, unit: 'Bag', factor: 1, qty: 2, rate: 180000 }] });
    const e = api['einvoice.json'](ctx, { id: inv.id });
    expect(e.problems).toEqual([]);
    expect(e.json.BuyerDtls.Gstin).toBe(BUYER);
    expect(e.json.ItemList[0]).toMatchObject({ HsnCd: '1006', Unit: 'BAG', Qty: 2 });
    expect(e.json.ValDtls.TotInvVal).toBe(inv.total / 100);
    const v = e.json.ValDtls;
    expect(Math.round((v.AssVal + v.CgstVal + v.SgstVal + v.IgstVal + v.CesVal + v.RndOffAmt) * 100)).toBe(inv.total);

    const bad = api['invoices.create'](ctx, { kind: 'sale', partyId: hotel, lines: [{ itemId: noHsn, unit: 'Pcs', factor: 1, qty: 1, rate: 10000 }] });
    const bulk = api['einvoice.bulk'](ctx, { period: '2026-11' });
    expect(bulk.count).toBe(1);
    expect(bulk.skipped).toEqual([{ number: bad.number, problems: ['Line 1 (Gift box): HSN code must be 4–8 digits.'] }]);

    // Test mode generates a (clearly marked) IRN; the portal's response file attaches real ones.
    expect(() => api['einvoice.test'](ctx, { id: inv.id })).toThrow(/test mode/);
    api['company.save'](ctx, { einvoice_mode: 'test' } as never);
    api['einvoice.test'](ctx, { id: inv.id });
    const got = api['invoices.get'](ctx, { id: inv.id });
    expect(got.irn).toBe(irnFor(MY, 'INV', inv.number, inv.date));
    expect(got.irn_test).toBe(1);
    expect(got.irn_qr).toMatch(/^TEST\./);
    expect(() => api['einvoice.test'](ctx, { id: inv.id })).toThrow(/already has an IRN/);

    const r = api['einvoice.apply'](ctx, { results: [{ docNo: bad.number, irn: 'f'.repeat(64), ackNo: '112010036563310', ackDate: '2026-11-13 11:05:00', signedQr: 'eyJ...', ewbNo: null }, { docNo: 'NOPE-1', irn: 'a', ackNo: '', ackDate: '', signedQr: 'x' }] });
    expect(r).toEqual({ applied: 1, unknown: ['NOPE-1'] });
    expect(api['invoices.get'](ctx, { id: bad.id }).irn_test).toBe(0);

    expect(() => api['ewaybill.set'](ctx, { id: inv.id, ewbNo: '1234' })).toThrow(/12 digits/);
    api['ewaybill.set'](ctx, { id: inv.id, ewbNo: '1312 0045 6789' });
    expect(api['invoices.get'](ctx, { id: inv.id }).ewb_no).toBe('131200456789');
  });
});

describe('GSTR-2B reconciliation', () => {
  it('matches the portal’s 2B with purchase bills and expense GST bills', () => {
    const ctx = shop();
    const it = api['items.save'](ctx, { name: 'Sugar 50kg', hsn: '1701', gst_rate: 5, base_unit: 'Bag', mrp: 300000, retail_price: 280000, purchase_price: 200000 } as never) as number;
    const sup = api['parties.save'](ctx, { kind: 'supplier', name: 'Om Sai FMCG', gstin: SUP, state_code: '27' } as never) as number;
    const buy = (billNo: string, qty: number, date: string) => api['invoices.create'](ctx, { kind: 'purchase', partyId: sup, date, supplierBillNo: billNo, lines: [{ itemId: it, unit: 'Bag', factor: 1, qty, rate: 200000, taxInclusive: false }] });
    buy('OS/101', 1, '2026-10-04'); // in 2B, same tax
    buy('OS/102', 2, '2026-10-12'); // in 2B with different tax
    buy('OS/103', 1, '2026-10-20'); // supplier hasn't filed → credit at risk
    const twoB = {
      data: {
        gstin: MY, rtnprd: '102026',
        docdata: {
          b2b: [{ ctin: SUP, trdnm: 'Om Sai FMCG', inv: [
            { inum: 'OS-101', dt: '04-10-2026', val: 2100, items: [{ txval: 2000, cgst: 50, sgst: 50 }] },
            { inum: 'OS/102', dt: '12-10-2026', val: 4100, items: [{ txval: 4000, cgst: 50, sgst: 50 }] },
            { inum: 'OS/099', dt: '28-09-2026', val: 1050, items: [{ txval: 1000, cgst: 25, sgst: 25 }] },
          ] }],
        },
      },
    };
    expect(api['gstr2b.import'](ctx, { json: twoB })).toEqual({ period: '2026-10', rows: 3 });
    const r = api['gstr2b.recon'](ctx, { period: '2026-10' });
    expect(r.rows.map((x) => [x.status, x.twoB?.docNo ?? x.book?.docNo])).toEqual([
      ['missing_in_books', 'OS/099'], // in date order
      ['matched', 'OS-101'],
      ['mismatch', 'OS/102'],
      ['missing_in_2b', 'OS/103'],
    ]);
    expect(r.summary.atRisk).toBe(10000);
    expect(() => api['gstr2b.import'](ctx, { json: { data: { ...twoB.data, gstin: SUP } } })).toThrow(/not your GSTIN/);
    api['gstr2b.import'](ctx, { json: twoB }); // re-import replaces, doesn't duplicate
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gstr2b_rows')!.n).toBe(3);
  });
});
