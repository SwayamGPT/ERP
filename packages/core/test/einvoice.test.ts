import { describe, expect, it } from 'vitest';
import { buildEinvoice, einvoiceProblems, irnFor, normDocNo, parseGstr2b, parseIrpResponse, reconcile2b, sha256Hex, type EinvDoc } from '../src';

const seller = { gstin: '27AAPFU0939F1ZV', legalName: 'Sharma General Store', address: 'Shop 4, Market Yard', place: 'Pune', pincode: '411037', stateCode: '27' };
const buyer = { gstin: '27AAKFM4821K1Z5', legalName: 'Hotel Annapurna', address: 'FC Road', place: 'Pune', pincode: '411004', stateCode: '27' };
const doc: EinvDoc = {
  type: 'INV', number: 'INV-102', date: '2026-11-13', seller, buyer, placeOfSupply: '27', interState: false, otherCharges: 0, roundOff: -20, total: 112980,
  lines: [{ description: 'Basmati Rice 25kg', hsn: '1006', qty: 2, uqc: 'BAG', unitPrice: 53800, gross: 107600, discount: 0, taxable: 107600, gstRate: 5, cgst: 2690, sgst: 2690, igst: 0, cess: 0, cessRate: 0, total: 112980 }],
};

describe('e-invoice', () => {
  it('builds the IRP schema 1.1 with rupee amounts and dd/mm/yyyy dates', () => {
    const j = buildEinvoice(doc);
    expect(j.Version).toBe('1.1');
    expect(j.DocDtls).toEqual({ Typ: 'INV', No: 'INV-102', Dt: '13/11/2026' });
    expect(j.BuyerDtls).toMatchObject({ Gstin: buyer.gstin, Pos: '27', Pin: 411004, Stcd: '27' });
    expect(j.ItemList[0]).toMatchObject({ SlNo: '1', HsnCd: '1006', Qty: 2, Unit: 'BAG', UnitPrice: 538, AssAmt: 1076, CgstAmt: 26.9, SgstAmt: 26.9, TotItemVal: 1129.8 });
    expect(j.ValDtls).toMatchObject({ AssVal: 1076, CgstVal: 26.9, SgstVal: 26.9, IgstVal: 0, RndOffAmt: -0.2, TotInvVal: 1129.8 });
    expect(einvoiceProblems(doc)).toEqual([]);
  });
  it('explains what blocks an e-invoice', () => {
    const bad = { ...doc, number: 'INVOICE/2026-27/000123', buyer: { ...buyer, gstin: '', pincode: '' }, lines: [{ ...doc.lines[0], hsn: '10' }] };
    expect(einvoiceProblems(bad)).toEqual([
      'e-Invoices are for registered (B2B) customers: the customer GSTIN is missing.',
      'Bill number “INVOICE/2026-27/000123” must be at most 16 letters, digits, / or -.',
      "The customer's PIN code is missing.",
      'Line 1 (Basmati Rice 25kg): HSN code must be 4–8 digits.',
    ]);
  });
  it('computes the IRN the way the IRP does (SHA-256 of GSTIN + FY + type + number)', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(irnFor(seller.gstin, 'INV', 'INV-102', '2026-11-13')).toBe(sha256Hex(`${seller.gstin}2026-27INVINV-102`));
    expect(irnFor(seller.gstin, 'INV', 'X', '2027-02-01')).toBe(sha256Hex(`${seller.gstin}2026-27INVX`));
  });
  it('reads the portal response file', () => {
    const r = parseIrpResponse([{ DocNo: 'INV-102', Irn: 'abc123', AckNo: 112010036563310, AckDt: '2026-11-13 11:05:00', SignedQRCode: 'eyJhbGciOi...' }, { error: 'x' }]);
    expect(r).toEqual([{ docNo: 'INV-102', irn: 'abc123', ackNo: '112010036563310', ackDate: '2026-11-13 11:05:00', signedQr: 'eyJhbGciOi...', ewbNo: null }]);
  });
});

describe('GSTR-2B', () => {
  const twoB = {
    data: {
      gstin: seller.gstin, rtnprd: '102026',
      docdata: {
        b2b: [
          { ctin: '27AAKFM4821K1Z5', trdnm: 'Mahalaxmi Distributors', inv: [
            { inum: 'MD/2291', dt: '05-10-2026', val: 10500, itcavl: 'Y', items: [{ txval: 10000, cgst: 250, sgst: 250 }] },
            { inum: 'MD/2302', dt: '18-10-2026', val: 2100, itcavl: 'Y', items: [{ txval: 2000, cgst: 50, sgst: 50 }] },
            { inum: 'MD/2310', dt: '25-10-2026', val: 1180, itcavl: 'Y', items: [{ txval: 1000, cgst: 90, sgst: 90 }] },
          ] },
        ],
        cdnr: [{ ctin: '27AAKFM4821K1Z5', trdnm: 'Mahalaxmi Distributors', nt: [{ ntnum: 'CN-7', typ: 'C', dt: '20-10-2026', val: 525, items: [{ txval: 500, cgst: 12.5, sgst: 12.5 }] }] }],
      },
    },
  };
  it('parses invoices and credit notes in paise', () => {
    const p = parseGstr2b(twoB);
    expect(p.period).toBe('2026-10');
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0]).toMatchObject({ kind: 'inv', docNo: 'MD/2291', date: '2026-10-05', value: 1050000, taxable: 1000000, cgst: 25000, sgst: 25000 });
    expect(p.rows[3]).toMatchObject({ kind: 'cn', cgst: 1250 });
    expect(() => parseGstr2b({ hello: 1 })).toThrow(/not a GSTR-2B/);
  });
  it('reconciles with purchase bills', () => {
    const { rows } = parseGstr2b(twoB);
    const books = [
      { source: 'purchase' as const, id: 1, gstin: '27AAKFM4821K1Z5', docNo: 'md-2291', date: '2026-10-05', value: 1050000, tax: 50000 },
      { source: 'purchase' as const, id: 2, gstin: '27AAKFM4821K1Z5', docNo: 'MD/2302', date: '2026-10-18', value: 210000, tax: 8000 },
      { source: 'expense' as const, id: 9, gstin: '27AAACR5055K1Z7', docNo: 'R-11', date: '2026-10-01', value: 590000, tax: 90000 },
    ];
    const r = reconcile2b(rows, books);
    expect(r.map((x) => [x.status, x.twoB?.docNo ?? x.book?.docNo, x.diff])).toEqual([
      ['matched', 'MD/2291', 0],
      ['mismatch', 'MD/2302', 2000],
      ['missing_in_books', 'MD/2310', 18000],
      ['missing_in_2b', 'R-11', -90000],
    ]);
    expect(normDocNo('MD 02291')).toBe('MD2291');
  });
});
