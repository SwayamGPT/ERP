import { formatINR } from './money';

/**
 * ESC/POS for thermal receipt printers (Epson, TVS, Retsol, Xprinter and other compatibles):
 * plain-text receipts laid out in fixed columns, bold / double-size headings, a UPI QR code,
 * paper cut and the cash-drawer kick. Bytes go to the printer raw — no print dialog, instant.
 */

const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private out: number[] = [ESC, 0x40]; // initialise
  constructor(public cols = 48) {}

  /** ASCII only: thermal printers' default code page has no ₹; non-ASCII becomes '?'. */
  text(s: string) {
    for (const ch of s.replace(/₹/g, 'Rs.')) {
      const c = ch.charCodeAt(0);
      this.out.push(c < 128 ? c : 0x3f);
    }
    return this;
  }
  line(s = '') {
    return this.text(s).raw(0x0a);
  }
  raw(...b: number[]) {
    this.out.push(...b);
    return this;
  }
  align(a: 'left' | 'center' | 'right') {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }
  bold(on: boolean) {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }
  /** Double width and/or height. */
  size(w: 1 | 2, h: 1 | 2) {
    return this.raw(GS, 0x21, ((w - 1) << 4) | (h - 1));
  }
  rule(ch = '-') {
    return this.line(ch.repeat(this.cols));
  }
  /** Left text and right text on one line. */
  lr(left: string, right: string) {
    const room = this.cols - right.length - 1;
    const l = left.length > room ? left.slice(0, room) : left;
    return this.line(l + ' '.repeat(this.cols - l.length - right.length) + right);
  }
  /** Columns with widths (negative = right aligned). The first column wraps onto extra lines. */
  row(cells: string[], widths: number[]) {
    const first = Math.abs(widths[0]);
    const head = cells[0];
    const pad = (s: string, w: number) => (w < 0 ? s.slice(0, -w).padStart(-w) : s.slice(0, w).padEnd(w));
    this.line(widths.map((w, i) => pad(i === 0 ? head.slice(0, first) : cells[i], w)).join(''));
    for (let i = first; i < head.length; i += first) this.line(`  ${head.slice(i, i + first - 2)}`);
    return this;
  }
  /** Native QR (GS ( k), size 1–16. */
  qr(data: string, size = 6) {
    const d = Array.from(new TextEncoder().encode(data));
    const len = d.length + 3;
    this.raw(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00); // model 2
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size); // module size
    this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31); // error correction M
    this.raw(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30, ...d); // store
    return this.raw(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30); // print
  }
  feed(n = 3) {
    return this.raw(ESC, 0x64, n);
  }
  cut() {
    return this.raw(GS, 0x56, 0x42, 0x00); // feed to cutter and partial cut
  }
  /** Open the cash drawer on pin 2 (pulse 50 ms / 500 ms). */
  drawer() {
    return this.raw(ESC, 0x70, 0x00, 0x19, 0xfa);
  }
  bytes() {
    return new Uint8Array(this.out);
  }
}

/** Just the drawer kick, for "open drawer" without a receipt. */
export const drawerKick = () => new Uint8Array([ESC, 0x40, ESC, 0x70, 0x00, 0x19, 0xfa]);

export interface ReceiptData {
  shop: { name: string; address?: string | null; phone?: string | null; gstin?: string | null; fssai?: string | null; footer?: string | null };
  number: string;
  date: string;
  time?: string;
  party?: string | null;
  partyGstin?: string | null;
  lines: Array<{ name: string; qty: number; unit: string; rate: number; total: number }>;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  discount?: number;
  roundOff: number;
  total: number;
  paid: number;
  mode: string;
  savings?: number;
  upi?: string | null;
}

const money = (p: number) => formatINR(p).replace('₹', '');

