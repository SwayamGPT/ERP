import { toPaise } from './money';

/**
 * GSTR-2B: the monthly statement of input tax credit the GST portal builds from what your suppliers
 * filed. Download the JSON from the portal (Returns → GSTR-2B → Download) and reconcile it with
 * your purchase bills and expense GST bills to see which credit is safe to claim.
 */

export interface TwoBRow {
  kind: 'inv' | 'cn' | 'dn';
  ctin: string;
  supplier: string;
  docNo: string;
  date: string; // yyyy-mm-dd
  value: number; // paise
  taxable: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  itcAvailable: boolean;
}

const iso = (d: string) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d ?? '');
  return m ? `${m[3]}-${m[2]}-${m[1]}` : d;
};

type Item = { txval?: number; igst?: number; cgst?: number; sgst?: number; cess?: number };
type Sums = { taxable: number; igst: number; cgst: number; sgst: number; cess: number };
const sumItems = (items: Item[] = []): Sums =>
  items.reduce<Sums>(
    (a, i) => ({ taxable: a.taxable + toPaise(i.txval ?? 0), igst: a.igst + toPaise(i.igst ?? 0), cgst: a.cgst + toPaise(i.cgst ?? 0), sgst: a.sgst + toPaise(i.sgst ?? 0), cess: a.cess + toPaise(i.cess ?? 0) }),
    { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 },
  );

export function parseGstr2b(json: unknown): { gstin: string; period: string; rows: TwoBRow[] } {
  const root = ((json as { data?: unknown }).data ?? json) as { gstin?: string; rtnprd?: string; docdata?: Record<string, unknown> };
  if (!root?.docdata) throw new Error('This is not a GSTR-2B file. Download the JSON from the GST portal: Returns → GSTR-2B.');
  const p = root.rtnprd ?? '';
  const period = /^\d{6}$/.test(p) ? `${p.slice(2)}-${p.slice(0, 2)}` : '';
  const rows: TwoBRow[] = [];
  for (const s of (root.docdata.b2b as Array<{ ctin: string; trdnm?: string; inv: Array<{ inum: string; dt: string; val: number; itcavl?: string; items?: Item[] }> }>) ?? []) {
    for (const i of s.inv ?? []) rows.push({ kind: 'inv', ctin: s.ctin, supplier: s.trdnm ?? '', docNo: i.inum, date: iso(i.dt), value: toPaise(i.val ?? 0), ...sumItems(i.items), itcAvailable: i.itcavl !== 'N' });
  }
  for (const s of (root.docdata.cdnr as Array<{ ctin: string; trdnm?: string; nt: Array<{ ntnum: string; typ: string; dt: string; val: number; itcavl?: string; items?: Item[] }> }>) ?? []) {
    for (const n of s.nt ?? []) rows.push({ kind: n.typ === 'D' ? 'dn' : 'cn', ctin: s.ctin, supplier: s.trdnm ?? '', docNo: n.ntnum, date: iso(n.dt), value: toPaise(n.val ?? 0), ...sumItems(n.items), itcAvailable: n.itcavl !== 'N' });
  }
  return { gstin: root.gstin ?? '', period, rows };
}

/** "MD/2291", "md-2291", "MD 02291" → "MD2291": suppliers and data-entry rarely agree on separators. */
export const normDocNo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]*)0+(?=\d)/, '$1');

export interface BookDoc {
  source: 'purchase' | 'expense';
  id: number;
  gstin: string;
  docNo: string;
  date: string;
  value: number;
  tax: number;
}

export type ReconStatus = 'matched' | 'mismatch' | 'missing_in_books' | 'missing_in_2b';

export interface ReconRow {
  status: ReconStatus;
  twoB: TwoBRow | null;
  book: BookDoc | null;
  diff: number; // paise, 2B tax − books tax
}

/** Pair 2B lines with your bills by supplier GSTIN + bill number; tax differences over ₹1 are flagged. */
export function reconcile2b(rows: TwoBRow[], books: BookDoc[]): ReconRow[] {
  const key = (g: string, n: string) => `${g.toUpperCase()}|${normDocNo(n)}`;
  const byKey = new Map<string, BookDoc>();
  for (const b of books) byKey.set(key(b.gstin, b.docNo), b);
  const used = new Set<BookDoc>();
  const out: ReconRow[] = [];
  for (const r of rows.filter((x) => x.kind === 'inv')) {
    const b = byKey.get(key(r.ctin, r.docNo));
    const tax = r.igst + r.cgst + r.sgst + r.cess;
    if (!b) {
      out.push({ status: 'missing_in_books', twoB: r, book: null, diff: tax });
      continue;
    }
    used.add(b);
    const diff = tax - b.tax;
    out.push({ status: Math.abs(diff) <= 100 ? 'matched' : 'mismatch', twoB: r, book: b, diff });
  }
  for (const b of books) if (!used.has(b)) out.push({ status: 'missing_in_2b', twoB: null, book: b, diff: -b.tax });
  return out;
}
