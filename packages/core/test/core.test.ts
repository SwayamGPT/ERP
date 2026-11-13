import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/gst-lines.json';
import {
  allocateFifo,
  amountInWords,
  applyScheme,
  buildEwayBill,
  buildGstr1,
  buildGstr3b,
  buildWeightBarcode,
  can,
  computeLine,
  describeQty,
  ean13CheckDigit,
  ean13Modules,
  expiryBucket,
  formatINR,
  gstinCheckChar,
  isValidEan13,
  numberToIndianWords,
  parseWeightBarcode,
  priceForUnit,
  resolvePrice,
  roundHalfUp,
  roundOffFor,
  searchHsn,
  sumLines,
  taxSummary,
  toCsv,
  toPaise,
  toBaseQty,
  validateGstin,
  validateEnterprise,
  panFromGstin,
  isPhone,
  weightedCost,
  type GstDoc,
} from '../src';

describe('money', () => {
  it('parses rupee strings to exact paise', () => {
    expect(toPaise('1,234.56')).toBe(123456);
    expect(toPaise('₹ 12')).toBe(1200);
    expect(toPaise('0.105')).toBe(11);
    expect(toPaise('1.005')).toBe(101);
    expect(toPaise(19.99)).toBe(1999);
    expect(toPaise('-5.5')).toBe(-550);
    expect(toPaise('')).toBe(0);
    expect(Number.isNaN(toPaise('abc'))).toBe(true);
  });

  it('rounds half-up symmetrically', () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(-2.5)).toBe(-3);
    expect(roundHalfUp(1.005 * 100)).toBe(101);
    expect(roundHalfUp(2.4999)).toBe(2);
  });

  it('formats in the Indian system', () => {
    expect(formatINR(12345600)).toBe('₹1,23,456.00');
    expect(formatINR(-5050)).toBe('−₹50.50');
    expect(formatINR(1000000000, { decimals: false })).toBe('₹1,00,00,000');
  });

  it('writes amounts in Indian words', () => {
    expect(numberToIndianWords(12345678)).toBe('One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight');
    expect(numberToIndianWords(100000)).toBe('One Lakh');
    expect(amountInWords(12345650)).toBe('Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Fifty Paise Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
  });
});

describe('gst line math — golden fixtures', () => {
  for (const c of fixtures.cases) {
    it(c.name, () => {
      const r = computeLine(c.in);
      expect({ taxable: r.taxable, cgst: r.cgst, sgst: r.sgst, igst: r.igst, cess: r.cess, total: r.total }).toEqual(c.out);
    });
  }
});

