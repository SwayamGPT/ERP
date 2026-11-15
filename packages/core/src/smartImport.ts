import { validateGstin } from './gst';

/**
 * Smart spreadsheet import: turns an Excel / CSV export from Marg, Tally, Busy, Vyapar or any
 * hand-made sheet into clean item or party records.
 *
 *  - finds the header row even under report titles, and two-line headers ("Sale" / "Rate")
 *  - works out whether the sheet is items (with or without stock) or customers / suppliers
 *  - maps columns by their names (English + common ERP abbreviations), falling back to what the
 *    values look like (GSTINs, phone numbers, HSN codes, GST rates, dates)
 *  - reads Indian number formats (1,23,456.50 · ₹ · (120) · 120 Dr / Cr), dates (12/11/26,
 *    12-Nov-2026, 11/26 for expiry, Excel serial numbers), units (NOS, KGS, LTRS…) and GST %
 *  - skips totals, page breaks and repeated headers; uses group heading rows ("BEVERAGES",
 *    "Sundry Debtors") as the category / party type of the rows under them
 *
 * Pure functions on string[][] so it runs anywhere and is unit-tested.
 */

export type ImportKind = 'items' | 'parties';

type FieldType = 'text' | 'money' | 'qty' | 'pct' | 'date' | 'gstin' | 'phone' | 'hsn' | 'unit' | 'drcr' | 'int';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** Header patterns, most specific first. Matched against the lower-cased, squashed header. */
  names: RegExp[];
}

const F = (key: string, label: string, type: FieldType, ...names: RegExp[]): FieldDef => ({ key, label, type, names });

export const ITEM_FIELDS: FieldDef[] = [
  F('name', 'Item name', 'text', /^(item|product|medicine|stock ?item)( ?name)?$/, /^(name of item|description of goods|particulars|description|name)$/, /item|product|particular|description/),
  F('code', 'Item code', 'text', /^(item ?code|code|sku|alias|short ?name|item ?id|product ?code)$/, /code|alias/),
  F('barcode', 'Barcode', 'text', /^(bar ?code|ean|upc|gtin)( ?no\.?)?$/, /barcode|ean/),
  F('category', 'Category', 'text', /^(category|group|item ?group|stock ?group|department|sub ?group)$/, /categ|group/),
  F('brand', 'Brand / company', 'text', /^(brand|company|mfr|mfg|manufacturer|make|marketed by)$/, /brand|company|manufact/),
  F('hsn', 'HSN code', 'hsn', /^(hsn|hsn ?\/ ?sac|hsn ?code|sac)$/, /hsn/),
  F('gst', 'GST %', 'pct', /^(gst|gst ?%|gst ?rate|tax|tax ?%|tax ?rate|igst|igst ?%|rate of tax|vat ?%?)$/, /gst|tax ?%|igst/),
  F('unit', 'Unit', 'unit', /^(unit|uom|units|unit ?name|base ?unit)$/, /uom|unit/),
  F('mrp', 'MRP', 'money', /^m ?r ?p( ?rate)?$/, /mrp|m r p/),
  F('rate', 'Selling price', 'money', /^(sale ?rate|selling ?(price|rate)|s\.? ?rate|retail( ?(price|rate))?|rate ?a|price|rate|sale ?price)$/, /sell|sale ?rate|retail/),
  F('wholesale', 'Wholesale price', 'money', /^(wholesale( ?(price|rate))?|rate ?b|w\.? ?rate|trade ?(rate|price)|ptr|dealer ?(rate|price))$/, /wholesale|trade|dealer/),
  F('cost', 'Purchase price', 'money', /^(purchase ?(rate|price)|p\.? ?rate|pur\.? ?rate|cost( ?price)?|landing( ?cost)?|pts|buy(ing)? ?price)$/, /purchase|cost|landing/),
  F('qty', 'Stock quantity', 'qty', /^(stock|closing ?stock|cl\.? ?stock|qty|quantity|balance ?qty|closing ?qty|current ?stock|in ?stock|opening ?stock|op\.? ?stock)$/, /stock|qty|quantity/),
  F('batch', 'Batch', 'text', /^(batch|batch ?no\.?|batch ?number|lot)$/, /batch/),
  F('expiry', 'Expiry', 'date', /^(exp|expiry|exp\.? ?date|expiry ?date|exp\.? ?dt\.?|best before)$/, /exp/),
  F('reorder', 'Reorder level', 'qty', /^(re-?order( ?level| ?qty)?|min\.? ?(stock|qty|level))$/, /reorder|minimum/),
];

