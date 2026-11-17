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
  shop: {
    name: string;
    tagline?: string | null;
    address?: string | null;
    phone?: string | null;
    gstin?: string | null;
    fssai?: string | null;
    footer?: string | null;
    /** Terms & conditions, printed at the end (several lines allowed). */
    terms?: string | null;
    /** "Bank: HDFC · A/c 5010… · IFSC HDFC0001234", when the owner shows bank details. */
    bank?: string | null;
  };
  /** TAX INVOICE, CREDIT NOTE, QUOTATION… (default: TAX INVOICE with a GSTIN, else BILL). */
  title?: string;
  number: string;
  date: string;
  time?: string;
  /** "Served by: Ravi" or "By: Counter 1". */
  by?: string | null;
  party?: string | null;
  partyGstin?: string | null;
  partyPan?: string | null;
  lines: Array<{ name: string; qty: number; unit: string; rate: number; total: number; freeQty?: number; gstRate?: number; hsn?: string | null }>;
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  discount?: number;
  otherCharges?: number;
  roundOff: number;
  total: number;
  paid: number;
  mode: string;
  savings?: number;
  upi?: string | null;
  /** How much GST to show, as chosen in Print setup (default: summary). */
  taxDetail?: 'detailed' | 'summary' | 'none';
  interState?: boolean;
  /** GST per rate, for the detailed breakup. */
  taxRows?: Array<{ rate: number; taxable: number; cgst: number; sgst: number; igst: number }>;
  showHsn?: boolean;
  /** Print the UPI QR for the amount due (default: when a UPI id is given). */
  showQr?: boolean;
  /** A quotation: nothing paid, nothing due. */
  quote?: boolean;
}

// ASCII only: the Unicode minus (−) prints as '?' on a thermal printer.
const money = (p: number) => formatINR(p).replace('₹', '').replace(/[−–]/g, '-');
const MODE_LABEL: Record<string, string> = { cash: 'Cash', upi: 'UPI', card: 'Card', bank: 'Bank', cheque: 'Cheque', credit: 'Udhaar', split: 'Cash + UPI', coupon: 'Coupon' };

export interface ReceiptOptions {
  cols?: 32 | 42 | 48;
  cut?: boolean;
  drawer?: boolean;
  /** The printer's quirks; `cols` given here wins over the profile's. */
  profile?: PrinterProfile;
}

