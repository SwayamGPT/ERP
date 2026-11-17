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
  /** Cut the paper the way this printer understands (see {@link PrinterProfile.cut}). */
  cut(kind: CutKind = 'feed-partial') {
    return this.raw(...cutBytes(kind));
  }
  /** Open the cash drawer: pin 2 (0) or pin 5 (1). */
  drawer(pin: 0 | 1 = 0) {
    return this.raw(ESC, 0x70, pin, 0x19, 0xfa);
  }
  bytes() {
    return new Uint8Array(this.out);
  }
}

/**
 * How a particular receipt printer behaves. Cheap printers sold in India mostly speak ESC/POS but
 * differ in the details — which cut command works, which drawer pin is wired, whether they can draw
 * a QR code, and how many characters fit on a line. A profile captures that per counter.
 */
export type CutKind = 'feed-partial' | 'partial' | 'full' | 'esc-i' | 'none';
export interface PrinterProfile {
  id: string;
  name: string;
  cols: 32 | 42 | 48;
  cut: CutKind;
  /** Blank lines before cutting (printers whose cutter sits far above the print head need more). */
  feed: number;
  drawerPin: 0 | 1;
  /** GS ( k native QR codes. Many cheap printers print junk instead: then the UPI QR is left out. */
  qr: boolean;
  /** Double-size shop name and total (some clones ignore GS ! and print normal size anyway). */
  bigText: boolean;
}

export const PRINTER_PROFILES: PrinterProfile[] = [
  { id: 'generic-80', name: 'Any 80 mm ESC/POS printer', cols: 48, cut: 'feed-partial', feed: 3, drawerPin: 0, qr: true, bigText: true },
  { id: 'epson-tm', name: 'Epson TM-T82 / TM-T88', cols: 48, cut: 'feed-partial', feed: 3, drawerPin: 0, qr: true, bigText: true },
  { id: 'tvs-retsol', name: 'TVS RP / Retsol / Posiflex', cols: 48, cut: 'full', feed: 4, drawerPin: 0, qr: true, bigText: true },
  { id: 'cheap-80', name: 'Xprinter / Rugtek / unbranded 80 mm', cols: 48, cut: 'full', feed: 5, drawerPin: 0, qr: false, bigText: true },
  { id: 'font-b-80', name: '80 mm with 42-character lines', cols: 42, cut: 'full', feed: 4, drawerPin: 0, qr: false, bigText: true },
  { id: 'cheap-58', name: '58 mm (2 inch) printer', cols: 32, cut: 'none', feed: 4, drawerPin: 0, qr: false, bigText: false },
];

export const profileById = (id: string | undefined): PrinterProfile => PRINTER_PROFILES.find((p) => p.id === id) ?? PRINTER_PROFILES[0];

export function cutBytes(kind: CutKind): number[] {
  switch (kind) {
    case 'feed-partial':
      return [GS, 0x56, 0x42, 0x00]; // feed to the cutter, then partial cut
    case 'partial':
      return [GS, 0x56, 0x01];
    case 'full':
      return [GS, 0x56, 0x00];
    case 'esc-i':
      return [ESC, 0x69]; // older and clone printers
    case 'none':
      return [];
  }
}

/** Just the drawer kick, for "open drawer" without a receipt. */
export const drawerKick = (pin: 0 | 1 = 0) => new Uint8Array([ESC, 0x40, ESC, 0x70, pin, 0x19, 0xfa]);

/**
 * A page that shows at a glance what this printer can do: the line width ruler (so the right
 * number of columns can be picked), bold and big text, the ₹ fallback, a QR code and the cut.
 */
export function testPage(p: PrinterProfile, opts: { drawer?: boolean } = {}): Uint8Array {
  const e = new EscPos(p.cols);
  e.align('center').bold(true).line('HISAAB PRINTER TEST').bold(false).line(p.name.slice(0, p.cols)).align('left');
  e.line('Line width ruler - the last digit you see');
  e.line('on ONE line is your column count:');
  let ruler = '';
  for (let i = 1; i <= 48; i++) ruler += String(i % 10);
  e.line(ruler);
  e.line('.........1.........2.........3.........4........');
  e.rule('=');
  e.line('Normal text  0123456789');
  e.bold(true).line('Bold text').bold(false);
  if (p.bigText) e.size(2, 2).line('BIG TEXT').size(1, 1);
  e.line('Rupee prints as: Rs.100.00');
  e.lr('Left', 'Right');
  if (p.qr) e.align('center').line('QR code below (UPI bills use this):').qr('https://hisaab.app', 4).line().align('left');
  else e.line('QR codes: off for this printer');
  e.rule('=');
  e.line(p.cut === 'none' ? 'Tear here - cutting is off.' : 'The paper should cut below this line.');
  e.feed(p.feed);
  if (p.cut !== 'none') e.cut(p.cut);
  if (opts.drawer) e.drawer(p.drawerPin);
  return e.bytes();
}