export const PARTY_FIELDS: FieldDef[] = [
  F('name', 'Name', 'text', /^(party|party ?name|name|customer( ?name)?|supplier( ?name)?|ledger( ?name)?|account( ?name)?|particulars)$/, /party|name|ledger|particular/),
  F('type', 'Customer / supplier', 'text', /^(type|group|under|party ?type|ledger ?group|account ?group|category)$/, /group|type/),
  F('gstin', 'GSTIN', 'gstin', /^(gstin|gst ?no\.?|gst ?number|gstin ?\/ ?uin|gst ?in)$/, /gst/),
  F('phone', 'Mobile', 'phone', /^(mobile|mob\.?( ?no\.?)?|phone|phone ?no\.?|contact|contact ?no\.?|cell|whatsapp)$/, /mob|phone|contact/),
  F('address', 'Address', 'text', /^(address|addr\.?|address ?1|full ?address)$/, /address/),
  F('city', 'City', 'text', /^(city|station|town|area|place|location)$/, /city|station/),
  F('pincode', 'PIN code', 'int', /^(pin|pin ?code|pincode|postal ?code|zip)$/, /pin/),
  F('state', 'State', 'text', /^(state|state ?name)$/, /state/),
  F('balance', 'Balance', 'money', /^(balance|closing ?balance|cl\.? ?bal(ance)?|outstanding|net ?balance|op\.? ?bal(ance)?|opening ?balance|amount|due|total ?due)$/, /balance|outstanding|due/),
  F('drcr', 'Dr / Cr', 'drcr', /^(dr ?\/ ?cr|dr ?cr|cr ?\/ ?dr|d ?\/ ?c)$/),
  F('debit', 'Debit', 'money', /^(debit|dr|dr\.? ?amount|debit ?amount|receivable)$/),
  F('credit', 'Credit', 'money', /^(credit|cr|cr\.? ?amount|credit ?amount|payable)$/),
  F('creditLimit', 'Credit limit', 'money', /^(credit ?limit|cr\.? ?limit)$/),
  F('creditDays', 'Credit days', 'int', /^(credit ?days|cr\.? ?days|due ?days|payment ?terms)$/),
];

export const FIELDS: Record<ImportKind, FieldDef[]> = { items: ITEM_FIELDS, parties: PARTY_FIELDS };

const squash = (s: string) => s.toLowerCase().replace(/[\s_.]+/g, ' ').replace(/[^a-z0-9%/ -]/g, '').trim();

/** 3 = an exact known name, 2 = another exact name, 1 = contains a known word, 0 = no match. */
function nameScore(f: FieldDef, header: string): number {
  const h = squash(header);
  if (!h) return 0;
  let best = 0;
  f.names.forEach((re, i) => {
    if (!re.test(h)) return;
    const s = re.source.startsWith('^') ? (i === 0 ? 3 : 2) : 1;
    if (s > best) best = s;
  });
  return best;
}

/* ───────── value parsing ───────── */

/** "₹ 1,23,456.50" · "(120.00)" · "-45" · "1,200 Dr" → paise (Dr positive, Cr negative). */
export function parseMoney(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t || /^-+$/.test(t)) return null;
  const cr = /\bcr\.?$/i.test(t);
  const neg = /^\(.*\)$/.test(t) || /^-/.test(t) || /-\s*$/.test(t) || cr;
  const n = Number(t.replace(/\b(dr|cr|rs|inr)\.?/gi, '').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || t.replace(/[^\d]/g, '') === '') return null;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/** "12" · "10 PCS" · "2.5 kg" · "12+2" (free) → number and unit. */