/** Split text into lines of at most `width` characters, breaking between words where possible. */
export function wrapWords(text: string, width: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const word of text.trim().split(/\s+/)) {
    for (let w = word; w; ) {
      const room = cur ? width - cur.length - 1 : width;
      if (w.length <= room) {
        cur = cur ? `${cur} ${w}` : w;
        w = '';
      } else if (cur) {
        out.push(cur);
        cur = '';
      } else {
        out.push(w.slice(0, width));
        w = w.slice(width);
      }
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** What a thermal printer's basic code page can show: common typography to ASCII, the rest dropped. */
export function toPrintable(text: string): string {
  return text
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/₹/g, 'Rs.')
    .replace(/×/g, 'x')
    .replace(/\u00a0/g, ' ');
}

/**
 * A receipt laid out for 58 mm (32 columns), 80 mm (48) or 42-column paper, showing what the
 * owner chose in Print setup: tagline, licences, GST detail (none / totals / per-rate breakup),
 * HSN, free quantities, savings, UPI QR, bank details, footer and terms.
 */
export function receipt(r: ReceiptData, opts: ReceiptOptions = {}): Uint8Array {
  const prof = opts.profile ?? PRINTER_PROFILES[0];
  const cols = opts.cols ?? prof.cols;
  const p = new EscPos(cols);
  const big = prof.bigText;
  const tax = r.taxDetail ?? 'summary';
  const center = (text: string, max = 4) => {
    for (const para of toPrintable(text).split(/\r?\n/)) for (const l of wrapWords(para, cols).slice(0, max)) p.line(l);
  };
  const balance = r.quote ? 0 : Math.max(0, r.total - r.paid);

  // ── shop
  p.align('center').bold(true);
  // The shop name never gets cut: it wraps onto more lines (double-size letters take two columns).
  if (big) {
    p.size(2, 2);
    for (const l of wrapWords(toPrintable(r.shop.name), Math.floor(cols / 2)).slice(0, 3)) p.line(l);
    p.size(1, 1);
  } else for (const l of wrapWords(toPrintable(r.shop.name), cols).slice(0, 2)) p.line(l);
  p.bold(false);
  if (r.shop.tagline) center(r.shop.tagline, 2);
  if (r.shop.address) center(r.shop.address, 3);
  if (r.shop.phone) p.line(`Ph: ${r.shop.phone}`);
  if (r.shop.gstin) p.line(`GSTIN: ${r.shop.gstin}`);
  if (r.shop.fssai) p.line(`FSSAI Lic. No: ${r.shop.fssai}`);
  p.bold(true).line(r.title ?? (r.shop.gstin ? 'TAX INVOICE' : 'BILL')).bold(false).align('left').rule();

  // ── bill and customer
  p.lr(`Bill: ${r.number}`, `${r.date}${r.time ? ` ${r.time.slice(0, 5)}` : ''}`);
  if (r.by) p.line(toPrintable(r.by).slice(0, cols));
  if (r.party) for (const l of wrapWords(toPrintable(`To: ${r.party}`), cols).slice(0, 2)) p.line(l);
  if (r.partyGstin) p.line(`GSTIN: ${r.partyGstin}`);
  else if (r.partyPan) p.line(`PAN: ${r.partyPan}`);
  p.rule();

  // ── items: the name on its own line(s), then quantity × rate and the amount
  p.bold(true).lr('Item', cols >= 42 ? 'Qty x Rate      Amount' : 'Amount').bold(false);
  p.rule();
  for (const l of r.lines) {
    const extra = [tax === 'detailed' && l.gstRate != null ? `(${l.gstRate}%)` : '', r.showHsn && l.hsn ? `HSN ${l.hsn}` : ''].filter(Boolean).join(' ');
    for (const t of wrapWords(toPrintable(extra ? `${l.name} ${extra}` : l.name), cols).slice(0, 3)) p.line(t);
    const qty = `${+l.qty.toFixed(3)} ${l.unit}`.slice(0, 10);
    const left = `  ${qty} x ${money(l.rate)}${l.freeQty ? ` +${+l.freeQty.toFixed(3)} free` : ''}`;
    p.lr(left, money(l.total));
  }
  p.rule();
  p.lr(`Items: ${r.lines.length}`, `Qty: ${+r.lines.reduce((s, l) => s + l.qty, 0).toFixed(3)}`);

  // ── totals
  if (r.discount) p.lr('Discount', `-${money(r.discount)}`);
  if (tax !== 'none') p.lr('Taxable value', money(r.taxable));
  if (tax === 'summary') {
    if (r.igst) p.lr('IGST', money(r.igst));
    if (r.cgst) p.lr('CGST', money(r.cgst));
    if (r.sgst) p.lr('SGST', money(r.sgst));
    if (r.cess) p.lr('Cess', money(r.cess));
  }
  if (r.otherCharges) p.lr('Other charges', money(r.otherCharges));
  if (r.roundOff) p.lr('Round off', money(r.roundOff));
  p.rule();
  p.bold(true);
  if (big) p.size(1, 2);
  p.lr('TOTAL', `Rs.${money(r.total)}`).size(1, 1).bold(false);
  if (!r.quote) p.lr(`Paid (${MODE_LABEL[r.mode] ?? r.mode})`, money(r.paid));
  if (balance > 0) p.bold(true).lr('Balance due', money(balance)).bold(false);

  // ── GST breakup per rate
  if (tax === 'detailed' && r.taxRows?.length) {
    p.rule().bold(true).line('GST breakup').bold(false);
    const w = r.interState ? (cols >= 42 ? [8, -16, -16] : [6, -12, -12]) : cols >= 42 ? [6, -14, -11, -11] : [5, -11, -8, -8];
    p.bold(true).row(r.interState ? ['GST%', 'Taxable', 'IGST'] : ['GST%', 'Taxable', 'CGST', 'SGST'], w).bold(false);
    for (const t of r.taxRows) p.row(r.interState ? [`${t.rate}%`, money(t.taxable), money(t.igst)] : [`${t.rate}%`, money(t.taxable), money(t.cgst), money(t.sgst)], w);
    if (r.cess) p.lr('Cess', money(r.cess));
    p.bold(true).lr('Total GST', money(r.cgst + r.sgst + r.igst + r.cess)).bold(false);
  }
  p.align('center');
  if (tax === 'none') p.line('Prices are inclusive of GST');
  if (r.savings && r.savings > 0) p.bold(true).line(`You saved Rs.${money(r.savings)} on MRP!`).bold(false);

  // ── pay the balance by UPI
  const qr = r.showQr ?? !!r.upi;
  if (r.upi && balance > 0 && qr) {
    const link = `upi://pay?pa=${encodeURIComponent(r.upi)}&pn=${encodeURIComponent(r.shop.name)}&am=${(balance / 100).toFixed(2)}&cu=INR&tn=${encodeURIComponent(r.number)}`;
    if (prof.qr) p.line(`Scan & pay Rs.${money(balance)}`).qr(link, cols === 48 ? 6 : 4).line();
    else p.line(`Pay by UPI: ${r.upi}`.slice(0, cols));
  }
  if (r.shop.bank) center(r.shop.bank, 3);

  // ── footer and terms
  p.line(toPrintable(r.shop.footer || 'Thank you! Visit again.'));
  if (r.shop.terms) {
    p.align('left').rule('-');
    for (const para of toPrintable(r.shop.terms).split(/\r?\n/)) for (const l of wrapWords(para, cols)) p.line(l);
  }
  p.align('left').feed(prof.feed);
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
