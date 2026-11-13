/**
 * Money is ALWAYS an integer number of paise. ₹100.00 === 10000.
 * Never store or sum floats in money paths.
 */
export type Paise = number;

/** Half-up rounding that is symmetric for negatives (−2.5 → −3), unlike Math.round. */
export function roundHalfUp(x: number): number {
  // Nudge by a tiny epsilon relative to magnitude to defeat binary representation error
  // (e.g. 1.005 * 100 = 100.49999999999999).
  const abs = Math.abs(x);
  const r = Math.round(abs + abs * Number.EPSILON * 4);
  return x < 0 ? -r : r;
}

export function assertPaise(p: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(p)) throw new Error(`${label} must be integer paise, got ${p}`);
  return p;
}

/** Parse "1,234.5" | "₹ 12" | 12.34 → paise (exact for up to 2 decimals). */
export function toPaise(value: string | number | null | undefined): Paise {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return roundHalfUp(value * 100);
  const cleaned = value.replace(/[₹,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
  if (!/^-?\d*(\.\d*)?$/.test(cleaned)) return NaN;
  const neg = cleaned.startsWith('-');
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.');
  const frac3 = (frac + '000').slice(0, 3);
  let p = Number(whole || '0') * 100 + Number(frac3.slice(0, 2));
  if (Number(frac3[2]) >= 5) p += 1;
  return neg ? -p : p;
}

/** Paise → rupees number with 2 decimals (for JSON exports like GSTN that want rupees). */
export function toRupees(p: Paise): number {
  return Math.round(p) / 100;
}

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** 12345600 → "₹1,23,456.00" */
export function formatINR(p: Paise, opts: { symbol?: boolean; decimals?: boolean } = {}): string {
  const { symbol = true, decimals = true } = opts;
  const neg = p < 0;
  const body = decimals ? inr.format(Math.abs(p) / 100) : inr0.format(Math.round(Math.abs(p) / 100));
  return `${neg ? '−' : ''}${symbol ? '₹' : ''}${body}`;
}

/** Compact: 1.2L, 3.4Cr, 12.5K — for dashboards. */
export function formatINRCompact(p: Paise): string {
  const r = Math.abs(p) / 100;
  const sign = p < 0 ? '−' : '';
  if (r >= 1e7) return `${sign}₹${(r / 1e7).toFixed(2)}Cr`;
  if (r >= 1e5) return `${sign}₹${(r / 1e5).toFixed(2)}L`;
  if (r >= 1e3) return `${sign}₹${(r / 1e3).toFixed(1)}K`;
  return `${sign}₹${r.toFixed(0)}`;
}

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  const o = ONES[n % 10];
  return o ? `${t}-${o}` : t;
}

function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(' ');
}

/** Indian numbering system words: 12345678 → "One Crore Twenty-Three Lakh Forty-Five Thousand Six Hundred Seventy-Eight" */
export function numberToIndianWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) parts.push(`${crore >= 100 ? numberToIndianWords(crore) : twoDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (n) parts.push(threeDigits(n));
  return parts.join(' ');
}

/** 12345650 → "Rupees One Lakh Twenty-Three Thousand Four Hundred Fifty-Six and Fifty Paise Only" */
export function amountInWords(p: Paise): string {
  const rupees = Math.floor(Math.abs(p) / 100);
  const paise = Math.abs(p) % 100;
  let s = `Rupees ${numberToIndianWords(rupees)}`;
  if (paise) s += ` and ${twoDigits(paise)} Paise`;
  return `${p < 0 ? 'Minus ' : ''}${s} Only`;
}

export function sumPaise(values: Paise[]): Paise {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** Percent of an amount using basis points so 2.5% is exact: pct(10000, 2.5) → 250 */
export function percentOf(p: Paise, pct: number): Paise {
  const bp = Math.round(pct * 100);
  return roundHalfUp((p * bp) / 10000);
}