describe('gst invariants', () => {
  it('every line reconciles to the paisa and inclusive totals equal sticker price', () => {
    for (const rate of [0, 0.25, 3, 5, 12, 18, 28, 40]) {
      for (let price = 1; price < 2500; price += 37) {
        for (const qty of [1, 0.25, 1.5, 7, 0.333]) {
          for (const interState of [false, true]) {
            const inc = computeLine({ qty, rate: price, gstRate: rate, taxInclusive: true, interState, discountPct: 3 });
            expect(inc.taxable + inc.cgst + inc.sgst + inc.igst + inc.cess).toBe(inc.total);
            expect(inc.total).toBe(inc.gross - inc.discount);
            expect(inc.cgst).toBe(inc.sgst);
            const exc = computeLine({ qty, rate: price, gstRate: rate, taxInclusive: false, interState });
            expect(exc.taxable + exc.tax).toBe(exc.total);
            for (const v of Object.values(inc)) expect(Number.isInteger(v)).toBe(true);
          }
        }
      }
    }
  });

  it('round-off brings bills to a whole rupee and is half-up', () => {
    expect(roundOffFor(10049)).toBe(-49);
    expect(roundOffFor(10050)).toBe(50);
    expect(roundOffFor(10000)).toBe(0);
    expect(roundOffFor(12345, false)).toBe(0);
    const lines = [
      computeLine({ qty: 1, rate: 1999, gstRate: 5, taxInclusive: false, interState: false }),
      computeLine({ qty: 3, rate: 1250, gstRate: 18, taxInclusive: false, interState: false }),
    ];
    const t = sumLines(lines);
    expect(t.grand).toBe(lines[0].total + lines[1].total);
    expect(t.payable % 100).toBe(0);
    expect(t.grand + t.roundOff).toBe(t.payable);
  });

  it('flat discount never exceeds gross', () => {
    const r = computeLine({ qty: 1, rate: 500, gstRate: 5, taxInclusive: true, interState: false, discountAmt: 900 });
    expect(r.total).toBe(0);
  });

  it('summarises tax by HSN and by rate', () => {
    const a = { ...computeLine({ qty: 1, rate: 10000, gstRate: 5, taxInclusive: false, interState: false }), hsn: '1006', gstRate: 5, qty: 1 };
    const b = { ...computeLine({ qty: 2, rate: 10000, gstRate: 5, taxInclusive: false, interState: false }), hsn: '1006', gstRate: 5, qty: 2 };
    const c = { ...computeLine({ qty: 1, rate: 10000, gstRate: 18, taxInclusive: false, interState: false }), hsn: '3402', gstRate: 18, qty: 1 };
    const byHsn = taxSummary([a, b, c], 'hsn');
    expect(byHsn).toHaveLength(2);
    expect(byHsn[0]).toMatchObject({ hsn: '1006', qty: 3, taxable: 30000, cgst: 750, sgst: 750 });
    expect(taxSummary([a, b, c], 'rate').map((r) => r.rate)).toEqual([5, 18]);
  });

  it('validates GSTIN check characters', () => {
    const base = '27AAPFU0939F1Z';
    const gstin = base + gstinCheckChar(base);
    expect(validateGstin(gstin)).toBe(true);
    expect(validateGstin('27AAPFU0939F1ZX'.replace(/.$/, gstin[14] === 'X' ? 'Y' : 'X'))).toBe(false);
    expect(validateGstin('bad')).toBe(false);
  });
});

describe('units, pricing and schemes', () => {
  it('converts units to base and prices per unit', () => {
    expect(toBaseQty(2, 12)).toBe(24);
    expect(toBaseQty(0.75, 1)).toBe(0.75);
    expect(priceForUnit(1000, { factor: 12 })).toBe(12000);
    expect(priceForUnit(1000, { factor: 12, price: 11500 })).toBe(11500);
    expect(describeQty(145, 'Pcs', [{ name: 'Carton', factor: 48 }, { name: 'Box', factor: 12 }])).toBe('3 Carton 1 Pcs');
  });

  it('resolves tier prices with fallback', () => {
    const p = { mrp: 5000, retail: 4800, wholesale: 4500, super: null };
    expect(resolvePrice(p, 'wholesale').price).toBe(4500);
    expect(resolvePrice(p, 'super')).toEqual({ price: 4500, tier: 'wholesale' });
    expect(resolvePrice({ mrp: 5000, retail: 0 }, 'retail')).toEqual({ price: 5000, tier: 'mrp' });
  });

  it('applies buy-x-get-y and slab schemes', () => {
    expect(applyScheme({ type: 'bxgy', buy: 10, free: 1 }, 25).freeQty).toBe(2);
    expect(applyScheme({ type: 'bxgy', buy: 10, free: 1 }, 9).freeQty).toBe(0);
    const slab = { type: 'slab' as const, slabs: [{ minQty: 10, discountPct: 2 }, { minQty: 50, discountPct: 5 }] };
    expect(applyScheme(slab, 60).discountPct).toBe(5);
    expect(applyScheme(slab, 12).discountPct).toBe(2);
    expect(applyScheme(slab, 5).discountPct).toBe(0);
  });
});