export function parseQty(s: string | undefined | null): { qty: number; unit: string | null } | null {
  if (s == null || String(s).trim() === '') return null;
  const t = String(s).trim().replace(/,/g, '');
  const m = /^(-?\d+(?:\.\d+)?)(?:\s*\+\s*(\d+(?:\.\d+)?))?\s*([a-zA-Z]+)?\.?$/.exec(t);
  if (!m) {
    const n = Number(t.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? { qty: n, unit: null } : null;
  }
  return { qty: Number(m[1]) + (m[2] ? Number(m[2]) : 0), unit: m[3] ? normalizeUnit(m[3]) : null };
}

export function parsePct(s: string | undefined | null): number | null {
  if (s == null || String(s).trim() === '') return null;
  const t = String(s).toLowerCase();
  if (/exempt|nil|^-$/.test(t)) return 0;
  const n = Number(t.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n > 100) return null;
  // "0.18" style fractions
  return n > 0 && n < 1 && /^0\.\d+$/.test(t.trim()) ? Math.round(n * 10000) / 100 : n;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const yr = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** dd/mm/yyyy · dd-mm-yy · 12-Nov-2026 · Nov-26 / 11/26 (month only → end of month) · yyyy-mm-dd · Excel serial. */
export function parseDate(s: string | undefined | null): string | null {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m && +m[2] <= 12) return `${yr(m[3])}-${pad(+m[2])}-${pad(+m[1])}`;
  m = /^(\d{1,2})[\s/.-]([a-z]{3,4})[a-z]*[\s/.,-]+(\d{2}|\d{4})$/i.exec(t);
  if (m && MONTHS[m[2].toLowerCase()]) return `${yr(m[3])}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`;
  m = /^([a-z]{3,4})[a-z]*[\s/.,-]+(\d{2}|\d{4})$/i.exec(t);
  if (m && MONTHS[m[1].toLowerCase()]) {
    const y = yr(m[2]);
    const mo = MONTHS[m[1].toLowerCase()];
    return `${y}-${pad(mo)}-${pad(lastDay(y, mo))}`;
  }
  m = /^(\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 12) {
    const y = yr(m[2]);
    return `${y}-${pad(+m[1])}-${pad(lastDay(y, +m[1]))}`;
  }
  if (/^\d{5}(\.\d+)?$/.test(t)) {
    const n = Math.floor(Number(t));
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
  }
  return null;
}

const UNIT_MAP: Array<[RegExp, string]> = [
  [/^(pcs?|nos?|nos\.|pieces?|pc\.|numbers?|units?|ea|each|u)$/i, 'Pcs'],
  [/^(kgs?|kilo(gram)?s?|kilos?)$/i, 'Kg'],
  [/^(g|gms?|grams?|grm)$/i, 'g'],
  [/^(l|ltrs?|lit(re|er)s?|lt)$/i, 'Ltr'],
  [/^(ml|mls|millilit(re|er)s?)$/i, 'ml'],
  [/^(box|boxes|bx)$/i, 'Box'],
  [/^(pkt|pkts|packs?|pac|packets?)$/i, 'Pack'],
  [/^(doz|dzn|dozens?)$/i, 'Dozen'],
  [/^(btl|bottles?)$/i, 'Bottle'],
  [/^(ctn|cartons?|case|cases|cs)$/i, 'Carton'],
  [/^(bags?|sacks?)$/i, 'Bag'],
  [/^(strips?|stp)$/i, 'Strip'],
  [/^(mtrs?|m|metres?|meters?)$/i, 'Mtr'],
  [/^(set|sets)$/i, 'Set'],
  [/^(pair|pairs|pr)$/i, 'Pair'],
];

export function normalizeUnit(s: string | null | undefined): string {
  const t = (s ?? '').trim().replace(/\.$/, '');
  if (!t) return 'Pcs';
  for (const [re, u] of UNIT_MAP) if (re.test(t)) return u;
  return t.length <= 8 ? t[0].toUpperCase() + t.slice(1).toLowerCase() : 'Pcs';
}

/* ───────── what the values look like ───────── */

const looks: Partial<Record<FieldType, (v: string) => boolean>> = {
  gstin: (v) => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/i.test(v.trim()),
  phone: (v) => /^(\+?91[\s-]?)?[6-9]\d{9}$/.test(v.replace(/[\s-]/g, '')),
  hsn: (v) => /^\d{4}(\d{2})?(\d{2})?$/.test(v.trim()),
  pct: (v) => [0, 0.25, 3, 5, 12, 18, 28, 40].includes(Number(v.replace('%', '').trim())) && /\d/.test(v),
  date: (v) => parseDate(v) != null && !/^\d{4,}$/.test(v.trim()),
  drcr: (v) => /^(dr|cr)\.?$/i.test(v.trim()),
};

const share = (vals: string[], test: (v: string) => boolean) => {
  const filled = vals.filter((v) => v.trim() !== '');
  return filled.length ? filled.filter(test).length / filled.length : 0;
};

/* ───────── header & kind detection ───────── */

export interface Detected {
  kind: ImportKind;
  headerRow: number;
  /** Header text per column (two-line headers are joined). */
  headers: string[];
  /** Data rows (after the header). */
  body: string[][];
  /** File line number (1-based) of the first data row. */
  bodyStart: number;
  mapping: Record<string, number | null>;
  confidence: Record<string, 'high' | 'medium' | 'guess' | null>;
}

function headerScore(cells: string[], fields: FieldDef[]) {
  let s = 0;
  for (const f of fields) s += Math.max(0, ...cells.map((c) => nameScore(f, c)));
  return s;
}

export function detect(rows: string[][], force?: ImportKind): Detected {
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? '').trim()));
  let best = { row: 0, two: false, kind: (force ?? 'items') as ImportKind, score: -1 };
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const one = grid[i];
    const two = grid[i + 1] ? one.map((c, j) => `${c} ${grid[i + 1][j]}`.trim()) : null;
    for (const kind of force ? [force] : (['items', 'parties'] as ImportKind[])) {
      const fields = FIELDS[kind];
      const s1 = headerScore(one, fields);
      if (s1 > best.score) best = { row: i, two: false, kind, score: s1 };
      // A two-line header only wins when the second line isn't data.
      if (two && grid[i + 1].filter((c) => /\d/.test(c)).length <= 1) {
        const s2 = headerScore(two, fields) - 0.5;
        if (s2 > best.score) best = { row: i, two: true, kind, score: s2 };
      }
    }
  }
  const headers = best.two ? grid[best.row].map((c, j) => `${c} ${grid[best.row + 1][j]}`.trim()) : grid[best.row];
  const body = grid.slice(best.row + (best.two ? 2 : 1));
  let kind = best.kind;
  if (!force) {
    // Values decide close calls: GSTIN + phone columns and no MRP/HSN → parties.
    const it = headerScore(headers, ITEM_FIELDS);
    const pa = headerScore(headers, PARTY_FIELDS);
    if (Math.abs(it - pa) <= 2) {
      const cols = headers.map((_, j) => body.slice(0, 200).map((r) => r[j]));
      const partyish = cols.some((c) => share(c, looks.gstin!) > 0.3) || cols.some((c) => share(c, looks.phone!) > 0.5);
      const itemish = headers.some((h) => /mrp|hsn|batch|exp/i.test(h));
      kind = partyish && !itemish ? 'parties' : itemish ? 'items' : kind;
    }
  }
  const { mapping, confidence } = mapColumns(headers, body, kind);
  return { kind, headerRow: best.row, headers, body, bodyStart: best.row + (best.two ? 2 : 1) + 1, mapping, confidence };
}

