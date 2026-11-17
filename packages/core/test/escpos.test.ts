import { describe, expect, it } from 'vitest';
import { drawerKick, EscPos, profileById, receipt, testPage, wrapWords, zplLabel } from '../src/escpos';
import { cleanScan, ScanDetector } from '../src/barcode';

const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const has = (b: Uint8Array, seq: number[]) => text(b).includes(String.fromCharCode(...seq));

describe('ESC/POS receipts', () => {
  const r = receipt(
    {
      shop: { name: 'Sharma General Store', address: 'Market Yard, Pune', phone: '9822012345', gstin: '27AAPFU0939F1ZV', footer: 'Thank you!' },
      number: 'INV-B-12', date: '15-11-2026', time: '10:42:00', party: 'Meena Aunty',
      lines: [{ name: 'Fortune Sunflower Oil 1L Pouch', qty: 2, unit: 'Pcs', rate: 14500, total: 29000 }, { name: 'Sugar', qty: 1.5, unit: 'Kg', rate: 4600, total: 6900 }],
      taxable: 34190, cgst: 855, sgst: 855, igst: 0, cess: 0, roundOff: 0, total: 35900, paid: 20000, mode: 'cash', upi: 'sharma@upi',
    },
    { cols: 48, drawer: true },
  );

  it('starts with init, ends with cut and drawer kick', () => {
    expect([...r.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect(has(r, [0x1d, 0x56, 0x42, 0x00])).toBe(true);
    expect([...r.slice(-5)]).toEqual([0x1b, 0x70, 0x00, 0x19, 0xfa]);
  });

  it('lays out items, taxes, totals and balance in 48 columns', () => {
    const lines = text(r).split('\n').map((l) => l.replace(/[\x00-\x1f]|\x1b.|\x1d../g, ''));
    expect(lines.some((l) => l.includes('Bill: INV-B-12') && l.includes('15-11-2026 10:42'))).toBe(true);
    expect(text(r)).toContain('Fortune Sunflower Oil');
    expect(text(r)).toContain('290.00');
    expect(text(r)).toContain('CGST');
    expect(text(r)).toContain('Rs.359.00');
    expect(text(r)).toContain('Balance due');
    expect(text(r)).toContain('upi://pay?pa=sharma%40upi');
    expect(text(r)).not.toContain('₹');
  });

  it('wraps long names, right-aligns numbers, and fits 58 mm paper', () => {
    const p = new EscPos(32);
    p.row(['A very long item name that wraps', '2', '', '100.00'], [14, -5, 0, -13]);
    const out = text(p.bytes()).slice(2).split('\n');
    expect(out[0]).toHaveLength(32);
    expect(out[0].endsWith('100.00')).toBe(true);
    expect(out[1].startsWith('  ')).toBe(true);
    const narrow = receipt({ shop: { name: 'S' }, number: '1', date: 'd', lines: [{ name: 'x', qty: 1, unit: 'Pcs', rate: 100, total: 100 }], taxable: 100, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total: 100, paid: 100, mode: 'cash' }, { cols: 32 });
    for (const l of text(narrow).split('\n')) expect(l.replace(/\x1b.|\x1d.{2}|[\x00-\x1f]/g, '').length).toBeLessThanOrEqual(32);
  });

  it('drawer kick and ZPL labels', () => {
    expect([...drawerKick()]).toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
    const z = zplLabel({ name: 'Tata Salt 1kg', barcode: '8901234567897', mrp: '28.00', price: '26.00', copies: 3 });
    expect(z.startsWith('^XA')).toBe(true);
    expect(z).toContain('^BEN,70,Y,N^FD890123456789^FS');
    expect(z).toContain('^PQ3');
  });
});

describe('printer profiles', () => {
  const r = { shop: { name: 'Shop' }, number: 'B-1', date: '01-04-2026', lines: [{ name: 'Tea', qty: 1, unit: 'Pcs', rate: 1000, total: 1000 }], taxable: 1000, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total: 1000, paid: 0, mode: 'credit', upi: 'shop@upi' };
  it('uses each profile\'s cut and drawer bytes', () => {
    expect(has(receipt(r, { profile: profileById('cheap-80') }), [0x1d, 0x56, 0x00])).toBe(true);
    expect(has(receipt(r, { profile: profileById('epson-tm') }), [0x1d, 0x56, 0x42, 0x00])).toBe(true);
    expect(has(receipt(r, { profile: { ...profileById('generic-80'), cut: 'esc-i' } }), [0x1b, 0x69])).toBe(true);
    const noCut = receipt(r, { profile: profileById('cheap-58') });
    expect(has(noCut, [0x1d, 0x56])).toBe(false);
    expect(has(receipt(r, { profile: { ...profileById('generic-80'), drawerPin: 1 }, drawer: true }), [0x1b, 0x70, 0x01])).toBe(true);
  });

  it('leaves out the QR code on printers that cannot draw one', () => {
    expect(has(receipt(r, { profile: profileById('generic-80') }), [0x1d, 0x28, 0x6b])).toBe(true);
    const plain = receipt(r, { profile: profileById('cheap-80') });
    expect(has(plain, [0x1d, 0x28, 0x6b])).toBe(false);
    expect(new TextDecoder().decode(plain)).toContain('Pay by UPI: shop@upi');
  });

  it('fits 42-column paper', () => {
    const lines = text(receipt(r, { profile: profileById('font-b-80') })).split('\n');
    const taxable = lines.find((l) => l.includes('Taxable value'))!;
    expect(taxable.length).toBe(42);
    expect(lines.find((l) => l.includes('Tea'))!.replace(/^.*[\x00-\x1f]/, '').length).toBe(42);
  });

  it('prints a test page with ruler and cut', () => {
    const t = testPage(profileById('tvs-retsol'), { drawer: true });
    const s = new TextDecoder().decode(t);
    expect(s).toContain('123456789012345678901234567890123456789012345678');
    expect(has(t, [0x1d, 0x56, 0x00])).toBe(true);
    expect(has(t, [0x1b, 0x70, 0x00])).toBe(true);
    expect(new TextDecoder().decode(testPage(profileById('cheap-58')))).toContain('Tear here');
  });
});

describe('barcode scanners', () => {
  it('cleans what scanners type', () => {
    expect(cleanScan(' 8901234567890 ')).toBe('8901234567890');
    expect(cleanScan(']E08901234567890')).toBe('8901234567890');
    expect(cleanScan('\x028901234567890\x03')).toBe('8901234567890');
    expect(cleanScan('*(!)@#$%^&*(!')).toBe('8910234567891');
    expect(cleanScan('ç(&à"é')).toBe('951032');
    expect(cleanScan('ABC-123')).toBe('ABC-123');
  });

  it('tells a scanner from a person typing', () => {
    const d = new ScanDetector();
    let t = 0;
    let out: string | null = null;
    for (const k of '8901234567890') out = d.key(k, (t += 5));
    expect(out).toBeNull();
    expect(d.key('Enter', (t += 5))).toBe('8901234567890');
    // A person: 150 ms between keys
    for (const k of '1234') d.key(k, (t += 150));
    expect(d.key('Enter', (t += 150))).toBeNull();
    // Tab suffix works too
    for (const k of 'ABCD1') d.key(k, (t += 4));
    expect(d.key('Tab', (t += 4))).toBe('ABCD1');
  });
});

describe('long shop names', () => {
  it('wrap instead of being cut', () => {
    expect(wrapWords('M/S SIDDHI VINAYAK ENTERPROSE', 24)).toEqual(['M/S SIDDHI VINAYAK', 'ENTERPROSE']);
    expect(wrapWords('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10)).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ']);
    const r = { shop: { name: 'M/S SIDDHI VINAYAK ENTERPROSE' }, number: 'INV-2', date: '17-11-2026', lines: [], taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, roundOff: 0, total: 0, paid: 0, mode: 'cash' };
    const text = new TextDecoder('latin1').decode(receipt(r, { profile: profileById('generic-80') }));
    expect(text).toContain('M/S SIDDHI VINAYAK\n');
    expect(text).toContain('ENTERPROSE\n');
    expect(new TextDecoder('latin1').decode(receipt(r, { profile: profileById('cheap-58') }))).toContain('M/S SIDDHI VINAYAK ENTERPROSE');
  });
});
