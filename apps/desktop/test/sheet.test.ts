import { describe, expect, it } from 'vitest';
import { guessColumns, parseCsv, toIsoDate, toPaiseLoose } from '../src/lib/sheet';

describe('spreadsheet import helpers', () => {
  it('parses quoted CSV and finds the header row', () => {
    const rows = parseCsv('Distributor Invoice 42\r\nItem Name,Qty,"Rate (₹)",HSN\r\n"Tata Salt, 1kg",10,"1,234.50",2501\r\nSugar,2,45,1701\r\n');
    expect(rows[2]).toEqual(['Tata Salt, 1kg', '10', '1,234.50', '2501']);
    const g = guessColumns(rows, { name: /item|product|desc/, qty: /qty|quantity/, rate: /rate|price/, hsn: /hsn/ });
    expect(g).toEqual({ header: 1, cols: { name: 0, qty: 1, rate: 2, hsn: 3 } });
    expect(parseCsv('a;b;c\n1;2;3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });
  it('reads amounts and dates the way Indian bank statements write them', () => {
    expect(toPaiseLoose('1,234.50')).toBe(123450);
    expect(toPaiseLoose('(120.00)')).toBe(-12000);
    expect(toPaiseLoose('')).toBeUndefined();
    expect(toIsoDate('05/11/2026')).toBe('2026-11-05');
    expect(toIsoDate('5-11-26')).toBe('2026-11-05');
    expect(toIsoDate('2026-11-05 10:00')).toBe('2026-11-05');
  });
});