export interface ReceiptData {
  shop: { name: string; address?: string | null; phone?: string | null; gstin?: string | null; fssai?: string | null; footer?: string | null };
  number: string;
  date: string;
  time?: string;
  party?: string | null;
  partyGstin?: string | null;
  partyPan?: string | null;
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

export interface ReceiptOptions {
  cols?: 32 | 42 | 48;
  cut?: boolean;
  drawer?: boolean;
  /** The printer's quirks; `cols` given here wins over the profile's. */
  profile?: PrinterProfile;
}

/** A receipt laid out for 58 mm (32 columns), 80 mm (48) or 42-column paper. */
export function receipt(r: ReceiptData, opts: ReceiptOptions = {}): Uint8Array {
  const prof = opts.profile ?? PRINTER_PROFILES[0];
  const cols = opts.cols ?? prof.cols;
  const p = new EscPos(cols);
  const big = prof.bigText;
  p.align('center').bold(true);
  if (big) p.size(2, 2).line(r.shop.name.slice(0, Math.floor(cols / 2))).size(1, 1);
  else p.line(r.shop.name.slice(0, cols));
  p.bold(false);
  if (r.shop.address) p.line(r.shop.address.slice(0, cols * 2));
  if (r.shop.phone) p.line(`Ph: ${r.shop.phone}`);
  if (r.shop.gstin) p.line(`GSTIN: ${r.shop.gstin}`);
  if (r.shop.fssai) p.line(`FSSAI: ${r.shop.fssai}`);
  p.bold(true).line(r.shop.gstin ? 'TAX INVOICE' : 'BILL').bold(false).align('left').rule();
  p.lr(`Bill: ${r.number}`, `${r.date}${r.time ? ` ${r.time.slice(0, 5)}` : ''}`);
  if (r.party) p.line(`To: ${r.party}`.slice(0, cols));
  if (r.partyGstin) p.line(`GSTIN: ${r.partyGstin}`);
  else if (r.partyPan) p.line(`PAN: ${r.partyPan}`);
  p.rule();
  const wide = cols >= 42;
  const w = cols === 48 ? [22, -7, -9, -10] : cols === 42 ? [18, -6, -8, -10] : [14, -5, 0, -13];
  p.bold(true).row(['Item', 'Qty', wide ? 'Rate' : '', 'Amount'], w).bold(false);
  for (const l of r.lines) p.row([l.name, `${+l.qty.toFixed(3)}`, wide ? money(l.rate) : '', money(l.total)], w);
  p.rule();
  p.lr('Taxable value', money(r.taxable));
  if (r.cgst) p.lr('CGST', money(r.cgst));
  if (r.sgst) p.lr('SGST', money(r.sgst));
  if (r.igst) p.lr('IGST', money(r.igst));
  if (r.cess) p.lr('Cess', money(r.cess));
  if (r.discount) p.lr('Discount', `-${money(r.discount)}`);
  if (r.roundOff) p.lr('Round off', money(r.roundOff));
  p.bold(true);
  if (big) p.size(1, 2);
  p.lr('TOTAL', `Rs.${money(r.total)}`).size(1, 1).bold(false);
  p.lr(`Paid (${r.mode})`, money(r.paid));
  if (r.total > r.paid) p.bold(true).lr('Balance due', money(r.total - r.paid)).bold(false);
  if (r.savings && r.savings > 0) p.align('center').line(`You saved Rs.${money(r.savings)} on MRP`).align('left');
  if (r.upi && r.total > r.paid && prof.qr) {
    const link = `upi://pay?pa=${encodeURIComponent(r.upi)}&pn=${encodeURIComponent(r.shop.name)}&am=${((r.total - r.paid) / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(r.number)}`;
    p.align('center').line('Scan to pay by UPI').qr(link, cols === 48 ? 6 : 4).line().align('left');
  }
  else if (r.upi && r.total > r.paid) p.align('center').line(`Pay by UPI: ${r.upi}`.slice(0, cols)).align('left');
  p.align('center').line(r.shop.footer ?? 'Thank you! Visit again.').align('left').feed(prof.feed);
  if (opts.cut !== false && prof.cut !== 'none') p.cut(prof.cut);
  if (opts.drawer) p.drawer(prof.drawerPin);
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
