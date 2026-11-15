/** Read a CSV or Excel (.xlsx) file into rows of cells, all as text. Runs on the device; nothing is uploaded. */
export async function readSheet(file: File): Promise<string[][]> {
  if (/\.xlsx$/i.test(file.name)) {
    const { default: readXlsx } = await import('read-excel-file');
    const rows = await readXlsx(file);
    return rows.map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toISOString().slice(0, 10) : String(c).trim())));
  }
  if (/\.xls$/i.test(file.name)) throw new Error('Old .xls files are not supported. Save it as .xlsx or CSV and try again.');
  return parseCsv(await file.text());
}

/** RFC 4180-ish CSV: quotes, escaped quotes, commas/newlines inside quotes, ; or tab separators. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.slice(0, t.indexOf('\n') >>> 0);
  const sep = [',', ';', '\t'].map((s) => [s, firstLine.split(s).length] as const).sort((a, b) => b[1] - a[1])[0][0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (q) {
      if (ch === '"' && t[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) row.push(cell.trim()), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cell.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** Find the header row and map wanted fields to column indexes by common header names. */
export function guessColumns<K extends string>(rows: string[][], wanted: Record<K, RegExp>): { header: number; cols: Partial<Record<K, number>> } {
  let best = { header: 0, cols: {} as Partial<Record<K, number>>, score: -1 };
  rows.slice(0, 15).forEach((r, i) => {
    const cols: Partial<Record<K, number>> = {};
    for (const k of Object.keys(wanted) as K[]) {
      const idx = r.findIndex((c) => wanted[k].test(c.toLowerCase()));
      if (idx >= 0 && !Object.values(cols).includes(idx)) cols[k] = idx;
    }
    const score = Object.keys(cols).length;
    if (score > best.score) best = { header: i, cols, score };
  });
  return { header: best.header, cols: best.cols };
}

/** "1,234.50" / "₹ 1234.5" / "(120.00)" → paise. */
export function toPaiseLoose(s: string | undefined): number | undefined {
  if (s == null || s.trim() === '') return undefined;
  const neg = /^\(.*\)$/.test(s.trim()) || /-/.test(s);
  const n = Number(s.replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * 100) * (neg ? -1 : 1);
}

/** dd/mm/yyyy, dd-mm-yy, yyyy-mm-dd, "12 Nov 2026" → yyyy-mm-dd. */
export function toIsoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const v = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(v);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
