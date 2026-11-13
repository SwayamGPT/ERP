import { type Paise, roundHalfUp } from './money';

/**
 * GST rates in force (GST 2.0 rationalisation, effective 22 Sep 2025): 0, 5, 18, 40.
 * 0.25 (rough diamonds) and 3 (gold/silver) are special. 12 and 28 are kept for back-dated
 * documents and items that were not migrated.
 */
export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40] as const;
export const CURRENT_GST_SLABS = [0, 5, 18, 40] as const;

/** Rate → basis points (5% → 500, 0.25% → 25). */
export const bp = (pct: number) => Math.round(pct * 100);

export interface LineInput {
  /** Quantity in the selected unit. Up to 3 decimals (e.g. 0.750 kg). */
  qty: number;
  /** Price per selected unit in paise. Tax-inclusive or exclusive per `taxInclusive`. */
  rate: Paise;
  /** Line discount percent (applied before tax). */
  discountPct?: number;
  /** Flat line discount in paise (applied before tax, after % discount). */
  discountAmt?: Paise;
  gstRate: number;
  cessRate?: number;
  taxInclusive: boolean;
  interState: boolean;
}

export interface LineTax {
  gross: Paise; // qty × rate
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  tax: Paise;
  total: Paise; // taxable + all taxes — what the customer pays for this line
}

/** qty × rate computed on integer milli-units to avoid float drift. */
export function lineGross(qty: number, rate: Paise): Paise {
  const milli = Math.round(qty * 1000);
  return roundHalfUp((milli * rate) / 1000);
}

function taxesOn(taxable: Paise, gstBp: number, cessBp: number, interState: boolean) {
  const cess = roundHalfUp((taxable * cessBp) / 10000);
  if (interState) {
    const igst = roundHalfUp((taxable * gstBp) / 10000);
    return { cgst: 0, sgst: 0, igst, cess };
  }
  // CGST and SGST are each half the rate, rounded independently so both halves are equal.
  const half = roundHalfUp((taxable * gstBp) / 20000);
  return { cgst: half, sgst: half, igst: 0, cess };
}

/**
 * Compute one invoice line. All rounding happens here, per line, half-up.
 * Invariant: taxable + cgst + sgst + igst + cess === total, exactly.
 * For tax-inclusive prices, total === gross − discount exactly (the customer pays the sticker price).
 */
export function computeLine(input: LineInput): LineTax {
  const gstBp = bp(input.gstRate);
  const cessBp = bp(input.cessRate ?? 0);
  const gross = lineGross(input.qty, input.rate);
  const pctDisc = roundHalfUp((gross * bp(input.discountPct ?? 0)) / 10000);
  const discount = Math.min(gross, pctDisc + (input.discountAmt ?? 0));
  const net = gross - discount;

  if (!input.taxInclusive) {
    const t = taxesOn(net, gstBp, cessBp, input.interState);
    const tax = t.cgst + t.sgst + t.igst + t.cess;
    return { gross, discount, taxable: net, ...t, tax, total: net + tax };
  }

  // Inclusive: back out the taxable value, compute taxes on it, then let taxable absorb
  // any paisa difference so the line total equals the price the customer saw.
  const taxable0 = roundHalfUp((net * 10000) / (10000 + gstBp + cessBp));
  const t = taxesOn(taxable0, gstBp, cessBp, input.interState);
  const tax = t.cgst + t.sgst + t.igst + t.cess;
  return { gross, discount, taxable: net - tax, ...t, tax, total: net };
}

export interface BillTotals {
  gross: Paise;
  discount: Paise;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  tax: Paise;
  /** Sum of line totals plus other charges, before round-off. */
  grand: Paise;
  roundOff: Paise;
  /** grand + roundOff — always a whole rupee when rounding is on. */
  payable: Paise;
}

/** Round a bill to the nearest rupee (half-up). Returned value is the adjustment in paise. */
export function roundOffFor(grand: Paise, enabled = true): Paise {
  if (!enabled) return 0;
  return roundHalfUp(grand / 100) * 100 - grand;
}

export function sumLines(lines: LineTax[], opts: { otherCharges?: Paise; roundOff?: boolean } = {}): BillTotals {
  const t = { gross: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, tax: 0 };
  for (const l of lines) {
    t.gross += l.gross;
    t.discount += l.discount;
    t.taxable += l.taxable;
    t.cgst += l.cgst;
    t.sgst += l.sgst;
    t.igst += l.igst;
    t.cess += l.cess;
    t.tax += l.tax;
  }
  const grand = t.taxable + t.tax + (opts.otherCharges ?? 0);
  const roundOff = roundOffFor(grand, opts.roundOff ?? true);
  return { ...t, grand, roundOff, payable: grand + roundOff };
}

export interface TaxSummaryRow {
  key: string; // HSN or rate
  hsn?: string;
  rate: number;
  qty: number;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  total: Paise;
}

/** Group line taxes by HSN+rate (for invoice footers and GSTR-1 HSN table) or by rate only. */
export function taxSummary(
  lines: Array<LineTax & { hsn?: string; gstRate: number; qty?: number }>,
  by: 'hsn' | 'rate',
): TaxSummaryRow[] {
  const map = new Map<string, TaxSummaryRow>();
  for (const l of lines) {
    const key = by === 'hsn' ? `${l.hsn ?? ''}|${l.gstRate}` : String(l.gstRate);
    const row =
      map.get(key) ??
      ({ key, hsn: by === 'hsn' ? l.hsn : undefined, rate: l.gstRate, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 } as TaxSummaryRow);
    row.qty += l.qty ?? 0;
    row.taxable += l.taxable;
    row.cgst += l.cgst;
    row.sgst += l.sgst;
    row.igst += l.igst;
    row.cess += l.cess;
    row.total += l.total;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.rate - b.rate || (a.hsn ?? '').localeCompare(b.hsn ?? ''));
}

/** Place-of-supply rule for goods at a counter: inter-state if supplier and buyer state codes differ. */
export function isInterState(supplierState: string, placeOfSupply: string | null | undefined): boolean {
  if (!placeOfSupply) return false;
  return supplierState.padStart(2, '0') !== placeOfSupply.padStart(2, '0');
}

export const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Validate GSTIN format and its mod-36 check character. */
export function validateGstin(gstin: string): boolean {
  const g = gstin.trim().toUpperCase();
  if (!GSTIN_REGEX.test(g)) return false;
  return gstinCheckChar(g.slice(0, 14)) === g[14];
}

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GSTIN_CHARS.indexOf(first14[i]);
    const prod = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(prod / 36) + (prod % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export const STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura',
  '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};