describe('FIFO batches', () => {
  const batches = [
    { id: 1, qty: 10, expiry: '2027-03-01', receivedAt: '2026-09-01', cost: 100 },
    { id: 2, qty: 5, expiry: '2026-12-01', receivedAt: '2026-10-01', cost: 110 },
    { id: 3, qty: 8, expiry: null, receivedAt: '2026-08-01', cost: 90 },
  ];
  it('takes earliest expiry first, no-expiry last', () => {
    const r = allocateFifo(batches, 12);
    expect(r.allocations).toEqual([
      { batchId: 2, qty: 5, cost: 110 },
      { batchId: 1, qty: 7, cost: 100 },
    ]);
    expect(r.shortfall).toBe(0);
  });
  it('honours a preferred batch and reports shortfall', () => {
    const r = allocateFifo(batches, 30, { preferBatchId: 3 });
    expect(r.allocations[0].batchId).toBe(3);
    expect(r.shortfall).toBe(7);
  });
  it('handles fractional loose quantities', () => {
    const r = allocateFifo([{ id: 9, qty: 1.2, expiry: null, receivedAt: '2026-01-01', cost: 5000 }], 0.75);
    expect(r.allocations[0].qty).toBe(0.75);
  });
  it('buckets expiry dates', () => {
    expect(expiryBucket('2026-11-01', '2026-11-13')).toBe('expired');
    expect(expiryBucket('2026-12-01', '2026-11-13')).toBe('d30');
    expect(expiryBucket('2027-01-20', '2026-11-13')).toBe('d90');
    expect(expiryBucket('2027-06-01', '2026-11-13')).toBe('ok');
    expect(expiryBucket(null, '2026-11-13')).toBe('none');
  });
  it('computes weighted cost', () => {
    expect(weightedCost(batches)).toBe(Math.round((10 * 100 + 5 * 110 + 8 * 90) / 23));
  });
});

describe('barcodes', () => {
  it('computes EAN-13 check digits', () => {
    expect(ean13CheckDigit('400638133393')).toBe(1);
    expect(isValidEan13('4006381333931')).toBe(true);
    expect(isValidEan13('4006381333932')).toBe(false);
  });
  it('round-trips weight-embedded barcodes', () => {
    const code = buildWeightBarcode('00042', 750);
    expect(code).toMatch(/^2100042007\d{2}\d$/);
    expect(parseWeightBarcode(code, 'weight')).toEqual({ prefix: '21', plu: '00042', value: 750, mode: 'weight' });
    expect(parseWeightBarcode('4006381333931', 'weight')).toBeNull();
  });
  it('renders 95 modules', () => {
    expect(ean13Modules('4006381333931')).toHaveLength(95);
  });
});

