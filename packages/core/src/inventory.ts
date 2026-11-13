import { type Paise, roundHalfUp, percentOf } from './money';

/* ───────────────────────────── Units ───────────────────────────── */

export interface UnitDef {
  name: string; // e.g. "Box"
  /** How many base units one of this unit holds. Base unit itself has factor 1. */
  factor: number;
  /** Optional explicit price per this unit (overrides base price × factor), in paise. */
  price?: Paise | null;
}

/** Round quantities to 3 decimals (grams for kg, ml for L). */
export const roundQty = (q: number) => Math.round(q * 1000) / 1000;

export function toBaseQty(qty: number, factor: number): number {
  return roundQty(qty * factor);
}

export function fromBaseQty(baseQty: number, factor: number): number {
  return roundQty(baseQty / factor);
}

/** Price for a unit: explicit override, else base price × factor. */
export function priceForUnit(basePrice: Paise, unit: Pick<UnitDef, 'factor' | 'price'>): Paise {
  if (unit.price != null && unit.price > 0) return unit.price;
  return roundHalfUp(basePrice * unit.factor);
}

/** Break a base quantity into the largest units: 145 pcs with Carton(48), Box(12) → "3 Carton 1 Pcs" */
export function describeQty(baseQty: number, baseUnit: string, units: UnitDef[]): string {
  const sorted = [...units].filter((u) => u.factor > 1).sort((a, b) => b.factor - a.factor);
  let rest = baseQty;
  const parts: string[] = [];
  for (const u of sorted) {
    const n = Math.floor(rest / u.factor);
    if (n > 0) {
      parts.push(`${n} ${u.name}`);
      rest = roundQty(rest - n * u.factor);
    }
  }
  if (rest !== 0 || parts.length === 0) parts.push(`${rest} ${baseUnit}`);
  return parts.join(' ');
}

/* ───────────────────────────── Pricing ───────────────────────────── */

export type PriceTier = 'mrp' | 'retail' | 'wholesale' | 'super';

export const PRICE_TIERS: Array<{ id: PriceTier; label: string }> = [
  { id: 'retail', label: 'Retail' },
  { id: 'wholesale', label: 'Wholesale' },
  { id: 'super', label: 'Super-stockist' },
  { id: 'mrp', label: 'MRP' },
];

export interface TierPrices {
  mrp: Paise;
  retail: Paise;
  wholesale?: Paise | null;
  super?: Paise | null;
}

/** Pick the price for a party's tier, falling back down the chain to retail then MRP. */
export function resolvePrice(prices: TierPrices, tier: PriceTier): { price: Paise; tier: PriceTier } {
  const chain: PriceTier[] =
    tier === 'super' ? ['super', 'wholesale', 'retail', 'mrp'] : tier === 'wholesale' ? ['wholesale', 'retail', 'mrp'] : tier === 'mrp' ? ['mrp', 'retail'] : ['retail', 'mrp'];
  for (const t of chain) {
    const p = prices[t];
    if (p != null && p > 0) return { price: p, tier: t };
  }
  return { price: 0, tier };
}

/** Margin % on selling price (both exclusive of tax). */
export function marginPct(sell: Paise, cost: Paise): number {
  if (sell <= 0) return 0;
  return Math.round(((sell - cost) / sell) * 10000) / 100;
}

/* ───────────────────────────── Schemes ───────────────────────────── */

export type Scheme =
  | { type: 'bxgy'; buy: number; free: number } // Buy 10 get 1 free (same item, in the billed unit)
  | { type: 'slab'; slabs: Array<{ minQty: number; discountPct: number }> }; // qty-based % off

export interface SchemeResult {
  freeQty: number;
  discountPct: number;
  label: string | null;
}

export function applyScheme(scheme: Scheme | null | undefined, qty: number): SchemeResult {
  if (!scheme) return { freeQty: 0, discountPct: 0, label: null };
  if (scheme.type === 'bxgy') {
    if (scheme.buy <= 0) return { freeQty: 0, discountPct: 0, label: null };
    const freeQty = Math.floor(qty / scheme.buy) * scheme.free;
    return { freeQty, discountPct: 0, label: freeQty > 0 ? `Buy ${scheme.buy} Get ${scheme.free} Free` : null };
  }
  const slab = [...scheme.slabs].sort((a, b) => b.minQty - a.minQty).find((s) => qty >= s.minQty);
  if (!slab) return { freeQty: 0, discountPct: 0, label: null };
  return { freeQty: 0, discountPct: slab.discountPct, label: `${slab.discountPct}% off on ${slab.minQty}+` };
}