/** A receipt laid out for 58 mm (32 columns) or 80 mm (48 columns) paper. */
export function receipt(r: ReceiptData, opts: { cols?: 32 | 48; cut?: boolean; drawer?: boolean } = {}): Uint8Array {
  const cols = opts.cols ?? 48;
  const p = new EscPos(cols);
  p.align('center').bold(true).size(2, 2).line(r.shop.name.slice(0, cols / 2)).size(1, 1).bold(false);
  if (r.shop.address) p.line(r.shop.address.slice(0, cols * 2));
  if (r.shop.phone) p.line(`Ph: ${r.shop.phone}`);
  if (r.shop.gstin) p.line(`GSTIN: ${r.shop.gstin}`);
  if (r.shop.fssai) p.line(`FSSAI: ${r.shop.fssai}`);
  p.bold(true).line(r.shop.gstin ? 'TAX INVOICE' : 'BILL').bold(false).align('left').rule();
  p.lr(`Bill: ${r.number}`, `${r.date}${r.time ? ` ${r.time.slice(0, 5)}` : ''}`);
  if (r.party) p.line(`To: ${r.party}`.slice(0, cols));
  if (r.partyGstin) p.line(`GSTIN: ${r.partyGstin}`);
  p.rule();
  const w = cols === 48 ? [22, -7, -9, -10] : [14, -5, 0, -13];
  p.bold(true).row(['Item', 'Qty', cols === 48 ? 'Rate' : '', 'Amount'], w).bold(false);
  for (const l of r.lines) p.row([l.name, `${+l.qty.toFixed(3)}`, cols === 48 ? money(l.rate) : '', money(l.total)], w);
  p.rule();
  p.lr('Taxable value', money(r.taxable));
  if (r.cgst) p.lr('CGST', money(r.cgst));
  if (r.sgst) p.lr('SGST', money(r.sgst));
  if (r.igst) p.lr('IGST', money(r.igst));
  if (r.cess) p.lr('Cess', money(r.cess));
  if (r.discount) p.lr('Discount', `-${money(r.discount)}`);
  if (r.roundOff) p.lr('Round off', money(r.roundOff));
  p.bold(true).size(1, 2).lr('TOTAL', `Rs.${money(r.total)}`).size(1, 1).bold(false);
  p.lr(`Paid (${r.mode})`, money(r.paid));
  if (r.total > r.paid) p.bold(true).lr('Balance due', money(r.total - r.paid)).bold(false);
  if (r.savings && r.savings > 0) p.align('center').line(`You saved Rs.${money(r.savings)} on MRP`).align('left');
  if (r.upi && r.total > r.paid) {
    const link = `upi://pay?pa=${encodeURIComponent(r.upi)}&pn=${encodeURIComponent(r.shop.name)}&am=${((r.total - r.paid) / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(r.number)}`;
    p.align('center').line('Scan to pay by UPI').qr(link, cols === 48 ? 6 : 4).line().align('left');
  }
  p.align('center').line(r.shop.footer ?? 'Thank you! Visit again.').align('left').feed(3);
  if (opts.cut !== false) p.cut();
  if (opts.drawer) p.drawer();
  return p.bytes();
}

/** ZPL (Zebra) version of the shelf / barcode label: 50 × 25 mm at 203 dpi. */
export function zplLabel(opts: { name: string; barcode: string; mrp: string; price: string; copies?: number }): string {
  const safe = (s: string) => s.replace(/[\^~]/g, ' ').slice(0, 28);
  return [
    '^XA',
    '^PW400^LL200',
    `^FO16,10^A0N,24,24^FD${safe(opts.name)}^FS`,
    `^FO16,40^BY2^BEN,70,Y,N^FD${opts.barcode.slice(0, 12)}^FS`,
    `^FO16,150^A0N,22,22^FDMRP ${safe(opts.mrp)}  Our ${safe(opts.price)}^FS`,
    `^PQ${opts.copies ?? 1}`,
    '^XZ',
    '',
  ].join('\n');
}
