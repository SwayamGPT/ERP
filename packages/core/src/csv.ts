/** RFC-4180 CSV with a UTF-8 BOM so Excel opens ₹ and Hindi text correctly. */
export function toCsv(rows: Array<Record<string, unknown>>, columns?: Array<{ key: string; label: string }>): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]).map((k) => ({ key: k, label: k })) : []);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map((c) => esc(c.label)).join(',')];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c.key])).join(','));
  return '﻿' + lines.join('\r\n');
}
