import initSqlJs from 'sql.js';
import { gstinCheckChar, tallyVouchersXml, voucherImbalance } from '@hisaab/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SqlJsAdapter } from '../src/db/adapter';
import { api } from '../src/db/api';
import type { Ctx } from '../src/db/repos/base';
import { migrate } from '../src/db/schema';
import { loadSample } from './fixtures/seed';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const TODAY = '2026-11-13';
function shop(): Ctx {
  const db = new SqlJsAdapter(new SQL.Database());
  migrate(db);
  let today = TODAY;
  const ctx: Ctx = { db, session: null, today: () => today };
  (ctx as unknown as { setToday: (d: string) => void }).setToday = (d) => (today = d);
  api['company.setup'](ctx, {
    name: 'Test Store', businessType: 'kirana', gstin: '27AAPFU0939F1Z' + gstinCheckChar('27AAPFU0939F1Z'), fssai: '11523999000123', phone: '9822012345',
    email: 'o@t.in', address: 'Shop 4', city: 'Pune', pincode: '411037', ownerName: 'Owner', ownerPin: '1234', openingCash: 500000,
  });
  loadSample(ctx, 'kirana');
  return ctx;
}

/** Split the XML into vouchers and add up each one's top-level amounts (Tally: debit negative). */
function parseVouchers(xml: string) {
  return [...xml.matchAll(/<VOUCHER [^>]*VCHTYPE="([^"]+)"[^>]*>([\s\S]*?)<\/VOUCHER>/g)].map(([, type, body]) => {
    const top = body.replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g, '').replace(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/g, '');
    const sum = [...top.matchAll(/<AMOUNT>(-?\d+\.\d\d)<\/AMOUNT>/g)].reduce((s, m) => s + Math.round(Number(m[1]) * 100), 0);
    return { type, body, sum, number: /<VOUCHERNUMBER>([^<]*)</.exec(body)?.[1] ?? '' };
  });
}

