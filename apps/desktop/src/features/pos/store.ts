import { priceForUnit, resolvePrice, roundHalfUp, roundQty, type PriceTier } from '@hisaab/core';
import { create } from 'zustand';
import type { Batch, Item, ItemUnit, Party } from '../../db/types';

export interface CartLine {
  key: string;
  itemId: number;
  name: string;
  baseUnit: string;
  units: ItemUnit[];
  unit: string;
  factor: number;
  qty: number;
  rate: number; // paise per selected unit
  manualRate: boolean;
  discountPct: number;
  batchId: number | null;
  batches: Batch[];
  stock: number;
  mrp: number;
  isLoose: boolean;
  hsn: string | null;
  gstRate: number;
  prices: { mrp: number; retail: number; wholesale: number | null; super: number | null };
  schemeLabel: string | null;
}

export type PayMode = 'cash' | 'upi' | 'card' | 'credit';

interface PosState {
  lines: CartLine[];
  party: Party | null;
  selected: number; // index
  mode: PayMode;
  tendered: number; // paise, cash given by customer
  paidNow: number; // for credit bills: amount paid now
  billDiscountPct: number;
  otherCharges: number;
  notes: string;
  add: (item: Item, opts?: { qty?: number; unit?: string; amount?: number; merge?: boolean }) => number;
  update: (index: number, patch: Partial<CartLine>) => void;
  setUnit: (index: number, unit: string) => void;
  remove: (index: number) => void;
  select: (i: number) => void;
  setParty: (p: Party | null) => void;
  setMode: (m: PayMode) => void;
  set: (patch: Partial<Pick<PosState, 'tendered' | 'paidNow' | 'billDiscountPct' | 'otherCharges' | 'notes'>>) => void;
  clear: () => void;
  load: (snapshot: PosSnapshot) => void;
  snapshot: () => PosSnapshot;
}

export type PosSnapshot = Pick<PosState, 'lines' | 'party' | 'mode' | 'billDiscountPct' | 'otherCharges' | 'notes'>;

const tierOf = (p: Party | null): PriceTier => (p?.price_tier as PriceTier) ?? 'retail';

export function unitPrice(line: Pick<CartLine, 'prices' | 'units'>, unitName: string, tier: PriceTier): number {
  const unit = line.units.find((u) => u.name === unitName) ?? { name: unitName, factor: 1 };
  const base = resolvePrice(line.prices, tier);
  if (unit.factor === 1) return base.price;
  const override = base.tier === 'wholesale' || base.tier === 'super' ? unit.wholesale_price ?? unit.price : unit.price;
  return priceForUnit(base.price, { factor: unit.factor, price: override ?? null });
}

let k = 0;
const initial = { lines: [] as CartLine[], party: null, selected: -1, mode: 'cash' as PayMode, tendered: 0, paidNow: 0, billDiscountPct: 0, otherCharges: 0, notes: '' };

export const usePos = create<PosState>((set, get) => ({
  ...initial,
  add: (item, opts = {}) => {
    const s = get();
    const unit = opts.unit ?? item.base_unit;
    const tier = tierOf(s.party);
    const proto = {
      prices: { mrp: item.mrp, retail: item.retail_price, wholesale: item.wholesale_price, super: item.super_price },
      units: item.units,
    };
    const rate = unitPrice(proto, unit, tier);
    let qty = opts.qty ?? 1;
    if (opts.amount && rate > 0) qty = roundQty(opts.amount / rate);
    const factor = item.units.find((u) => u.name === unit)?.factor ?? 1;
    const existing = opts.merge !== false && !item.is_loose ? s.lines.findIndex((l) => l.itemId === item.id && l.unit === unit) : -1;
    if (existing >= 0) {
      const lines = [...s.lines];
      lines[existing] = { ...lines[existing], qty: roundQty(lines[existing].qty + qty) };
      // move to top so the cashier sees what was just scanned
      const [l] = lines.splice(existing, 1);
      lines.unshift(l);
      set({ lines, selected: 0 });
      return 0;
    }
    const line: CartLine = {
      key: `l${++k}`,
      itemId: item.id,
      name: item.name,
      baseUnit: item.base_unit,
      unit,
      factor,
      qty,
      rate,
      manualRate: false,
      discountPct: 0,
      batchId: null,
      batches: item.batches ?? [],
      stock: item.stock,
      mrp: item.mrp,
      isLoose: !!item.is_loose,
      hsn: item.hsn,
      gstRate: item.gst_rate,
      ...proto,
      schemeLabel: null,
    };
    set({ lines: [line, ...s.lines], selected: 0 });
    return 0;
  },
  update: (i, patch) => set((s) => ({ lines: s.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) })),
  setUnit: (i, unit) =>
    set((s) => ({
      lines: s.lines.map((l, j) => (j === i ? { ...l, unit, factor: l.units.find((u) => u.name === unit)?.factor ?? 1, rate: unitPrice(l, unit, tierOf(s.party)), manualRate: false } : l)),
    })),
  remove: (i) => set((s) => ({ lines: s.lines.filter((_, j) => j !== i), selected: Math.min(s.selected, s.lines.length - 2) })),
  select: (i) => set((s) => ({ selected: Math.max(-1, Math.min(i, s.lines.length - 1)) })),
  setParty: (party) =>
    set((s) => ({
      party,
      mode: party && !party.is_walkin ? s.mode : s.mode === 'credit' ? 'cash' : s.mode,
      lines: s.lines.map((l) => (l.manualRate ? l : { ...l, rate: unitPrice(l, l.unit, tierOf(party)) })),
    })),
  setMode: (mode) => set({ mode }),
  set: (patch) => set(patch),
  clear: () => set({ ...initial }),
  load: (snap) => set({ ...initial, ...snap, selected: snap.lines.length ? 0 : -1 }),
  snapshot: () => {
    const s = get();
    return { lines: s.lines, party: s.party, mode: s.mode, billDiscountPct: s.billDiscountPct, otherCharges: s.otherCharges, notes: s.notes };
  },
}));

export const lineAmountGuess = (l: CartLine) => roundHalfUp(l.qty * l.rate * (1 - l.discountPct / 100));