export function mapColumns(headers: string[], body: string[][], kind: ImportKind) {
  const fields = FIELDS[kind];
  const mapping: Record<string, number | null> = {};
  const confidence: Record<string, 'high' | 'medium' | 'guess' | null> = {};
  const used = new Set<number>();
  // Strongest name matches first, so "Sale Rate" goes to selling price before "Rate" is considered.
  const cands: Array<{ f: FieldDef; col: number; s: number }> = [];
  for (const f of fields) headers.forEach((h, col) => {
    const s = nameScore(f, h);
    if (s) cands.push({ f, col, s });
  });
  cands.sort((a, b) => b.s - a.s || fields.indexOf(a.f) - fields.indexOf(b.f));
  for (const c of cands) {
    if (mapping[c.f.key] != null || used.has(c.col)) continue;
    mapping[c.f.key] = c.col;
    confidence[c.f.key] = c.s >= 3 ? 'high' : 'medium';
    used.add(c.col);
  }
  // Fall back to the values for columns nobody claimed.
  const sample = (col: number) => body.slice(0, 200).map((r) => r[col] ?? '');
  for (const f of fields) {
    if (mapping[f.key] != null || !looks[f.type]) continue;
    const col = headers.findIndex((_, j) => !used.has(j) && share(sample(j), looks[f.type]!) > 0.8);
    if (col >= 0) {
      mapping[f.key] = col;
      confidence[f.key] = 'guess';
      used.add(col);
    }
  }
  for (const f of fields) {
    mapping[f.key] ??= null;
    confidence[f.key] ??= null;
  }
  // The name column is often unlabeled or called "Particulars": take the first mostly-text column.
  if (mapping.name == null) {
    const col = headers.findIndex((_, j) => !used.has(j) && share(sample(j), (v) => /[a-z]{3}/i.test(v)) > 0.7);
    if (col >= 0) (mapping.name = col), (confidence.name = 'guess');
  }
  return { mapping, confidence };
}

/* ───────── rows → records ───────── */

