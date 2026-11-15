import { describe, expect, it } from 'vitest';
import { detect, normalizeUnit, parseDate, parseMoney, parsePct, parseQty, toItems, toParties } from '../src/smartImport';
import { gstinCheckChar } from '../src/gst';

const G = (s: string) => s + gstinCheckChar(s);

describe('value parsing', () => {
  it('reads Indian money, Dr/Cr, quantities, GST and units', () => {
    expect(parseMoney('₹ 1,23,456.50')).toBe(12345650);
    expect(parseMoney('(120.00)')).toBe(-12000);
    expect(parseMoney('1,200.00 Dr')).toBe(120000);
    expect(parseMoney('1,200.00 Cr')).toBe(-120000);
    expect(parseMoney('Rs. 45')).toBe(4500);
    expect(parseMoney('-')).toBeNull();
    expect(parseQty('10 PCS')).toEqual({ qty: 10, unit: 'Pcs' });
    expect(parseQty('2.500 KGS')).toEqual({ qty: 2.5, unit: 'Kg' });
    expect(parseQty('12+2')).toEqual({ qty: 14, unit: null });
    expect(parsePct('18%')).toBe(18);
    expect(parsePct('Exempt')).toBe(0);
    expect(parsePct('0.05')).toBe(5);
    expect(['NOS', 'kgs', 'LTRS', 'Pkt', 'DOZ', 'ctn', 'gms'].map(normalizeUnit)).toEqual(['Pcs', 'Kg', 'Ltr', 'Pack', 'Dozen', 'Carton', 'g']);
  });
  it('reads the date styles ERPs export', () => {
    expect(parseDate('05/11/2026')).toBe('2026-11-05');
    expect(parseDate('5-11-26')).toBe('2026-11-05');
    expect(parseDate('12-Nov-2026')).toBe('2026-11-12');
    expect(parseDate('Nov-27')).toBe('2027-11-30'); // expiry month → last day
    expect(parseDate('02/28')).toBe('2028-02-29');
    expect(parseDate('46341')).toBe('2026-11-15'); // Excel serial
    expect(parseDate('hello')).toBeNull();
  });
});

