/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('EAN-13 needs 12 digits before the check digit');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function makeEan13(first12: string): string {
  return first12 + ean13CheckDigit(first12);
}

export type WeightBarcodeMode = 'weight' | 'price';

export interface WeightBarcode {
  prefix: string; // 20–29
  plu: string; // 5-digit item code
  /** grams when mode = weight, paise when mode = price */
  value: number;
  mode: WeightBarcodeMode;
}

/**
 * In-store (scale) barcodes, GS1 restricted-circulation prefixes 20–29:
 *   PP IIIII VVVVV C → 2-digit prefix, 5-digit item (PLU) code, 5-digit weight (g) or price (paise), check digit.
 */
export function parseWeightBarcode(code: string, mode: WeightBarcodeMode): WeightBarcode | null {
  if (!isValidEan13(code)) return null;
  const prefix = code.slice(0, 2);
  const p = Number(prefix);
  if (p < 20 || p > 29) return null;
  return { prefix, plu: code.slice(2, 7), value: Number(code.slice(7, 12)), mode };
}

export function buildWeightBarcode(plu: string, value: number, prefix = '21'): string {
  const v = String(Math.round(value)).padStart(5, '0');
  if (v.length > 5) throw new Error('Weight/price too large for a 5-digit field');
  return makeEan13(`${prefix}${plu.padStart(5, '0').slice(-5)}${v}`);
}

/** Internal item barcode: prefix 29 + 10-digit item id (restricted circulation, never collides with GS1 codes). */
export function internalItemBarcode(itemId: number): string {
  return makeEan13(`29${String(itemId).padStart(10, '0')}`);
}

/* ─────────────── EAN-13 rendering (module pattern for SVG/print) ─────────────── */

const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

/** Returns a 95-character string of 0/1 bars for an EAN-13 code. */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error(`Invalid EAN-13: ${code}`);
  const first = Number(code[0]);
  const parity = PARITY[first];
  let bits = '101';
  for (let i = 1; i <= 6; i++) {
    const d = Number(code[i]);
    bits += parity[i - 1] === 'L' ? L[d] : G[d];
  }
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
  bits += '101';
  return bits;
}

/** TSPL commands for a 50×25mm label printer (TSC/TVS/Godex). Sent raw via Tauri in R2. */
export function tsplLabel(opts: { name: string; barcode: string; mrp: string; price: string; copies?: number }): string {
  const safe = (s: string) => s.replace(/"/g, "'").slice(0, 28);
  return [
    'SIZE 50 mm, 25 mm',
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
    'CLS',
    `TEXT 12,8,"2",0,1,1,"${safe(opts.name)}"`,
    `BARCODE 12,34,"EAN13",60,1,0,2,2,"${opts.barcode.slice(0, 12)}"`,
    `TEXT 12,130,"2",0,1,1,"MRP ${safe(opts.mrp)}  Our ${safe(opts.price)}"`,
    `PRINT ${opts.copies ?? 1},1`,
    '',
  ].join('\r\n');
}

/* ───────── barcode scanners (keyboard wedge) ───────── */

// Digits as they arrive when the scanner and the computer disagree on the keyboard layout.
const SHIFTED_DIGITS: Record<string, string> = { ')': '0', '!': '1', '@': '2', '#': '3', $: '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9' };
const AZERTY_DIGITS: Record<string, string> = { 'à': '0', '&': '1', 'é': '2', '"': '3', "'": '4', '(': '5', '-': '6', 'è': '7', _: '8', 'ç': '9' };

/**
 * What a USB scanner typed, cleaned up: control characters and AIM symbology prefixes (`]E0`,
 * `]C1`) dropped, surrounding spaces trimmed, and a code typed in the wrong keyboard layout
 * (`!@#…` for `123…`, or French AZERTY) turned back into digits.
 */
export function cleanScan(raw: string): string {
  let s = Array.from(raw).filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f).join('').trim();
  s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '');
  for (const map of [SHIFTED_DIGITS, AZERTY_DIGITS]) {
    if (s.length >= 6 && Array.from(s).every((c) => c in map || /\d/.test(c)) && !/^\d+$/.test(s)) return Array.from(s).map((c) => map[c] ?? c).join('');
  }
  return s;
}

/**
 * Tells a scanner from a person: scanners "type" a whole code within a few milliseconds per key and
 * end with Enter (or Tab). Feed it every key with its time; it returns the code when a scan ends.
 */
export class ScanDetector {
  private buf = '';
  private last = 0;
  constructor(private opts: { maxGapMs?: number; minLength?: number } = {}) {}
  /** Returns the scanned code on the terminating key, else null. `key` is KeyboardEvent.key. */
  key(key: string, at: number): string | null {
    const gap = this.opts.maxGapMs ?? 35;
    if (this.buf && at - this.last > gap) this.buf = '';
    this.last = at;
    if (key === 'Enter' || key === 'Tab') {
      const code = this.buf;
      this.buf = '';
      return code.length >= (this.opts.minLength ?? 4) ? cleanScan(code) : null;
    }
    if (key.length === 1) this.buf += key;
    return null;
  }
  /** Characters seen so far in what looks like a scan (to take back out of the wrong box). */
  get pending() {
    return this.buf;
  }
}
