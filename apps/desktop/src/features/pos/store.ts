import { priceForUnit, resolvePrice, roundQty, type PriceTier } from '@hisaab/core';
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

/** One open bill. The counter can have up to MAX_BILLS of these at the same time. */
export interface Bill {
  id: string;
  no: number; // tab label number
  lines: CartLine[];
  party: Party | null;
  selected: number;
  mode: PayMode;
  tendered: number;
  paidNow: number;
  billDiscountPct: number;
  otherCharges: number;
  notes: string;
  openedAt: number;
}

export const MAX_BILLS = 9;

let k = 0;
const uid = () => `${Date.now().toString(36)}-${(++k).toString(36)}`;
const blankBill = (no: number): Bill => ({
  id: uid(), no, lines: [], party: null, selected: -1, mode: 'cash', tendered: 0, paidNow: 0, billDiscountPct: 0, otherCharges: 0, notes: '', openedAt: Date.now(),
});

const tierOf = (p: Party | null): PriceTier => (p?.price_tier as PriceTier) ?? 'retail';

export function unitPrice(line: Pick<CartLine, 'prices' | 'units'>, unitName: string, tier: PriceTier): number {
  const unit = line.units.find((u) => u.name === unitName) ?? { name: unitName, factor: 1 };
  const base = resolvePrice(line.prices, tier);
  if (unit.factor === 1) return base.price;
  const override = base.tier === 'wholesale' || base.tier === 'super' ? unit.wholesale_price ?? unit.price : unit.price;
  return priceForUnit(base.price, { factor: unit.factor, price: override ?? null });
}

/* ───────── persistence (open bills survive a restart, per enterprise) ───────── */

let storageKey: string | null = null;
function save(bills: Bill[], active: number) {
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({ bills, active }));
  } catch {
    /* storage full or blocked — open bills just won't survive a restart */
  }
}
function restore(key: string): { bills: Bill[]; active: number } | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as { bills: Bill[]; active: number };
    if (!Array.isArray(v.bills) || !v.bills.length) return null;
    return { bills: v.bills.slice(0, MAX_BILLS), active: Math.min(v.active, v.bills.length - 1) };
  } catch {
    return null;
  }
}

interface PosState {
  bills: Bill[];
  active: number;
  /** Bind to an enterprise so each business keeps its own open bills. */
  attach: (enterpriseId: string | null) => void;
  reset: () => void;
  // tabs
  newBill: () => boolean;
  switchTo: (index: number) => void;
  next: () => void;
  closeBill: (index?: number) => void;
  // active bill
  add: (item: Item, opts?: { qty?: number; unit?: string; amount?: number }) => string;
  update: (index: number, patch: Partial<CartLine>) => void;
  setUnit: (index: number, unit: string) => void;
  remove: (index: number) => void;
  select: (i: number) => void;
  setParty: (p: Party | null) => void;
  setMode: (m: PayMode) => void;
  set: (patch: Partial<Pick<Bill, 'tendered' | 'paidNow' | 'billDiscountPct' | 'otherCharges' | 'notes'>>) => void;
  clear: () => void;
  /** After a bill is saved: close its tab if others are open, otherwise start fresh. */
  completed: () => void;
}