describe('GST returns', () => {
  const line = (over: Partial<GstDoc['lines'][number]> = {}) => ({
    hsn: '1006', description: 'Rice', uqc: 'KGS', qty: 10, gstRate: 5, taxable: 100000, cgst: 2500, sgst: 2500, igst: 0, cess: 0, ...over,
  });
  const docs: GstDoc[] = [
    { type: 'sale', number: 'INV-1', date: '2026-10-03', partyGstin: '27AAPFU0939F1ZV', partyName: 'Shree Traders', placeOfSupply: '27', interState: false, total: 105000, lines: [line()] },
    { type: 'sale', number: 'INV-2', date: '2026-10-04', partyGstin: null, partyName: 'Walk-in', placeOfSupply: '27', interState: false, total: 105000, lines: [line()] },
    { type: 'sale', number: 'INV-3', date: '2026-10-05', partyGstin: null, partyName: 'Delhi buyer', placeOfSupply: '07', interState: true, total: 15000000, lines: [line({ taxable: 14285714, cgst: 0, sgst: 0, igst: 714286 })] },
    { type: 'sale_return', number: 'CN-1', date: '2026-10-06', partyGstin: null, partyName: 'Walk-in', placeOfSupply: '27', interState: false, total: 10500, lines: [line({ qty: 1, taxable: 10000, cgst: 250, sgst: 250 })] },
    { type: 'purchase', number: 'P-9', date: '2026-10-02', partyGstin: '27AAACR5055K1Z5', partyName: 'Supplier', placeOfSupply: '27', interState: false, total: 84000, lines: [line({ taxable: 80000, cgst: 2000, sgst: 2000 })] },
  ];

  it('builds GSTR-1 sections', () => {
    const g = buildGstr1({ gstin: '27ABCDE1234F1Z5', period: '2026-10', docs }) as any;
    expect(g.fp).toBe('102026');
    expect(g.b2b[0].ctin).toBe('27AAPFU0939F1ZV');
    expect(g.b2b[0].inv[0]).toMatchObject({ inum: 'INV-1', idt: '03-10-2026', val: 1050, pos: '27' });
    expect(g.b2b[0].inv[0].itms[0].itm_det).toEqual({ txval: 1000, rt: 5, iamt: 0, camt: 25, samt: 25, csamt: 0 });
    expect(g.b2cl[0].pos).toBe('07');
    expect(g.b2cs).toEqual([{ sply_ty: 'INTRA', pos: '27', typ: 'OE', rt: 5, txval: 900, iamt: 0, camt: 22.5, samt: 22.5, csamt: 0 }]);
    expect(g.hsn.hsn_b2b[0]).toMatchObject({ hsn_sc: '1006', qty: 10, txval: 1000 });
    expect(g.hsn.hsn_b2c[0].qty).toBe(19);
    expect(g.doc_issue.doc_det[0].docs[0]).toMatchObject({ from: 'INV-1', to: 'INV-3', totnum: 3 });
  });

  it('builds GSTR-3B with ITC', () => {
    const g = buildGstr3b({ gstin: '27ABCDE1234F1Z5', period: '2026-10', docs });
    expect(g.sup_details.osup_det.camt).toBe(25 + 25 - 2.5);
    expect(g.sup_details.osup_det.iamt).toBe(7142.86);
    expect(g.inter_sup.unreg_details).toEqual([{ pos: '07', txval: 142857.14, iamt: 7142.86 }]);
    expect(g.itc_elg.itc_net).toEqual({ iamt: 0, camt: 20, samt: 20, csamt: 0 });
  });

  it('builds e-way bill JSON', () => {
    const e = buildEwayBill({
      doc: docs[2],
      from: { gstin: '27ABCDE1234F1Z5', name: 'Me', address: 'Shop 1', place: 'Pune', pincode: '411001', stateCode: '27' },
      to: { gstin: null, name: 'Delhi buyer', address: 'X', place: 'Delhi', pincode: '110001', stateCode: '07' },
      transport: { mode: 1, distanceKm: 1450, vehicleNo: 'mh 12 ab 1234' },
    });
    expect(e.billLists[0]).toMatchObject({ docNo: 'INV-3', docDate: '05/10/2026', toGstin: 'URP', vehicleNo: 'MH12AB1234', igstValue: 7142.86 });
    expect(e.billLists[0].itemList[0].igstRate).toBe(5);
  });
});

describe('misc', () => {
  it('finds HSN codes', () => {
    expect(searchHsn('rice')[0].code).toBe('1006');
    expect(searchHsn('3402')[0].description).toMatch(/Detergent/);
  });
  it('enforces roles', () => {
    expect(can('cashier', 'sale.create')).toBe(true);
    expect(can('cashier', 'cost.view')).toBe(false);
    expect(can('manager', 'report.profit')).toBe(true);
    expect(can('manager', 'users.manage')).toBe(false);
    expect(can('owner', 'users.manage')).toBe(true);
  });
  it('writes CSV safely', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"' }])).toBe('﻿a,b\r\n"x,y","say ""hi"""');
  });
});

describe('enterprise validation', () => {
  const first = '27AAPFU0939F1Z';
  const good = {
    name: 'Sharma Store', businessType: 'kirana', gstin: first + gstinCheckChar(first), fssai: '11523999000123', phone: '98220 12345',
    email: 'shop@example.in', address: 'Shop 4, Market Yard', city: 'Pune', pincode: '411037', stateCode: '27',
  };
  it('accepts complete details', () => {
    expect(validateEnterprise(good)).toEqual({});
    expect(panFromGstin(good.gstin)).toBe('AAPFU0939F');
    expect(isPhone('+91 9822012345')).toBe(true);
    expect(isPhone('02024567890')).toBe(true);
  });
  it('flags every missing or malformed mandatory field', () => {
    const e = validateEnterprise({ ...good, gstin: '27AAPFU0939F1ZZ', fssai: '12345', phone: '12345', email: 'x@', pincode: '011001', bankIfsc: 'HDFC1234' });
    expect(Object.keys(e).sort()).toEqual(['bankIfsc', 'email', 'fssai', 'gstin', 'phone', 'pincode']);
    expect(Object.keys(validateEnterprise({})).length).toBeGreaterThanOrEqual(9);
  });
});
