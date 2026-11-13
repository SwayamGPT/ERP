import { formatINR } from '@hisaab/core';

export const inr = (p: number | null | undefined, decimals = true) => formatINR(p ?? 0, { decimals });
export const rupees = (p: number | null | undefined) => ((p ?? 0) / 100).toFixed(2);
/** User-entered rupee text → paise */
export { toPaise } from '@hisaab/core';

const dShort = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short' });
const dLong = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const tShort = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' });

const parse = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso.replace(' ', 'T'));
export const fmtDate = (iso?: string | null) => (iso ? dLong.format(parse(iso)) : '—');
export const fmtDay = (iso?: string | null) => (iso ? dShort.format(parse(iso)) : '—');
export const fmtTime = (iso?: string | null) => (iso ? tShort.format(parse(iso)) : '');
export const fmtQty = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function shiftDate(iso: string, days: number) {
  const d = parse(iso);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const monthStart = (iso = today()) => `${iso.slice(0, 7)}-01`;
export const thisMonth = () => today().slice(0, 7);
export function prevMonth(ym = thisMonth()) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
export function relative(iso: string) {
  const days = Math.round((parse(today()).getTime() - parse(iso.slice(0, 10)).getTime()) / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 0) return `in ${-days}d`;
  return `${days}d ago`;
}