export const usePos = create<PosState>((set, get) => {
  /** Apply a change to the active bill and persist. */
  const patch = (fn: (b: Bill) => Partial<Bill>) =>
    set((s) => {
      const bills = s.bills.map((b, i) => (i === s.active ? { ...b, ...fn(b) } : b));
      save(bills, s.active);
      return { bills };
    });
  const setTabs = (bills: Bill[], active: number) => {
    save(bills, active);
    set({ bills, active });
  };
  const nextNo = (bills: Bill[]) => {
    for (let n = 1; n <= MAX_BILLS; n++) if (!bills.some((b) => b.no === n)) return n;
    return bills.length + 1;
  };

  return {
    bills: [blankBill(1)],
    active: 0,
    attach: (enterpriseId) => {
      const key = enterpriseId ? `hisaab.openBills.${enterpriseId}` : null;
      if (key === storageKey) return;
      storageKey = key;
      const r = key ? restore(key) : null;
      set(r ?? { bills: [blankBill(1)], active: 0 });
    },
    reset: () => {
      storageKey = null;
      set({ bills: [blankBill(1)], active: 0 });
    },
    newBill: () => {
      const { bills } = get();
      if (bills.length >= MAX_BILLS) return false;
      const all = [...bills, blankBill(nextNo(bills))];
      setTabs(all, all.length - 1);
      return true;
    },
    switchTo: (index) => {
      const { bills } = get();
      if (index >= 0 && index < bills.length) setTabs(bills, index);
    },
    next: () => {
      const { bills, active } = get();
      setTabs(bills, (active + 1) % bills.length);
    },
    closeBill: (index) => {
      const { bills, active } = get();
      const i = index ?? active;
      if (bills.length === 1) return setTabs([blankBill(1)], 0);
      const rest = bills.filter((_, j) => j !== i);
      setTabs(rest, Math.max(0, Math.min(i <= active ? active - 1 : active, rest.length - 1)));
    },
    add: (item, opts = {}) => {
      const s = get();
      const bill = s.bills[s.active];
      const unit = opts.unit ?? item.base_unit;
      const tier = tierOf(bill.party);
      const proto = { prices: { mrp: item.mrp, retail: item.retail_price, wholesale: item.wholesale_price, super: item.super_price }, units: item.units };
      const rate = unitPrice(proto, unit, tier);
      let qty = opts.qty ?? 1;
      if (opts.amount && rate > 0) qty = roundQty(opts.amount / rate);
      const factor = item.units.find((u) => u.name === unit)?.factor ?? 1;
      const existing = !item.is_loose ? bill.lines.findIndex((l) => l.itemId === item.id && l.unit === unit) : -1;
      if (existing >= 0) {
        const lines = [...bill.lines];
        const [l] = lines.splice(existing, 1);
        lines.unshift({ ...l, qty: roundQty(l.qty + qty) }); // move to top so the cashier sees the scan
        patch(() => ({ lines, selected: 0 }));
        return lines[0].key;
      }
      const line: CartLine = {
        key: uid(), itemId: item.id, name: item.name, baseUnit: item.base_unit, unit, factor, qty, rate, manualRate: false, discountPct: 0, batchId: null,
        batches: item.batches ?? [], stock: item.stock, mrp: item.mrp, isLoose: !!item.is_loose, hsn: item.hsn, gstRate: item.gst_rate, ...proto, schemeLabel: null,
      };
      patch((b) => ({ lines: [line, ...b.lines], selected: 0 }));
      return line.key;
    },
    update: (i, p) => patch((b) => ({ lines: b.lines.map((l, j) => (j === i ? { ...l, ...p } : l)) })),
    setUnit: (i, unit) =>
      patch((b) => ({
        lines: b.lines.map((l, j) => (j === i ? { ...l, unit, factor: l.units.find((u) => u.name === unit)?.factor ?? 1, rate: unitPrice(l, unit, tierOf(b.party)), manualRate: false } : l)),
      })),
    remove: (i) => patch((b) => ({ lines: b.lines.filter((_, j) => j !== i), selected: Math.min(b.selected, b.lines.length - 2) })),
    select: (i) => patch((b) => ({ selected: Math.max(-1, Math.min(i, b.lines.length - 1)) })),
    setParty: (party) =>
      patch((b) => ({
        party,
        mode: party && !party.is_walkin ? b.mode : b.mode === 'credit' ? 'cash' : b.mode,
        lines: b.lines.map((l) => (l.manualRate ? l : { ...l, rate: unitPrice(l, l.unit, tierOf(party)) })),
      })),
    setMode: (mode) => patch(() => ({ mode })),
    set: (p) => patch(() => p),
    clear: () => patch((b) => ({ ...blankBill(b.no), id: b.id })),
    completed: () => {
      const { bills, active } = get();
      const othersBusy = bills.some((b, i) => i !== active && b.lines.length > 0);
      if (bills.length > 1 && othersBusy) get().closeBill(active);
      else patch((b) => ({ ...blankBill(b.no), id: b.id }));
    },
  };
});

/** Convenience: the bill in the active tab. */
export const useActiveBill = () => usePos((s) => s.bills[s.active]);
