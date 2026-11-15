import { CASHIER_DISCOUNT_CAP, describeScheme, expiryBucket, formatINR, roundQty } from '@hisaab/core';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ClipboardList,
  Banknote,
  CircleUserRound,
  CreditCard,
  Minus,
  NotebookPen,
  PackageSearch,
  Percent,
  Plus,
  Printer,
  ScanBarcode,
  Send,
  Smartphone,
  Split,
  Trash2,
  X,
  Pencil,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { printInvoice } from '../../components/print/PrintInvoice';
import { UpiQr } from '../../components/UpiQr';
import { Badge, Button, ConfirmDialog, Dialog, Input, Kbd, MoneyInput, Segmented, toast } from '../../components/ui';
import { ApiError, call } from '../../db/client';
import type { DraftInvoice, Invoice, Item } from '../../db/types';
import { cn } from '../../lib/cn';
import { fmtQty, inr, today } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { useT } from '../../lib/i18n';
import { useCan } from '../../lib/perm';
import { billMessage, upiLink, whatsappLink } from '../../lib/share';
import { useApi } from '../../lib/useApi';
import { CustomerPicker } from './CustomerPicker';
import { MAX_BILLS, pickParty, usePos, type CartLine, type PayMode } from './store';
import { BillTabs } from './BillTabs';
import { TaxBreakup } from './TaxBreakup';
import { ServedBy } from './ServedBy';
import { OrdersButton } from './OrdersDrawer';
import { CounterTools, displayThanks, useCustomerDisplay } from './CounterTools';