describe('Marg-style exports', () => {
  it('stock statement: title rows, group headings, batches, totals', () => {
    const rows = [
      ['SHARMA GENERAL STORE'],
      ['Stock Statement as on 15/11/2026'],
      [],
      ['Item Name', 'Pack', 'Batch', 'Exp.', 'Qty', 'M.R.P.', 'P.Rate', 'S.Rate'],
      ['BEVERAGES'],
      ['Tata Tea Gold 250g', '1x1', 'TG11', '11/27', '24', '150.00', '118.50', '145.00'],
      ['Bru Instant 100g', '1x1', 'BR09', 'Mar-27', '10 PCS', '220.00', '170.00', '215.00'],
      ['PERSONAL CARE'],
      ['Lifebuoy 125g', '4x1', '', '', '36', '38.00', '30.00', '36.00'],
      ['Total', '', '', '', '70', '', '', ''],
    ];
    const d = detect(rows);
    expect(d.kind).toBe('items');
    expect(d.headerRow).toBe(3);
    expect(d.mapping).toMatchObject({ name: 0, batch: 2, expiry: 3, qty: 4, mrp: 5, cost: 6, rate: 7 });
    const { records, skipped } = toItems(d);
    expect(records.map((r) => [r.name, r.category, r.qty, r.mrp, r.cost, r.rate, r.batch, r.expiry])).toEqual([
      ['Tata Tea Gold 250g', 'BEVERAGES', 24, 15000, 11850, 14500, 'TG11', '2027-11-30'],
      ['Bru Instant 100g', 'BEVERAGES', 10, 22000, 17000, 21500, 'BR09', '2027-03-31'],
      ['Lifebuoy 125g', 'PERSONAL CARE', 36, 3800, 3000, 3600, undefined, undefined],
    ]);
    expect(skipped).toEqual([{ row: 10, reason: 'Total / heading line', text: 'Total' }]); // line 10 of the file
  });

  it('item master list with GST, HSN, company and barcode', () => {
    const d = detect([
      ['Product Name', 'Company', 'HSN Code', 'GST %', 'Unit', 'MRP', 'Sale Rate', 'Purchase Rate', 'Barcode'],
      ['Fortune Oil 1L', 'Adani Wilmar', '1512', '5%', 'NOS', '185', '178', '160', '8906007280034'],
      ['Sugar Loose', '', '1701', '5', 'KGS', '0', '46', '40', ''],
    ]);
    expect(d.kind).toBe('items');
    const { records } = toItems(d);
    expect(records[0]).toMatchObject({ name: 'Fortune Oil 1L', brand: 'Adani Wilmar', hsn: '1512', gst: 5, unit: 'Pcs', mrp: 18500, rate: 17800, cost: 16000, barcode: '8906007280034' });
    expect(records[1]).toMatchObject({ unit: 'Kg', rate: 4600, mrp: 0 });
  });

  it('party outstanding with Sundry Debtors / Creditors groups and Dr/Cr', () => {
    const gst = G('27AAKFM4821K1Z');
    const d = detect([
      ['Outstanding Report'],
      ['Party Name', 'Station', 'Mobile No.', 'GSTIN', 'Balance', 'Dr/Cr'],
      ['SUNDRY DEBTORS'],
      ['Meena Aunty', 'Pune', '+91 98220 12345', '', '1,250.00', 'Dr'],
      ['Hotel Annapurna', 'Pune', '9822000001', gst, '8,400.00', 'Dr'],
      ['SUNDRY CREDITORS'],
      ['Mahalaxmi Distributors', 'Pune', '9822012345', 'NA', '45,000.00', 'Cr'],
      ['Grand Total', '', '', '', '', ''],
    ]);
    expect(d.kind).toBe('parties');
    const { records, skipped } = toParties(d);
    expect(records.map((r) => [r.name, r.kind, r.phone ?? null, r.gstin ?? null, r.balance, r.city, r.stateCode ?? null])).toEqual([
      ['Meena Aunty', 'customer', '9822012345', null, 125000, 'Pune', null],
      ['Hotel Annapurna', 'customer', '9822000001', gst, 840000, 'Pune', '27'],
      ['Mahalaxmi Distributors', 'supplier', '9822012345', null, -4500000, 'Pune', null],
    ]);
    expect(skipped).toHaveLength(1);
  });
});

describe('Tally / Busy / hand-made sheets', () => {
  it('ledger list with Debit and Credit columns and an "Under" group', () => {
    const d = detect([
      ['Particulars', 'Under', 'Debit', 'Credit'],
      ['Ganesh Traders', 'Sundry Debtors', '5,000.00', ''],
      ['Om Sai FMCG', 'Sundry Creditors', '', '12,000.00'],
    ]);
    const { records } = toParties(d);
    expect(records.map((r) => [r.name, r.kind, r.balance])).toEqual([['Ganesh Traders', 'customer', 500000], ['Om Sai FMCG', 'supplier', -1200000]]);
  });
  it('two-line headers and unlabeled columns recognised from their values', () => {
    const d = detect([
      ['Item', 'Sale', 'Purchase', ''],
      ['', 'Rate', 'Rate', 'Tax'],
      ['Basmati Rice 5kg', '520', '450', '5'],
      ['Toor Dal 1kg', '165', '140', '5'],
    ]);
    expect(d.mapping).toMatchObject({ name: 0, rate: 1, cost: 2, gst: 3 });
    const p = detect([
      ['Name', 'Col2', 'Col3'],
      ['Gupta Kirana', G('27BQZPG5512H1Z'), '9876501234'],
      ['City Super Mart', G('27AAJCC2219Q1Z'), '9665301234'],
    ]);
    expect(p.kind).toBe('parties');
    expect(p.mapping).toMatchObject({ name: 0, gstin: 1, phone: 2 });
    expect(p.confidence.gstin).toBe('guess');
  });
});