export interface ItemRecord {
  row: number;
  name: string;
  code?: string;
  barcode?: string;
  category?: string;
  brand?: string;
  hsn?: string;
  gst?: number;
  unit: string;
  mrp?: number;
  rate?: number;
  wholesale?: number;
  cost?: number;
  qty?: number;
  batch?: string;
  expiry?: string;
  reorder?: number;
  warnings: string[];
}

export interface PartyRecord {
  row: number;
  name: string;
  kind: 'customer' | 'supplier' | null;
  gstin?: string;
  phone?: string;
  address?: string;
  city?: string;
  pincode?: string;
  stateCode?: string;
  /** Paise: + they owe us (Dr), − we owe them (Cr). */
  balance?: number;
  creditLimit?: number;
  creditDays?: number;
  warnings: string[];
}

export interface Skipped {
  row: number;
  reason: string;
  text: string;
}

const JUNK = /^(grand ?total|sub ?total|total|page ?\d+|continued|carried over|b\/f|c\/f|opening|closing)\b/i;

const isGroupRow = (r: string[], nameCol: number | null) => {
  const filled = r.map((c, i) => [c, i] as const).filter(([c]) => c.trim() !== '');
  return filled.length === 1 && !/\d{2,}/.test(filled[0][0]) && (nameCol == null || filled[0][1] <= nameCol + 1);
};

const STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', punjab: '03', chandigarh: '04', uttarakhand: '05', haryana: '06', delhi: '07', rajasthan: '08', 'uttar pradesh': '09', bihar: '10',
  sikkim: '11', 'arunachal pradesh': '12', nagaland: '13', manipur: '14', mizoram: '15', tripura: '16', meghalaya: '17', assam: '18', 'west bengal': '19', jharkhand: '20', odisha: '21', orissa: '21',
  chhattisgarh: '22', 'madhya pradesh': '23', gujarat: '24', 'dadra and nagar haveli and daman and diu': '26', maharashtra: '27', karnataka: '29', goa: '30', lakshadweep: '31', kerala: '32',
  'tamil nadu': '33', puducherry: '34', 'andaman and nicobar islands': '35', telangana: '36', 'andhra pradesh': '37', ladakh: '38',
};

export function toItems(d: Pick<Detected, 'body' | 'mapping'> & { bodyStart?: number }, opts: { defaultGst?: number } = {}): { records: ItemRecord[]; skipped: Skipped[] } {
  const m = d.mapping;
  const get = (r: string[], k: string) => (m[k] != null ? (r[m[k]!] ?? '').trim() : '');
  const records: ItemRecord[] = [];
  const skipped: Skipped[] = [];
  let group: string | undefined;
  d.body.forEach((r, i) => {
    const row = i + (d.bodyStart ?? 1);
    if (r.every((c) => !c.trim())) return;
    const name = get(r, 'name');
    const first = r.find((c) => c.trim())!.trim();
    if (JUNK.test(first)) return void skipped.push({ row, reason: 'Total / heading line', text: first });
    if (isGroupRow(r, m.name)) return void (group = first);
    if (!name) return void skipped.push({ row, reason: 'No item name', text: r.filter(Boolean).join(' | ').slice(0, 80) });
    if (JUNK.test(name)) return void skipped.push({ row, reason: 'Total / heading line', text: name });
    if (squash(name) === squash(d.body[0]?.[m.name!] ?? '') && row > 1 && /name|item|product/i.test(name)) return void skipped.push({ row, reason: 'Repeated header', text: name });
    const w: string[] = [];
    const q = parseQty(get(r, 'qty'));
    const unitText = get(r, 'unit');
    const gst = parsePct(get(r, 'gst'));
    if (get(r, 'gst') && gst == null) w.push(`GST “${get(r, 'gst')}” not understood`);
    const hsn = get(r, 'hsn').replace(/\D/g, '');
    if (get(r, 'hsn') && !/^\d{4,8}$/.test(hsn)) w.push('HSN should be 4–8 digits');
    const exp = get(r, 'expiry');
    const expiry = parseDate(exp) ?? undefined;
    if (exp && !expiry) w.push(`Expiry “${exp}” not understood`);
    const money = (k: string) => {
      const v = parseMoney(get(r, k));
      return v == null ? undefined : Math.abs(v);
    };
    const rec: ItemRecord = {
      row, name: name.replace(/\s+/g, ' '), warnings: w,
      code: get(r, 'code') || undefined,
      barcode: get(r, 'barcode').replace(/\.0$/, '') || undefined,
      category: get(r, 'category') || group,
      brand: get(r, 'brand') || undefined,
      hsn: hsn || undefined,
      gst: gst ?? opts.defaultGst,
      unit: unitText ? normalizeUnit(unitText) : q?.unit ?? 'Pcs',
      mrp: money('mrp'),
      rate: money('rate'),
      wholesale: money('wholesale'),
      cost: money('cost'),
      qty: q?.qty,
      batch: get(r, 'batch') || undefined,
      expiry,
      reorder: parseQty(get(r, 'reorder'))?.qty,
    };
    if (rec.rate == null && rec.mrp != null) rec.rate = rec.mrp;
    if (rec.mrp != null && rec.rate != null && rec.rate > rec.mrp && rec.mrp > 0) w.push('Selling price is above MRP');
    if (rec.qty != null && rec.qty < 0) w.push('Negative stock');
    records.push(rec);
  });
  return { records, skipped };
}