export function PosPage() {
  const t = useT();
  const canDo = useCan();
  const pos = usePos();
  const bill = pos.bills[pos.active];
  const { lines, party, mode, selected } = bill;
  const company = useApi('app.status').data?.company;
  const searchRef = useRef<HTMLInputElement>(null);
  const qtyRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const tenderRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [closeAsk, setCloseAsk] = useState<number | null>(null);
  const [buyOutside, setBuyOutside] = useState<number | null>(null);
  const [discOpen, setDiscOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creditConfirm, setCreditConfirm] = useState<null | { print: boolean }>(null);
  const [last, setLast] = useState<Invoice | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const anyDialog = pickCustomer || closeAsk !== null || discOpen || clearOpen || !!creditConfirm;

  const focusSearch = () => setTimeout(() => searchRef.current?.focus(), 0);
  useEffect(() => { focusSearch(); }, []);

  // ── search
  const [dq, setDq] = useState('');
  useEffect(() => {
    const h = setTimeout(() => setDq(q), /^\d+$/.test(q) ? 0 : 60);
    return () => clearTimeout(h);
  }, [q]);
  const search = useQuery({
    queryKey: ['items.search', dq],
    queryFn: () => call('items.search', { q: dq }),
    enabled: dq.trim().length > 0,
    placeholderData: keepPreviousData,
  });
  const results = q.trim() ? search.data?.items ?? [] : [];
  useEffect(() => setHl(0), [dq]);

  // ── live, authoritative totals from the same engine that saves the bill
  const draft: DraftInvoice = useMemo(
    () => ({
      kind: 'sale',
      partyId: party?.id ?? null,
      billDiscountPct: bill.billDiscountPct,
      otherCharges: bill.otherCharges,
      couponCode: bill.couponCode?.trim() || null,
      redeemPoints: bill.redeemPoints || null,
      lines: lines.filter((l) => l.qty > 0).map((l) => ({ itemId: l.itemId, unit: l.unit, factor: l.factor, qty: l.qty, rate: l.rate, discountPct: l.discountPct, batchId: l.batchId })),
    }),
    [lines, party?.id, bill.billDiscountPct, bill.otherCharges, bill.couponCode, bill.redeemPoints],
  );
  const loyalty = useApi('loyalty.get', { partyId: party?.id ?? 0 }, { enabled: !!party && !party.is_walkin }).data;
  const preview = useQuery({
    queryKey: ['invoices.preview', draft],
    queryFn: () => call('invoices.preview', draft),
    enabled: draft.lines.length > 0,
    placeholderData: keepPreviousData,
  });
  useCustomerDisplay(company, lines, preview.data?.totals.payable ?? 0, preview.data?.totals.discount ?? 0);
  const promo = preview.data?.promo;
  const pv = draft.lines.length ? preview.data : undefined;
  const totals = pv?.totals;
  const payable = totals?.payable ?? 0;
  const livePayable = payable;
  const lineCalc = useMemo(() => {
    const m = new Map<string, NonNullable<typeof pv>['lines'][number]>();
    let j = 0;
    lines.forEach((l) => {
      if (l.qty > 0 && pv?.lines[j]) m.set(l.key, pv.lines[j++]);
    });
    return m;
  }, [lines, pv]);

  const addItem = (item: Item, opts: { qty?: number; amount?: number; fromScan?: boolean } = {}) => {
    const key = pos.add(item, { qty: opts.qty, amount: opts.amount });
    setQ('');
    setFlashKey(key);
    if (item.stock <= 0) toast.info(`${item.name} shows no stock`, 'Billing anyway — stock will go negative.');
    if (opts.fromScan || opts.qty || opts.amount) focusSearch();
    else setTimeout(() => qtyRefs.current[key]?.select(), 0);
  };

  const onSearchKey = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setHl((h) => Math.min(h + 1, results.length - 1)));
    else if (e.key === 'ArrowUp') (e.preventDefault(), setHl((h) => Math.max(h - 1, 0)));
    else if (e.key === 'Enter') {
      e.preventDefault();
      const term = e.currentTarget.value.trim(); // what is in the box now, even if state lags behind
      if (!term) {
        if (lines.length) tenderRef.current?.focus();
        return;
      }
      // Barcode scanners type fast and press Enter — resolve immediately, don't wait for debounce.
      // Only reuse the list on screen if it is for exactly this text (not the previous search still showing).
      const fresh = dq === term && search.data && !search.isFetching && !search.isPlaceholderData;
      const r = fresh ? search.data! : await call('items.search', { q: term });
      if (!r.items.length) {
        toast.error(`No item found for "${term}"`);
        return;
      }
      const item = r.items[fresh ? hl : 0] ?? r.items[0];
      if (r.scale && r.scale.itemId === item.id) addItem(item, { qty: r.scale.qty, amount: r.scale.amount, fromScan: true });
      else addItem(item, { fromScan: /^\d{8,14}$/.test(term) });
    } else if (e.key === 'Escape') {
      if (q) (e.stopPropagation(), setQ(''));
    }
  };

  // ── save
  const save = async (print: boolean, override = false) => {
    if (!draft.lines.length || saving) return;
    if (mode === 'credit' && (!party || party.is_walkin)) {
      toast.info('Pick the customer for udhaar', 'Press F7 or click Customer.');
      setPickCustomer(true);
      return;
    }
    setSaving(true);
    try {
      // A fast F9 right after a scan can come before the live total caught up: use the bill's real total.
      const payable = preview.isFetching || preview.isPlaceholderData || !preview.data ? (await preview.refetch()).data?.totals.payable ?? 0 : livePayable;
      let payments: Array<{ mode: 'cash' | 'upi' | 'card'; amount: number }>;
      if (mode === 'credit') payments = [{ mode: bill.paidNowMode ?? 'cash', amount: Math.min(bill.paidNow, payable) }];
      else if (mode === 'split') {
        const cash = Math.min(bill.splitCash ?? 0, payable);
        payments = [{ mode: 'cash', amount: cash }, { mode: bill.splitOther ?? 'upi', amount: payable - cash }];
      } else payments = [{ mode, amount: payable }];
      payments = payments.filter((p) => p.amount > 0);
      const full = {
        ...draft,
        notes: bill.notes || undefined,
        servedBy: company?.billing_staff_mode === 'optional' ? bill.servedBy?.id ?? null : null,
        orderId: bill.orderId ?? null,
        payments,
        overrideCreditLimit: override,
      };
      const edited = bill.editId;
      const inv = edited ? await call('invoices.update', { id: edited, draft: { ...full, orderId: null } }) : await call('invoices.create', full);
      setLast(inv);
      displayThanks(company, inv.total, mode === 'cash' && bill.tendered > inv.total ? bill.tendered - inv.total : 0);
      pos.completed();
      setAdvanced(false);
      toast.success(`Bill ${inv.number} ${edited ? 'updated' : 'saved'} · ${formatINR(inv.total)}`, mode === 'cash' && bill.tendered > inv.total ? `Return change ${formatINR(bill.tendered - inv.total)}` : undefined);
      if (print && company) printInvoice(inv, company);
      focusSearch();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CREDIT_LIMIT' && canDo('discount.any')) setCreditConfirm({ print });
      else if (e instanceof ApiError && e.code === 'WALKIN_CREDIT') setPickCustomer(true), toast.error(e);
      else toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  // ── multiple bills at once
  const newBill = () => {
    if (!pos.newBill()) return toast.info(`Up to ${MAX_BILLS} bills can be open at once`, 'Save or close one first.');
    setQ('');
    focusSearch();
  };
  const switchBill = (i: number) => {
    pos.switchTo(i);
    setQ('');
    focusSearch();
  };
  const askClose = (i: number) => (pos.bills[i].lines.length ? setCloseAsk(i) : (pos.closeBill(i), focusSearch()));

  const setPay = (m: PayMode) => {
    pos.setMode(m);
    if (m === 'cash') setTimeout(() => tenderRef.current?.select(), 0);
    if (m === 'credit' && (!party || party.is_walkin)) setPickCustomer(true);
  };

  const sel = lines[selected];
  useHotkeys(
    {
      F1: focusSearch,
      F2: newBill,
      F3: () => (pos.bills.length > 1 ? switchBill((pos.active + 1) % pos.bills.length) : newBill()),
      'alt+x': () => askClose(pos.active),
      ...Object.fromEntries(Array.from({ length: MAX_BILLS }, (_, i) => [`alt+${i + 1}`, () => switchBill(i)])),
      F4: () => setPay('cash'),
      F5: () => setPay('upi'),
      F6: () => setPay('credit'),
      F7: () => setPickCustomer(true),
      F8: () => setDiscOpen(true),
      F9: () => void save(true),
      F10: () => void save(false),
      Escape: () => (q ? setQ('') : lines.length ? setClearOpen(true) : undefined),
      'mod+ArrowDown': () => pos.select(selected + 1),
      'mod+ArrowUp': () => pos.select(selected - 1),
      '+': () => sel && pos.update(selected, { qty: sel.qty + 1 }),
      '-': () => sel && sel.qty > 1 && pos.update(selected, { qty: sel.qty - 1 }),
      Delete: () => sel && pos.remove(selected),
    },
    !anyDialog,
  );

  const change = mode === 'cash' && bill.tendered > payable ? bill.tendered - payable : 0;
  const totalQty = lines.reduce((s, l) => s + (l.isLoose ? 1 : l.qty), 0);
  const balance = party && !party.is_walkin ? party.balance : 0;
  const overLimit = party && party.credit_limit > 0 && mode === 'credit' && balance + payable - bill.paidNow > party.credit_limit;

  return (
    <div className="flex h-full">
      {/* ────────── Left: search + cart ────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-end bg-surface-2/60">
          <div className="min-w-0 flex-1">
            <BillTabs onNew={newBill} onSwitch={switchBill} onClose={askClose} />
          </div>
          {canDo('order.view') && <OrdersButton />}
        </div>
        {bill.editNumber && (
          <div className="flex items-center gap-2 border-b border-border bg-warn/10 px-5 py-1.5 text-xs text-warn" data-testid="bill-editing">
            <Pencil className="h-3.5 w-3.5" /> Editing bill {bill.editNumber}. Saving replaces it (same number); stock, accounts and payments are corrected.
            <button className="ml-auto underline" onClick={() => (pos.closeBill(pos.active), focusSearch())}>Stop editing</button>
          </div>
        )}
        {bill.orderNumber && (
          <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-5 py-1.5 text-xs text-primary" data-testid="bill-from-order">
            <ClipboardList className="h-3.5 w-3.5" /> Billing order {bill.orderNumber}. Saving marks it billed.
          </div>
        )}
        <div className="relative border-b border-border bg-surface px-5 py-3">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <ScanBarcode className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-primary" />
              <input
                ref={searchRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={t('pos.search')}
                className="h-12 w-full rounded-xl border-2 border-primary/30 bg-surface pl-11 pr-20 text-[15px] outline-none transition focus:border-primary focus:ring-4 focus:ring-primary/10"
                data-testid="pos-search"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="absolute right-3 top-1/2 flex -translate-y-1/2 gap-1"><Kbd>F1</Kbd></span>
              {results.length > 0 && (
                <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-30 overflow-hidden rounded-xl border border-border bg-surface shadow-pop animate-pop" data-testid="pos-results">
                  {results.map((it, i) => {
                    const exp = it.batches?.find((b) => b.qty > 0)?.expiry;
                    const bucket = expiryBucket(exp, today());
                    return (
                      <button
                        key={it.id}
                        onMouseEnter={() => setHl(i)}
                        onClick={() => addItem(it)}
                        className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left', i === hl ? 'bg-primary-soft' : 'hover:bg-surface-2')}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{it.name}</span>
                          <span className="flex items-center gap-2 text-xs text-muted">
                            {it.short_code && <span className="font-mono">{it.short_code}</span>}
                            {it.barcode && <span className="font-mono">{it.barcode}</span>}
                            {it.scheme && <Badge tone="saffron">{describeScheme(it.scheme)}</Badge>}
                            {(bucket === 'd30' || bucket === 'expired') && <Badge tone={bucket === 'expired' ? 'bad' : 'warn'}>exp {exp}</Badge>}
                          </span>
                        </span>
                        <span className={cn('text-xs tnum', it.stock <= 0 ? 'text-bad' : 'text-muted')}>
                          {fmtQty(it.stock)} {it.base_unit}
                        </span>
                        <span className="w-24 text-right text-sm font-semibold tnum">
                          {inr(it.retail_price)}
                          {it.mrp > it.retail_price && <span className="block text-[10px] font-normal text-faint line-through">{inr(it.mrp)}</span>}
                        </span>
                        {i === hl && <Kbd>Enter</Kbd>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            <button
              onClick={() => setPickCustomer(true)}
              className={cn('flex h-12 min-w-[220px] items-center gap-2.5 rounded-xl border px-3 text-left transition hover:border-primary/50', party && !party.is_walkin ? 'border-primary/40 bg-primary-soft/50' : 'border-border')}
              data-testid="pos-customer"
            >
              <CircleUserRound className="h-5 w-5 shrink-0 text-primary" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{party && !party.is_walkin ? party.name : t('pos.walkin')}</span>
                <span className="block truncate text-[11px] text-muted">
                  {party && !party.is_walkin ? (
                    <>
                      {party.price_tier !== 'retail' && <span className="font-medium capitalize text-primary">{party.price_tier} rate · </span>}
                      {balance > 0 ? `Due ${inr(balance)}` : balance < 0 ? `Advance ${inr(-balance)}` : 'No dues'}
                    </>
                  ) : (
                    'Cash / UPI · retail price'
                  )}
                </span>
              </span>
              <Kbd>F7</Kbd>
            </button>
            {company?.billing_staff_mode === 'optional' && <ServedBy />}
          </div>
        </div>

        {/* cart */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
          {lines.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-primary">
                <PackageSearch className="h-8 w-8" />
              </div>
              <p className="text-base font-medium">{t('pos.empty')}</p>
              <p className="mt-1 max-w-md text-sm text-muted">Type a few letters of the name, a short code like <span className="font-mono">SUG</span>, or scan the barcode. Weighing-scale stickers work too.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-3 text-xs text-muted">
                {[['Enter', 'add & set qty'], ['F2', 'new bill'], ['F3', 'next bill'], ['F4', 'cash'], ['F5', 'UPI'], ['F9', 'save & print']].map(([k, d]) => (
                  <span key={k} className="flex items-center gap-1.5"><Kbd>{k}</Kbd> {d}</span>
                ))}
              </div>
              {last && <LastBill inv={last} />}
            </div>
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th className="w-full min-w-[240px]">Item</th>
                  <th className="whitespace-nowrap">Unit</th>
                  <th className="text-center">Qty</th>
                  <th className="text-right">Rate</th>
                  <th className="whitespace-nowrap text-right">Disc%</th>
                  <th className="text-right">Amount</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody data-testid="cart">
                {lines.map((l, i) => {
                  const c = lineCalc.get(l.key);
                  const batch = l.batches.find((b) => b.id === l.batchId) ?? l.batches.find((b) => b.qty > 0 && (!b.expiry || b.expiry >= today())) ?? l.batches.find((b) => b.qty > 0);
                  const bucket = expiryBucket(batch?.expiry, today());
                  const short = l.stock < l.qty * l.factor;
                  return (
                    <tr key={l.key} onClick={() => pos.select(i)} className={cn('cursor-default', i === selected && 'bg-primary-soft/40 hover:bg-primary-soft/50', flashKey === l.key && 'animate-flash')} onAnimationEnd={() => setFlashKey(null)}>
                      <td className="text-xs text-faint">{lines.length - i}</td>
                      <td>
                        <div className="font-medium">{l.name}</div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <Badge tone="primary" className="tnum">GST {c?.gstRate ?? l.gstRate}%</Badge>
                          {l.mrp > 0 && <span>MRP {inr(l.mrp * l.factor)}</span>}
                          {batch?.batch_no && (
                            <BatchChip line={l} index={i} bucket={bucket} />
                          )}
                          {!batch?.batch_no && (bucket === 'd30' || bucket === 'expired') && <Badge tone={bucket === 'expired' ? 'bad' : 'warn'}>exp {batch?.expiry}</Badge>}
                          {c?.scheme && <Badge tone="saffron">{c.scheme}</Badge>}
                          {!!c?.freeQty && <Badge tone="good">+{fmtQty(c.freeQty)} free</Badge>}
                          {short && <Badge tone="bad">only {fmtQty(l.stock)} in stock</Badge>}
                          {short && canDo('purchase.create') && (
                            <button type="button" className="text-[11px] font-medium text-primary hover:underline" onClick={() => setBuyOutside(i)} data-testid="line-buy-outside">Bought outside?</button>
                          )}
                        </div>
                      </td>
                      <td>
                        {l.units.length > 1 ? (
                          <select value={l.unit} onChange={(e) => pos.setUnit(i, e.target.value)} className="input h-8 min-w-[96px] px-2 text-xs" data-testid="line-unit">
                            {l.units.map((u) => (
                              <option key={u.name} value={u.name}>{u.name}</option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-xs text-muted">{l.unit}</span>
                        )}
                      </td>
                      <td>
                        <div className="flex items-center justify-center gap-1">
                          <button className="hidden h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 2xl:grid" onClick={() => l.qty > (l.isLoose ? 0.05 : 1) && pos.update(i, { qty: +(l.qty - (l.isLoose ? 0.25 : 1)).toFixed(3) })} tabIndex={-1} aria-label="Less">
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <QtyInput
                            inputRef={(el) => (qtyRefs.current[l.key] = el)}
                            value={l.qty}
                            onChange={(v) => pos.update(i, { qty: v })}
                            onFocus={() => pos.select(i)}
                            onEnter={focusSearch}
                          />
                          <button className="hidden h-7 w-7 place-items-center rounded-md text-muted hover:bg-surface-2 2xl:grid" onClick={() => pos.update(i, { qty: +(l.qty + (l.isLoose ? 0.25 : 1)).toFixed(3) })} tabIndex={-1} aria-label="More">
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                      <td className="text-right">
                        <RateInput value={l.rate} onChange={(r) => pos.update(i, { rate: r, manualRate: true })} onEnter={focusSearch} />
                      </td>
                      <td className="text-right">
                        <input
                          value={l.discountPct || ''}
                          onChange={(e) => pos.update(i, { discountPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), focusSearch())}
                          placeholder="0"
                          inputMode="decimal"
                          className="input h-8 w-12 px-1.5 text-right tnum"
                        />
                      </td>
                      <td className="whitespace-nowrap text-right tnum">
                        <div className="font-semibold">{c ? inr(c.total) : '—'}</div>
                        {c && <div className="text-[11px] text-muted" data-testid="line-tax">{c.taxInclusive ? 'incl.' : '+'} GST {inr(c.tax)}</div>}
                        {c?.belowCost && <div className="text-[11px] font-semibold text-bad" data-testid="line-loss">{c.loss != null ? `Loss ${inr(c.loss)}` : 'Below cost'}</div>}
                      </td>
                      <td>
                        <button onClick={() => pos.remove(i)} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" tabIndex={-1} aria-label="Remove">
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* footer strip */}
        <div className="flex items-center gap-4 border-t border-border bg-surface px-5 py-2.5 text-xs text-muted">
          <span><b className="text-ink">{lines.length}</b> items · <b className="text-ink">{fmtQty(totalQty)}</b> qty</span>
          {totals && totals.discount > 0 && <span>Saved <b className="text-good">{inr(totals.discount)}</b></span>}
          <button onClick={() => setAdvanced(!advanced)} className="flex items-center gap-1 hover:text-ink">
            <NotebookPen className="h-3.5 w-3.5" /> {advanced ? 'Hide' : 'Advanced'}: coupon, points, charges, note
          </button>
          {advanced && (
            <div className="flex flex-1 flex-wrap items-center gap-2">
              <Input className="w-32 font-mono uppercase" placeholder="Coupon" value={bill.couponCode ?? ''} onChange={(e) => pos.set({ couponCode: e.target.value.toUpperCase() })} data-testid="pos-coupon" />
              {loyalty?.enabled && party && !party.is_walkin && (
                <span className="flex items-center gap-1" title={`${loyalty.points} points available, worth ${inr(loyalty.worth)}`}>
                  Points <Input className="w-20" type="number" min={0} max={loyalty.points} value={bill.redeemPoints || ''} placeholder={String(loyalty.points)} onChange={(e) => pos.set({ redeemPoints: Math.min(loyalty.points, Number(e.target.value) || 0) })} data-testid="pos-points" />
                </span>
              )}
              <span>Other charges</span>
              <MoneyInput className="w-28" value={bill.otherCharges} onChange={(v) => pos.set({ otherCharges: v })} />
              <Input className="flex-1" placeholder="Note on bill (e.g. home delivery)" value={bill.notes} onChange={(e) => pos.set({ notes: e.target.value })} />
            </div>
          )}
          <span className="flex-1" />
          <CounterTools />
          <Button size="sm" variant="ghost" kbd="Esc" icon={<Trash2 className="h-4 w-4" />} onClick={() => setClearOpen(true)} disabled={!lines.length}>
            {t('pos.clear')}
          </Button>
        </div>
      </div>

      {/* ────────── Right: totals + payment ────────── */}
      <aside className="flex w-[360px] shrink-0 flex-col border-l border-border bg-surface xl:w-[400px]">
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-1.5 text-sm">
            <Line k="Items total" v={inr(totals?.gross ?? 0)} />
            {!!totals?.discount && <Line k={`Discount${bill.billDiscountPct ? ` (bill ${bill.billDiscountPct}%)` : ''}`} v={`−${inr(totals.discount)}`} tone="good" />}
            {!!promo?.couponAmount && <Line k={`↳ incl. coupon ${promo.couponCode}`} v={`−${inr(promo.couponAmount)}`} muted />}
            {!!promo?.pointsAmount && <Line k={`↳ incl. ${promo.points} points`} v={`−${inr(promo.pointsAmount)}`} muted />}
            {(bill.couponCode || bill.redeemPoints) && preview.error && <p className="text-xs text-bad" data-testid="pos-promo-error">{preview.error.message}</p>}
            <Line k="Taxable value" v={inr(totals?.taxable ?? 0)} muted />
            <Line k="Total GST" v={inr(totals?.tax ?? 0)} />
            {!!bill.otherCharges && <Line k="Other charges" v={inr(bill.otherCharges)} />}
            {!!totals?.roundOff && <Line k="Round off" v={inr(totals.roundOff)} muted />}
          </div>
          <TaxBreakup lines={pv?.lines ?? []} interState={!!pv?.interState} />
          <div className="mt-4 rounded-2xl bg-primary p-4 text-primary-fg">
            <div className="flex items-center justify-between text-xs uppercase tracking-wider text-white/70">
              <span>{t('pos.total')}</span>
              <button onClick={() => setDiscOpen(true)} className="flex items-center gap-1 rounded-md px-1.5 py-0.5 normal-case tracking-normal text-white/80 hover:bg-white/10">
                <Percent className="h-3 w-3" /> {t('pos.discount')} <span className="kbd border-white/20 bg-white/10 text-white">F8</span>
              </button>
            </div>
            <div className="mt-1 text-4xl font-semibold tracking-tight tnum" data-testid="pos-total">{inr(payable)}</div>
            {pv?.belowCost && (
              <div className="mt-1.5 rounded-md bg-bad px-2 py-1 text-xs font-medium text-white" data-testid="bill-loss">
                Selling below purchase cost{pv.loss != null ? ` · loss ${inr(pv.loss)}` : ''}
              </div>
            )}
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2">
            <PayBtn active={mode === 'cash'} onClick={() => setPay('cash')} icon={<Banknote />} label={t('pos.cash')} k="F4" testid="pay-cash" />
            <PayBtn active={mode === 'upi'} onClick={() => setPay('upi')} icon={<Smartphone />} label={t('pos.upi')} k="F5" testid="pay-upi" />
            <PayBtn active={mode === 'credit'} onClick={() => setPay('credit')} icon={<NotebookPen />} label={t('pos.credit')} k="F6" testid="pay-credit" />
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => setPay('split')} className={cn('flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs', mode === 'split' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2')} data-testid="pay-split">
              <Split className="h-3.5 w-3.5" /> Split cash + UPI
            </button>
            <button onClick={() => setPay('card')} className={cn('flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs', mode === 'card' ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2')}>
              <CreditCard className="h-3.5 w-3.5" /> Card / other
            </button>
          </div>

          <div className="mt-4">
            {mode === 'cash' && (
              <div className="space-y-2">
                <label className="label">Cash received</label>
                <MoneyInput
                  ref={tenderRef}
                  value={bill.tendered}
                  onChange={(v) => pos.set({ tendered: v })}
                  onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void save(true))}
                  placeholder={payable ? (payable / 100).toFixed(0) : '0'}
                  className="[&_input]:h-11 [&_input]:text-lg"
                  data-testid="pos-tendered"
                />
                <div className="flex gap-1.5">
                  {[payable, ...[100, 200, 500, 2000].map((n) => n * 100).filter((n) => n > payable).slice(0, 3)].filter(Boolean).map((n, i) => (
                    <button key={i} onClick={() => pos.set({ tendered: n })} className="flex-1 rounded-md border border-border py-1 text-xs font-medium hover:border-primary hover:text-primary">
                      {i === 0 ? 'Exact' : inr(n, false)}
                    </button>
                  ))}
                </div>
                {change > 0 && (
                  <div className="flex items-center justify-between rounded-xl bg-saffron-soft px-4 py-3 text-saffron-ink animate-pop">
                    <span className="text-sm font-medium">Return change</span>
                    <span className="text-xl font-semibold tnum" data-testid="change">{inr(change)}</span>
                  </div>
                )}
              </div>
            )}
            {mode === 'upi' && (
              <div className="flex flex-col items-center rounded-xl border border-border p-4">
                {company?.upi_id ? (
                  payable > 0 ? (
                    <>
                      <UpiQr link={upiLink({ vpa: company.upi_id, name: company.name, amount: payable, note: 'Bill payment' })} size={180} />
                      <p className="mt-2 text-sm font-medium">Scan to pay {inr(payable)}</p>
                      <p className="text-xs text-muted">{company.upi_id}</p>
                    </>
                  ) : (
                    <p className="py-8 text-sm text-muted">QR appears when items are added</p>
                  )
                ) : (
                  <p className="py-4 text-center text-sm text-muted">Add your UPI ID in <Link to="/settings" className="text-primary underline">Settings</Link> to show a QR with the exact amount.</p>
                )}
              </div>
            )}
            {mode === 'split' && (
              <SplitPanel payable={payable} cash={Math.min(bill.splitCash ?? 0, payable)} other={bill.splitOther ?? 'upi'} onCash={(v) => pos.set({ splitCash: v })} onOther={(v) => pos.set({ splitOther: v })} onEnter={() => void save(true)} upiId={company?.upi_id ?? null} shop={company?.name ?? ''} />
            )}
            {mode === 'credit' && (
              <div className="space-y-2 rounded-xl border border-border p-3">
                <div className="text-sm">
                  {party && !party.is_walkin ? (
                    <>
                      Adding to <b>{party.name}</b>'s khata.
                      <div className="mt-1 text-xs text-muted">
                        Now due {inr(balance)} → after this bill <b className="text-ink">{inr(balance + payable - bill.paidNow)}</b>
                        {party.credit_limit > 0 && ` · limit ${inr(party.credit_limit)}`}
                      </div>
                    </>
                  ) : (
                    <span className="text-muted">Pick a customer (F7) to give udhaar.</span>
                  )}
                </div>
                {overLimit && <Badge tone="bad">Over credit limit</Badge>}
                <label className="label mt-2">Paid now (optional)</label>
                <div className="flex gap-2">
                  <MoneyInput className="flex-1" value={bill.paidNow} onChange={(v) => pos.set({ paidNow: v })} data-testid="pos-paid-now" />
                  <Segmented size="sm" value={bill.paidNowMode ?? 'cash'} onChange={(v) => pos.set({ paidNowMode: v })} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }]} />
                </div>
              </div>
            )}
          </div>
          {last && lines.length > 0 && <LastBill inv={last} compact />}
        </div>
        <div className="space-y-2 border-t border-border p-4">
          <Button variant="primary" size="xl" className="w-full" kbd="F9" loading={saving} disabled={!draft.lines.length} onClick={() => save(true)} icon={<Printer className="h-5 w-5" />} data-testid="pos-save-print">
            {t('pos.saveprint')}
          </Button>
          <Button variant="outline" className="w-full" kbd="F10" disabled={!draft.lines.length || saving} onClick={() => save(false)} data-testid="pos-save">
            Save without printing
          </Button>
        </div>
      </aside>

      <CustomerPicker
        open={pickCustomer}
        onOpenChange={(v) => (setPickCustomer(v), !v && focusSearch())}
        onPick={(p) => {
          void pickParty(p);
          if (mode === 'credit' && p.is_walkin) pos.setMode('cash');
          setPickCustomer(false);
          focusSearch();
        }}
      />

      {buyOutside !== null && lines[buyOutside] && (
        <BuyOutsideDialog
          line={lines[buyOutside]}
          onClose={() => (setBuyOutside(null), focusSearch())}
          onBought={(qty) => pos.update(buyOutside, { stock: roundQty(lines[buyOutside].stock + qty) })}
        />
      )}

      <ConfirmDialog
        open={closeAsk !== null}
        onOpenChange={(v) => !v && (setCloseAsk(null), focusSearch())}
        title={`Close Bill ${closeAsk !== null ? pos.bills[closeAsk]?.no : ''}?`}
        body="This bill has items that haven't been saved. Closing it removes them."
        confirmLabel="Close bill"
        danger
        onConfirm={() => {
          if (closeAsk !== null) pos.closeBill(closeAsk);
          setCloseAsk(null);
          focusSearch();
        }}
      />

      <DiscountDialog
        open={discOpen}
        onOpenChange={(v) => (setDiscOpen(v), !v && focusSearch())}
        value={bill.billDiscountPct}
        cap={canDo('discount.any') ? 100 : CASHIER_DISCOUNT_CAP}
        onSave={(v) => (pos.set({ billDiscountPct: v }), setDiscOpen(false), focusSearch())}
      />

      <ConfirmDialog open={clearOpen} onOpenChange={(v) => (setClearOpen(v), !v && focusSearch())} title="Clear this bill?" body="All items on the current bill will be removed." confirmLabel="Clear bill" danger onConfirm={() => { pos.clear(); focusSearch(); }} />

      <ConfirmDialog
        open={!!creditConfirm}
        onOpenChange={(v) => !v && setCreditConfirm(null)}
        title="Over credit limit"
        body={`${party?.name} will go over their credit limit of ${inr(party?.credit_limit ?? 0)}. Save anyway?`}
        confirmLabel="Save anyway"
        onConfirm={() => save(creditConfirm?.print ?? true, true)}
      />
    </div>
  );
}

function BatchChip({ line, index, bucket }: { line: CartLine; index: number; bucket: string }) {
  const [open, setOpen] = useState(false);
  const update = usePos((s) => s.update);
  const batch = line.batches.find((b) => b.id === line.batchId) ?? line.batches.find((b) => b.qty > 0 && (!b.expiry || b.expiry >= today())) ?? line.batches.find((b) => b.qty > 0);
  return (
    <>
      <button onClick={() => setOpen(true)} className={cn('chip whitespace-nowrap', bucket === 'expired' ? 'bg-bad-soft text-bad' : bucket === 'd30' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted', 'hover:ring-1 hover:ring-primary/40')} tabIndex={-1}>
        {batch?.batch_no} {batch?.expiry && `· exp ${batch.expiry.slice(5, 7)}/${batch.expiry.slice(2, 4)}`}
        {line.batchId ? ' · picked' : ''}
      </button>
      <Dialog open={open} onOpenChange={setOpen} title={`Pick batch · ${line.name}`} description="By default the batch expiring first is sold (FIFO)." size="sm">
        <div className="space-y-1.5">
          <button onClick={() => (update(index, { batchId: null }), setOpen(false))} className={cn('w-full rounded-lg border p-2.5 text-left text-sm', !line.batchId ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2')}>
            Automatic (FIFO — earliest expiry first)
          </button>
          {line.batches.filter((b) => b.qty > 0).map((b) => (
            <button key={b.id} onClick={() => (update(index, { batchId: b.id }), setOpen(false))} className={cn('flex w-full justify-between rounded-lg border p-2.5 text-left text-sm', line.batchId === b.id ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-2')}>
              <span>{b.batch_no ?? 'No batch'} {b.expiry && <span className="text-muted">· exp {b.expiry}</span>}</span>
              <span className="tnum">{fmtQty(b.qty)} {line.baseUnit}</span>
            </button>
          ))}
        </div>
      </Dialog>
    </>
  );
}

function QtyInput({ value, onChange, onFocus, onEnter, inputRef }: { value: number; onChange: (v: number) => void; onFocus: () => void; onEnter: () => void; inputRef: (el: HTMLInputElement | null) => void }) {
  const [text, setText] = useState(Number.isNaN(value) ? '' : String(value));
  useEffect(() => {
    if (Number(text) !== value && !(Number.isNaN(value) && text === '')) setText(Number.isNaN(value) ? '' : String(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      ref={inputRef}
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.]/g, '');
        setText(t);
        onChange(t === '' ? NaN : Number(t));
      }}
      onFocus={(e) => (onFocus(), e.target.select())}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onEnter())}
      inputMode="decimal"
      className="input h-8 w-16 px-1 text-center font-semibold tnum"
      data-testid="line-qty"
    />
  );
}

function RateInput({ value, onChange, onEnter }: { value: number; onChange: (p: number) => void; onEnter: () => void }) {
  const [text, setText] = useState((value / 100).toFixed(2));
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText((value / 100).toFixed(2));
  }, [value, focus]);
  return (
    <input
      value={text}
      onFocus={(e) => (setFocus(true), e.target.select())}
      onBlur={() => setFocus(false)}
      onChange={(e) => {
        const t = e.target.value.replace(/[^\d.]/g, '');
        setText(t);
        onChange(Math.round(parseFloat(t || '0') * 100));
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onEnter())}
      inputMode="decimal"
      className="input h-8 w-20 px-2 text-right tnum"
      data-testid="line-rate"
    />
  );
}

function Line({ k, v, muted, tone }: { k: string; v: string; muted?: boolean; tone?: 'good' }) {
  return (
    <div className={cn('flex justify-between', muted && 'text-muted')}>
      <span>{k}</span>
      <span className={cn('tnum', tone === 'good' && 'text-good')}>{v}</span>
    </div>
  );
}

function PayBtn({ active, onClick, icon, label, k, testid }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; k: string; testid: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      aria-pressed={active}
      className={cn('flex flex-col items-center gap-1 rounded-xl border-2 py-2.5 text-sm font-medium transition [&>svg]:h-5 [&>svg]:w-5', active ? 'border-primary bg-primary-soft text-primary' : 'border-border text-muted hover:border-primary/40 hover:text-ink')}
    >
      {icon}
      {label}
      <span className="kbd">{k}</span>
    </button>
  );
}

function DiscountDialog({ open, onOpenChange, value, cap, onSave }: { open: boolean; onOpenChange: (v: boolean) => void; value: number; cap: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value || ''));
  useEffect(() => setV(String(value || '')), [value, open]);
  const n = Number(v) || 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Bill discount" description={cap < 100 ? `Cashiers can give up to ${cap}%.` : 'Applied to every item before GST.'} size="sm"
      footer={<><Button variant="ghost" onClick={() => onSave(0)}>Remove</Button><Button variant="primary" disabled={n > cap} onClick={() => onSave(n)}>Apply {n ? `${n}%` : ''}</Button></>}>
      <div className="flex gap-2">
        {[2, 5, 10].filter((p) => p <= cap).map((p) => (
          <Button key={p} variant="outline" onClick={() => onSave(p)}>{p}%</Button>
        ))}
        <Input autoFocus value={v} onChange={(e) => setV(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={(e) => e.key === 'Enter' && n <= cap && onSave(n)} suffix="%" placeholder="Custom" className="flex-1" data-testid="disc-input" />
      </div>
      {n > cap && <p className="mt-2 text-xs text-bad">Above your limit of {cap}%.</p>}
    </Dialog>
  );
}

function LastBill({ inv, compact }: { inv: Invoice; compact?: boolean }) {
  const company = useApi('app.status').data?.company;
  return (
    <div className={cn('mt-6 flex items-center gap-3 rounded-xl border border-good/30 bg-good-soft/60 p-3 text-left', compact && 'mt-4')} data-testid="last-bill">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Last bill {inv.number} · {inr(inv.total)}</div>
        <div className="text-xs text-muted">{inv.party_name} · {inv.payment_mode}</div>
      </div>
      <Button size="sm" variant="ghost" title="Print again" onClick={() => company && printInvoice(inv, company)} icon={<Printer className="h-4 w-4" />} />
      {inv.party_phone && company && (
        <a href={whatsappLink(inv.party_phone, billMessage({ shop: company.name, number: inv.number, date: inv.date, total: inv.total, items: inv.lines?.length ?? 0, balance: inv.total - inv.paid, upi: company.upi_id }))} target="_blank" rel="noreferrer" className="grid h-8 w-8 place-items-center rounded-md text-good hover:bg-good-soft" title="Send on WhatsApp">
          <Send className="h-4 w-4" />
        </a>
      )}
      <Link to={`/sales/${inv.id}`} className="text-xs font-medium text-primary hover:underline">View</Link>
    </div>
  );
}

function SplitPanel({ payable, cash, other, onCash, onOther, onEnter, upiId, shop }: { payable: number; cash: number; other: 'upi' | 'card'; onCash: (v: number) => void; onOther: (v: 'upi' | 'card') => void; onEnter: () => void; upiId: string | null; shop: string }) {
  const rest = Math.max(0, payable - cash);
  return (
    <div className="space-y-3 rounded-xl border border-border p-3" data-testid="split-panel">
      <div>
        <label className="label">Cash part</label>
        <MoneyInput autoFocus value={cash} onChange={(v) => onCash(Math.min(v, payable))} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onEnter())} className="[&_input]:h-11 [&_input]:text-lg" data-testid="split-cash" />
      </div>
      <div className="flex items-center justify-between">
        <Segmented size="sm" value={other} onChange={onOther} options={[{ value: 'upi', label: 'Rest by UPI' }, { value: 'card', label: 'Rest by card' }]} />
        <span className="text-lg font-semibold tnum" data-testid="split-rest">{inr(rest)}</span>
      </div>
      {other === 'upi' && upiId && rest > 0 && (
        <div className="flex items-center gap-3">
          <UpiQr link={upiLink({ vpa: upiId, name: shop, amount: rest, note: 'Bill payment' })} size={96} />
          <p className="text-xs text-muted">Scan to pay the remaining {inr(rest)}</p>
        </div>
      )}
    </div>
  );
}

/**
 * The customer wants something that is out of stock and it is fetched from a nearby shop without
 * a bill: bring it in here (paid from the drawer or by UPI) so the sale goes through normally and
 * the price paid becomes its cost.
 */
function BuyOutsideDialog({ line, onClose, onBought }: { line: CartLine; onClose: () => void; onBought: (baseQty: number) => void }) {
  const short = Math.max(1, Math.ceil(roundQty(line.qty * line.factor - Math.max(0, line.stock))));
  const [qty, setQty] = useState(String(short));
  const [price, setPrice] = useState(0);
  const [mode, setMode] = useState<'cash' | 'upi'>('cash');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Number(qty) || 0;
  const go = async () => {
    setBusy(true);
    try {
      await call('invoices.create', {
        kind: 'purchase', noBill: true, supplierBillNo: from.trim() || undefined,
        lines: [{ itemId: line.itemId, unit: line.baseUnit, factor: 1, qty: n, rate: price }],
        payments: [{ mode, amount: Math.round(price * n) }],
      });
      onBought(n);
      toast.success(`${fmtQty(n)} ${line.baseUnit} of ${line.name} added to stock`, `Paid ${formatINR(Math.round(price * n))} ${mode === 'cash' ? 'from the drawer' : 'by UPI'} · no bill`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Bought ${line.name} outside?`} description="Fetched from a nearby shop without a bill. It comes into stock at the price you paid, so this sale shows the real profit." size="sm"
      footer={<Button variant="primary" loading={busy} disabled={!(n > 0) || !(price > 0)} onClick={go} data-testid="buy-outside-save">Add to stock · {formatINR(Math.round(price * n))}</Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span className="label">Quantity ({line.baseUnit})</span><Input type="number" min={0} step="any" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="buy-outside-qty" /></label>
        <label className="space-y-1 text-sm"><span className="label">Price paid per {line.baseUnit}</span><MoneyInput value={price} onChange={setPrice} data-testid="buy-outside-price" /></label>
        <label className="space-y-1 text-sm"><span className="label">Paid by</span><Segmented value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash (drawer)' }, { value: 'upi', label: 'UPI' }]} /></label>
        <label className="space-y-1 text-sm"><span className="label">Bought from (optional)</span><Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder="e.g. Sharma Stores" /></label>
      </div>
    </Dialog>
  );
}
