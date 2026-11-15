import { describe, expect, it } from 'vitest';
import { drawerKick, EscPos, receipt, zplLabel } from '../src/escpos';

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