describe('Export to Tally', () => {
  it('exports a month of a real shop with every voucher balanced', () => {
    const ctx = shop();
    const out = api['tally.vouchers'](ctx, { from: '2026-10-01', to: TODAY });
    expect(out.problems).toEqual([]);
    const v = parseVouchers(out.xml);
    expect(v.length).toBe(out.total);
    expect(v.length).toBeGreaterThan(50);
    for (const x of v) expect(x.sum, `${x.type} ${x.number}`).toBe(0);
    const sales = ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM invoices WHERE kind = 'sale' AND status = 'final' AND date BETWEEN '2026-10-01' AND ?", [TODAY])!.n;
    expect(out.counts.Sales).toBe(sales);
    expect(out.counts.Purchase).toBeGreaterThan(0);
    expect(out.counts.Receipt).toBeGreaterThan(0);
    // Item lines with quantities, rates and the GST-rate sales ledger
    const sale = v.find((x) => x.type === 'Sales')!;
    expect(sale.body).toMatch(/<ALLINVENTORYENTRIES\.LIST><STOCKITEMNAME>[^<]+<\/STOCKITEMNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><RATE>[\d.]+\/\w+<\/RATE>/);
    expect(sale.body).toMatch(/<LEDGERNAME>Sales @ \d+%<\/LEDGERNAME>/);
    expect(sale.body).toContain('<BILLTYPE>New Ref</BILLTYPE>');
    // Tax ledgers carry the GST: Output CGST total = the books' Output CGST for the period
    const cgstXml = [...out.xml.matchAll(/<LEDGERNAME>Output CGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>(?:Yes|No)<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>No<\/ISPARTYLEDGER><AMOUNT>(-?[\d.]+)</g)].reduce((s, m) => s + Math.round(Number(m[1]) * 100), 0);
    const cgstBooks = ctx.db.get<{ c: number }>("SELECT COALESCE(SUM(credit - debit), 0) AS c FROM ledger_entries WHERE account = 'OUT_CGST' AND date BETWEEN '2026-10-01' AND ? AND voucher_type <> 'opening'", [TODAY])!.c;
    expect(cgstXml).toBe(cgstBooks);
  });

  it('leaves out bills cancelled in the same period, and sends a later cancellation as a reversal', () => {
    const ctx = shop();
    const sale = ctx.db.get<{ id: number; number: string; date: string }>("SELECT id, number, date FROM invoices WHERE kind = 'sale' AND status = 'final' AND date >= '2026-11-01' ORDER BY id LIMIT 1")!;
    api['invoices.cancel'](ctx, { id: sale.id, reason: 'wrong bill' });
    const same = parseVouchers(api['tally.vouchers'](ctx, { from: '2026-11-01', to: TODAY }).xml);
    expect(same.some((x) => x.number === sale.number)).toBe(false);
    expect(same.some((x) => x.body.includes('Cancelled'))).toBe(false);

    // Exported before it was cancelled: next month's file carries the reversal instead.
    const earlier = parseVouchers(api['tally.vouchers'](ctx, { from: '2026-11-01', to: sale.date }).xml);
    if (sale.date < TODAY) expect(earlier.some((x) => x.number === sale.number)).toBe(true);
  });

  it('builds masters: parties as debtors / creditors with GSTIN, opening balances, items with HSN and GST', () => {
    const ctx = shop();
    const a = api['parties.save'](ctx, { kind: 'customer', name: 'Ramesh', phone: '9800001111', opening_balance: 150000 } as never);
    api['parties.save'](ctx, { kind: 'customer', name: 'Ramesh', phone: '9800002222' } as never);
    const m = api['tally.masters'](ctx);
    expect(a).toBeTruthy();
    expect(m.xml).toContain('<LEDGER NAME="Ramesh" ACTION="Create">');
    expect(m.xml).toContain('<LEDGER NAME="Ramesh (2222)" ACTION="Create">');
    expect(m.xml).toMatch(/<LEDGER NAME="Ramesh" ACTION="Create"><NAME\.LIST><NAME>Ramesh<\/NAME><\/NAME\.LIST><PARENT>Sundry Debtors<\/PARENT><ISBILLWISEON>Yes<\/ISBILLWISEON><OPENINGBALANCE>-1500\.00<\/OPENINGBALANCE>/);
    expect(m.xml).toMatch(/<LEDGER NAME="Cash" ACTION="Create">[\s\S]*?<PARENT>Cash-in-Hand<\/PARENT><ISBILLWISEON>No<\/ISBILLWISEON><OPENINGBALANCE>-5000\.00<\/OPENINGBALANCE>/);
    expect(m.xml).toContain('<PARENT>Sundry Creditors</PARENT>');
    expect(m.xml).toMatch(/<STOCKITEM NAME="[^"]+" ACTION="Create">.*?<BASEUNITS>\w+<\/BASEUNITS>.*?<HSNCODE>\d+<\/HSNCODE>/);
    expect(m.xml).toContain('<UNIT NAME="Kg" ACTION="Create"><NAME>Kg</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>3</DECIMALPLACES></UNIT>');
    expect(m.xml).toContain('<GSTDUTYHEAD>CGST</GSTDUTYHEAD>');
    // Every ledger a voucher uses exists in the masters
    const ledgers = new Set([...m.xml.matchAll(/<LEDGER NAME="([^"]+)"/g)].map((x) => x[1]));
    const items = new Set([...m.xml.matchAll(/<STOCKITEM NAME="([^"]+)"/g)].map((x) => x[1]));
    const vx = api['tally.vouchers'](ctx, { from: '2026-10-01', to: TODAY }).xml;
    for (const [, l] of vx.matchAll(/<LEDGERNAME>([^<]+)<\/LEDGERNAME>/g)) expect(ledgers.has(l), l).toBe(true);
    for (const [, s] of vx.matchAll(/<STOCKITEMNAME>([^<]+)<\/STOCKITEMNAME>/g)) expect(items.has(s), s).toBe(true);
  });

  it("uses the accountant's own ledger names", () => {
    const ctx = shop();
    const list = api['tally.ledgers'](ctx);
    expect(list.find((l) => l.key === 'SALES@5')?.default).toBe('Sales @ 5%');
    api['tally.saveNames'](ctx, { names: { 'SALES@5': 'Sales GST 5%', ROUND_OFF: 'Rounding Off' } });
    const vx = api['tally.vouchers'](ctx, { from: '2026-10-01', to: TODAY }).xml;
    expect(vx).toContain('<LEDGERNAME>Sales GST 5%</LEDGERNAME>');
    expect(vx).not.toContain('<LEDGERNAME>Sales @ 5%</LEDGERNAME>');
    expect(api['tally.masters'](ctx).xml).toContain('<LEDGER NAME="Sales GST 5%"');
  });
});

describe('Tally XML', () => {
  it('writes a sales invoice the way Tally expects', () => {
    const v = {
      type: 'Sales' as const, remoteId: 'hisaab-x-sale-1', number: 'INV-1', date: '2026-11-05', party: 'Meena & Co', partyGstin: null, placeOfSupply: 'Maharashtra', narration: 'Sale INV-1',
      entries: [
        { ledger: 'Meena & Co', amount: 10500, party: true, bill: { name: 'INV-1', type: 'New Ref' as const } },
        { ledger: 'Output CGST', amount: -250 },
        { ledger: 'Output SGST', amount: -250 },
      ],
      inventory: [{ item: 'Sugar', unit: 'Kg', qty: 2, billedQty: 2, amount: -10000, ledger: 'Sales @ 5%' }],
    };
    expect(voucherImbalance(v)).toBe(0);
    const xml = tallyVouchersXml([v]);
    expect(xml).toContain('<TALLYREQUEST>Import Data</TALLYREQUEST>');
    expect(xml).toContain('<REPORTNAME>Vouchers</REPORTNAME>');
    expect(xml).toContain('<VOUCHER REMOTEID="hisaab-x-sale-1" VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View"><DATE>20261105</DATE>');
    expect(xml).toContain('<PARTYLEDGERNAME>Meena &amp; Co</PARTYLEDGERNAME>');
    expect(xml).toContain('<LEDGERENTRIES.LIST><LEDGERNAME>Meena &amp; Co</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><AMOUNT>-105.00</AMOUNT><BILLALLOCATIONS.LIST><NAME>INV-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-105.00</AMOUNT></BILLALLOCATIONS.LIST></LEDGERENTRIES.LIST>');
    expect(xml).toContain('<LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>No</ISPARTYLEDGER><AMOUNT>2.50</AMOUNT>');
    expect(xml).toContain('<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Sugar</STOCKITEMNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><RATE>50/Kg</RATE><AMOUNT>100.00</AMOUNT><ACTUALQTY> 2 Kg</ACTUALQTY><BILLEDQTY> 2 Kg</BILLEDQTY>');
    expect(xml).toContain('<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales @ 5%</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>');
  });
});
