/** Due-date rules for repeating expenses. Pure, so the screens preview exactly what the database will create. */

export type Every = 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface Schedule {
  anchor_date: string;
  every: Every;
  end_date: string | null;
  every_n?: number;
  skip_weekdays?: string | null;
}

export interface ClosedDays {
  from_date: string;
  to_date: string;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function addMonthsClamped(iso: string, n: number, day: number): string {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  return `${yy}-${String(mm + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

/** k-th step of a schedule (k = 0 is the anchor date). Month-ends clamp (31 Jan → 28 Feb). */
export function occurrence(anchor: string, every: Every, k: number, n = 1): string {
  if (every === 'day') return addDays(anchor, k * n);
  if (every === 'week') return addDays(anchor, 7 * k * n);
  const day = +anchor.slice(8, 10);
  return addMonthsClamped(anchor, k * n * (every === 'month' ? 1 : every === 'quarter' ? 3 : 12), day);
}

const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** Is this date off for the schedule: a skipped weekday or inside a closed-days range? */
export function isOff(r: Schedule, skips: ClosedDays[], date: string): boolean {
  if (r.skip_weekdays && r.skip_weekdays.split(',').includes(String(weekday(date)))) return true;
  return skips.some((x) => date >= x.from_date && date <= x.to_date);
}

/** Due dates of a schedule between from and to (inclusive), oldest first. */
export function dueDates(r: Schedule, skips: ClosedDays[], from: string, to: string, limit = 5000): string[] {
  const out: string[] = [];
  const n = Math.max(1, r.every_n ?? 1);
  // Jump close to `from` instead of stepping from the anchor every time (daily schedules run for years).
  let k = 0;
  if (from > r.anchor_date && (r.every === 'day' || r.every === 'week')) {
    const days = Math.floor((Date.parse(from) - Date.parse(r.anchor_date)) / 86_400_000);
    k = Math.max(0, Math.floor(days / ((r.every === 'week' ? 7 : 1) * n)) - 1);
  }
  for (let i = 0; i < 100_000 && out.length < limit; i++, k++) {
    const d = occurrence(r.anchor_date, r.every, k, n);
    if (d > to || (r.end_date && d > r.end_date)) break;
    if (d < from || isOff(r, skips, d)) continue;
    out.push(d);
  }
  return out;
}