export function describeScheme(scheme: Scheme | null | undefined): string | null {
  if (!scheme) return null;
  if (scheme.type === 'bxgy') return `Buy ${scheme.buy} Get ${scheme.free} Free`;
  return scheme.slabs.map((s) => `${s.minQty}+ → ${s.discountPct}%`).join(', ');
}

/** Cash discount on a bill amount (e.g. 2% CD for immediate payment). */
export const cashDiscount = (amount: Paise, pct: number) => percentOf(amount, pct);

/* ───────────────────────────── FIFO / batches ───────────────────────────── */

export interface BatchStock {
  id: number;
  qty: number; // base units on hand
  expiry: string | null; // ISO yyyy-mm-dd
  receivedAt: string; // ISO datetime
  cost: Paise; // per base unit, tax-exclusive
}

export interface Allocation {
  batchId: number;
  qty: number;
  cost: Paise;
}

/** Sort for FIFO: earliest expiry first (no-expiry last), then oldest received. */
export function fifoOrder<T extends Pick<BatchStock, 'expiry' | 'receivedAt' | 'id'>>(batches: T[]): T[] {
  return [...batches].sort((a, b) => {
    if (a.expiry !== b.expiry) {
      if (a.expiry == null) return 1;
      if (b.expiry == null) return -1;
      return a.expiry < b.expiry ? -1 : 1;
    }
    if (a.receivedAt !== b.receivedAt) return a.receivedAt < b.receivedAt ? -1 : 1;
    return a.id - b.id;
  });
}

/**
 * Allocate a sale quantity (base units) across batches FIFO. If `preferBatchId` is given it is used
 * first. Returns the shortfall when stock is insufficient — the caller decides whether negative stock
 * is allowed (it is pushed onto the last batch).
 */
export function allocateFifo(
  batches: BatchStock[],
  qty: number,
  opts: { preferBatchId?: number | null; skipExpired?: boolean; today?: string } = {},
): { allocations: Allocation[]; shortfall: number } {
  let pool = fifoOrder(batches.filter((b) => b.qty > 0));
  if (opts.skipExpired && opts.today) pool = pool.filter((b) => !b.expiry || b.expiry >= opts.today!);
  if (opts.preferBatchId != null) {
    const i = pool.findIndex((b) => b.id === opts.preferBatchId);
    if (i > 0) pool.unshift(...pool.splice(i, 1));
  }
  let need = roundQty(qty);
  const allocations: Allocation[] = [];
  for (const b of pool) {
    if (need <= 0) break;
    const take = roundQty(Math.min(b.qty, need));
    allocations.push({ batchId: b.id, qty: take, cost: b.cost });
    need = roundQty(need - take);
  }
  return { allocations, shortfall: need > 0 ? need : 0 };
}

export type ExpiryBucket = 'expired' | 'd30' | 'd90' | 'ok' | 'none';

export function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.UTC(+fromIso.slice(0, 4), +fromIso.slice(5, 7) - 1, +fromIso.slice(8, 10));
  const b = Date.UTC(+toIso.slice(0, 4), +toIso.slice(5, 7) - 1, +toIso.slice(8, 10));
  return Math.round((b - a) / 86400000);
}

export function expiryBucket(expiry: string | null | undefined, today: string): ExpiryBucket {
  if (!expiry) return 'none';
  const d = daysBetween(today, expiry);
  if (d < 0) return 'expired';
  if (d <= 30) return 'd30';
  if (d <= 90) return 'd90';
  return 'ok';
}

/** Weighted average cost of remaining stock. */
export function weightedCost(batches: Array<Pick<BatchStock, 'qty' | 'cost'>>): Paise {
  let q = 0;
  let v = 0;
  for (const b of batches) {
    if (b.qty <= 0) continue;
    q += b.qty;
    v += b.qty * b.cost;
  }
  return q > 0 ? roundHalfUp(v / q) : 0;
}