export function toParties(d: Pick<Detected, 'body' | 'mapping'> & { bodyStart?: number }, opts: { defaultKind?: 'customer' | 'supplier' } = {}): { records: PartyRecord[]; skipped: Skipped[] } {
  const m = d.mapping;
  const get = (r: string[], k: string) => (m[k] != null ? (r[m[k]!] ?? '').trim() : '');
  const records: PartyRecord[] = [];
  const skipped: Skipped[] = [];
  let groupKind: PartyRecord['kind'] = null;
  const kindOf = (t: string): PartyRecord['kind'] =>
    /debtor|customer|buyer|receivable|retailer|client/i.test(t) ? 'customer' : /creditor|supplier|vendor|payable|distributor|seller/i.test(t) ? 'supplier' : null;
  d.body.forEach((r, i) => {
    const row = i + (d.bodyStart ?? 1);
    if (r.every((c) => !c.trim())) return;
    const name = get(r, 'name');
    const first = r.find((c) => c.trim())!.trim();
    if (JUNK.test(first)) return void skipped.push({ row, reason: 'Total / heading line', text: first });
    if (isGroupRow(r, m.name)) {
      groupKind = kindOf(first) ?? groupKind;
      return;
    }
    if (!name) return void skipped.push({ row, reason: 'No name', text: r.filter(Boolean).join(' | ').slice(0, 80) });
    if (JUNK.test(name)) return void skipped.push({ row, reason: 'Total / heading line', text: name });
    const w: string[] = [];
    let gstin = get(r, 'gstin').toUpperCase().replace(/\s/g, '') || undefined;
    if (gstin && (/^(na|nil|unregistered|urp|-)$/i.test(gstin))) gstin = undefined;
    if (gstin && !validateGstin(gstin)) (w.push(`GSTIN ${gstin} is not valid — left out`), (gstin = undefined));
    let phone = get(r, 'phone').replace(/[^\d+]/g, '').replace(/^(\+?91)(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
    if (phone && phone.length < 6) phone = '';
    // Balance: a signed amount, "1,200 Dr", separate Dr/Cr column, or Debit / Credit columns.
    let bal: number | null = null;
    if (m.debit != null || m.credit != null) {
      const dr = Math.abs(parseMoney(get(r, 'debit')) ?? 0);
      const cr = Math.abs(parseMoney(get(r, 'credit')) ?? 0);
      if (dr || cr) bal = dr - cr;
    }
    if (bal == null && m.balance != null) {
      bal = parseMoney(get(r, 'balance'));
      const dc = get(r, 'drcr');
      if (bal != null && /^cr/i.test(dc)) bal = -Math.abs(bal);
      if (bal != null && /^dr/i.test(dc)) bal = Math.abs(bal);
    }
    const kind = kindOf(get(r, 'type')) ?? groupKind ?? opts.defaultKind ?? null;
    if (!kind) w.push('Customer or supplier? Not stated');
    const st = get(r, 'state').toLowerCase().replace(/[^a-z ]/g, '').trim();
    const pin = get(r, 'pincode').replace(/\D/g, '');
    records.push({
      row, name: name.replace(/\s+/g, ' '), kind, warnings: w,
      gstin, phone: phone || undefined,
      address: get(r, 'address') || undefined,
      city: get(r, 'city') || undefined,
      pincode: /^\d{6}$/.test(pin) ? pin : undefined,
      stateCode: gstin ? gstin.slice(0, 2) : STATE_CODES[st],
      balance: bal ?? undefined,
      creditLimit: parseMoney(get(r, 'creditLimit')) ?? undefined,
      creditDays: parseQty(get(r, 'creditDays'))?.qty,
    });
  });
  return { records, skipped };
}
