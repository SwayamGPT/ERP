import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus, Save, Search, Trash2, Truck } from 'lucide-react';
import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ImportBillButton } from './ImportBill';
import { useApi } from '../../lib/useApi';
import { Badge, Button, Card, Dialog, Field, Input, Kbd, MoneyInput, PageHeader, Segmented, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { DraftInvoice, Item, Party } from '../../db/types';
import { cn } from '../../lib/cn';
import { inr, today } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { useCan } from '../../lib/perm';
import { CustomerPicker } from '../pos/CustomerPicker';

interface Row {
  key: number;
  item: Item | null;
  /** Text typed in the item box that hasn't become an item yet. */
  typed?: string;
  unit: string;
  factor: number;
  qty: string;
  free: string;
  rate: string; // rupees, excl. GST
  disc: string;
  batch: string;
  expiry: string;
  mrp: string;
  /** Supplier coupon on this line: rupees per coupon, base units per coupon. */
  couponValue: string;
  couponPer: string;
}

let K = 0;
const blank = (): Row => ({ key: ++K, item: null, unit: '', factor: 1, qty: '', free: '', rate: '', disc: '', batch: '', expiry: '', mrp: '', couponValue: '', couponPer: '' });
const couponOf = (item: Item | null) => ({ couponValue: item?.coupon_value ? (item.coupon_value / 100).toFixed(2) : '', couponPer: item?.coupon_per ? String(item.coupon_per) : '' });
/** Coupons a row earns and their value (paise), and the real cost per base unit after them. */
export function rowCoupons(r: Pick<Row, 'qty' | 'free' | 'factor' | 'rate' | 'disc' | 'couponValue' | 'couponPer'>) {
  const units = ((Number(r.qty) || 0) + (Number(r.free) || 0)) * r.factor;
  const cv = Math.round((Number(r.couponValue) || 0) * 100);
  const cp = Number(r.couponPer) || 0;
  const count = cv > 0 && cp > 0 ? Math.floor(units / cp + 1e-9) : 0;
  const lineValue = Math.round((Number(r.qty) || 0) * (Number(r.rate) || 0) * 100 * (1 - (Number(r.disc) || 0) / 100));
  const realCost = units > 0 ? Math.round((lineValue - count * cv) / units) : 0;
  return { count, value: count * cv, realCost, has: cv > 0 && cp > 0 };
}
const COLS = ['item', 'qty', 'free', 'rate', 'disc', 'batch', 'expiry', 'mrp'] as const;

/** A filled row for an item (from a purchase order or an imported bill). Rates in paise. */
export function rowFor(item: Item, o: { qty: number; rate?: number; batch?: string; expiry?: string; mrp?: number; unit?: string; factor?: number } ) {
  const factor = o.factor ?? 1;
  const rate = o.rate ?? Math.round((item.purchase_price ?? 0) * factor);
  return { ...blank(), ...couponOf(item), item, unit: o.unit ?? item.base_unit, factor, qty: String(o.qty), rate: rate ? (rate / 100).toFixed(2) : '', batch: o.batch ?? '', expiry: o.expiry ?? '', mrp: (o.mrp ?? item.mrp) ? (((o.mrp ?? item.mrp) as number) / 100).toFixed(2) : '' };
}

export function PurchaseEntry() {
  const navigate = useNavigate();
  const canDo = useCan();
  const [supplier, setSupplier] = useState<Party | null>(null);
  const [params0] = useSearchParams();
  // Bought without a GST bill (a nearby shop, a local seller): supplier and bill number optional.
  const [noBill, setNoBill] = useState(params0.get('nobill') === '1');
  const [pick, setPick] = useState(params0.get('nobill') !== '1');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [other, setOther] = useState(0);
  const [payNow, setPayNow] = useState<'none' | 'cash' | 'bank' | 'upi'>(params0.get('nobill') === '1' ? 'cash' : 'none');
  const [saving, setSaving] = useState(false);
  const [billNoMissing, setBillNoMissing] = useState(false);
  const billNoRef = useRef<HTMLInputElement>(null);
  const [po, setPo] = useState<{ id: number; number: string } | null>(null);
  const [godownId, setGodownId] = useState<number | null>(null);
  const godowns = useApi('stock.godowns').data ?? [];
  const [params] = useSearchParams();
  const poParam = Number(params.get('po')) || null;
  const editParam = Number(params.get('edit')) || null;
  const [editing, setEditing] = useState<{ id: number; number: string } | null>(null);
  useEffect(() => {
    if (!editParam) return;
    void (async () => {
      try {
        const d = await call('invoices.forEdit', { id: editParam });
        const v = d.invoice;
        const [party, items] = await Promise.all([call('parties.get', { id: v.party_id }), Promise.all(d.lines.map((l) => call('items.get', { id: l.item_id })))]);
        setSupplier(party.is_walkin ? null : party);
        setPick(false);
        setEditing({ id: v.id, number: v.number });
        setBillNo(v.supplier_bill_no ?? '');
        setNoBill(!!v.no_bill);
        setDate(v.date);
        setOther(v.other_charges ?? 0);
        setGodownId(d.godownId);
        const paid = d.payments.reduce((a, p) => a + p.amount, 0);
        const m = d.payments[0]?.mode;
        setPayNow(paid > 0 && (m === 'cash' || m === 'bank' || m === 'upi') ? m : 'none');
        setRows([
          ...d.lines.map((l, i) => ({
            ...rowFor(items[i], { qty: l.qty, rate: l.rate, unit: l.unit, factor: l.factor, batch: l.batch_no ?? '', expiry: l.expiry ?? '', mrp: l.mrp ?? undefined }),
            free: l.free_qty ? String(l.free_qty) : '',
            disc: l.line_discount_pct ? String(l.line_discount_pct) : '',
            couponValue: l.coupon_value ? (l.coupon_value / 100).toFixed(2) : '',
            couponPer: l.coupon_per ? String(l.coupon_per) : '',
          })),
          blank(),
        ]);
      } catch (e) {
        toast.error(e);
      }
    })();
  }, [editParam]);
  useEffect(() => {
    if (!poParam) return;
    void (async () => {
      try {
        const o = await call('po.get', { id: poParam });
        const [party, items] = await Promise.all([call('parties.get', { id: o.party_id }), Promise.all(o.lines!.filter((l) => l.pending > 0).map((l) => call('items.get', { id: l.item_id })))]);
        setSupplier(party);
        setPick(false);
        setPo({ id: o.id, number: o.number });
        const pend = o.lines!.filter((l) => l.pending > 0);
        setRows([...pend.map((l, i) => rowFor(items[i], { qty: l.pending, rate: l.rate, unit: l.unit, factor: l.factor })), blank()]);
      } catch (e) {
        toast.error(e);
      }
    })();
  }, [poParam]);
  const cells = useRef<Record<string, HTMLInputElement | null>>({});

  const focus = (rowKey: number, col: (typeof COLS)[number]) => setTimeout(() => cells.current[`${rowKey}:${col}`]?.focus(), 0);
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const draft: DraftInvoice = useMemo(
    () => ({
      kind: 'purchase',
      partyId: supplier?.id,
      noBill,
      date,
      supplierBillNo: billNo,
      otherCharges: other,
      poId: po?.id ?? null,
      godownId,
      lines: rows
        .filter((r) => r.item && Number(r.qty) > 0)
        .map((r) => ({
          itemId: r.item!.id,
          unit: r.unit,
          factor: r.factor,
          qty: Number(r.qty),
          freeQty: Number(r.free) || 0,
          rate: Math.round(Number(r.rate || 0) * 100),
          discountPct: Number(r.disc) || 0,
          taxInclusive: false,
          batchNo: r.batch || null,
          expiry: r.expiry || null,
          mrp: r.mrp ? Math.round(Number(r.mrp) * 100) : null,
          couponValue: Math.round((Number(r.couponValue) || 0) * 100),
          couponPer: Number(r.couponPer) || 0,
        })),
    }),
    [rows, supplier?.id, date, billNo, other, po?.id, godownId, noBill],
  );
  const preview = useQuery({ queryKey: ['invoices.preview', draft], queryFn: () => call('invoices.preview', draft), enabled: (!!supplier || noBill) && draft.lines.length > 0, placeholderData: keepPreviousData });
  const t = draft.lines.length ? preview.data?.totals : undefined;

  const save = async () => {
    if (!supplier && !noBill) return setPick(true);
    const orphan = rows.findIndex((r) => !r.item && (r.typed?.trim() || Number(r.qty) > 0));
    if (orphan >= 0) {
      const r = rows[orphan];
      focus(r.key, 'item');
      return toast.error(new Error(`Row ${orphan + 1}: “${r.typed?.trim() || 'item'}” is not an item yet. Pick it from the list, or choose “Create item” to add it.`));
    }
    if (!draft.lines.length) return toast.info('Add at least one item with quantity');
    if (noBill && !supplier && payNow === 'none') return toast.error(new Error('Choose how you paid (cash, bank or UPI), or pick the seller to buy on credit.'));
    if (!billNo.trim() && !noBill) {
      setBillNoMissing(true);
      billNoRef.current?.focus();
      return toast.error(new Error("Enter the supplier's invoice number (from their bill)."));
    }
    setSaving(true);
    try {
      const payable = t?.payable ?? 0;
      const full = { ...draft, payments: payNow !== 'none' && payable > 0 ? [{ mode: payNow, amount: payable }] : [] };
      const inv = editing ? await call('invoices.update', { id: editing.id, draft: { ...full, poId: null } }) : await call('invoices.create', full);
      toast.success(`Purchase ${inv.number} ${editing ? 'updated' : 'saved'}`, `Stock updated for ${inv.lines?.length} items`);
      navigate(`/purchases/${inv.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  useHotkeys({ F9: () => void save(), F10: () => void save(), F7: () => setPick(true), 'mod+Enter': () => void save() }, !pick);

  if (!canDo('purchase.create')) return <p className="text-muted">You don't have access to purchases.</p>;

  const nav = (e: React.KeyboardEvent, row: Row, col: (typeof COLS)[number]) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const i = COLS.indexOf(col);
    const trackBatch = !!row.item?.track_batch;
    let next = COLS[i + 1];
    while (next && !trackBatch && (next === 'batch' || next === 'expiry')) next = COLS[COLS.indexOf(next) + 1];
    if (next) return focus(row.key, next);
    const idx = rows.findIndex((r) => r.key === row.key);
    if (idx === rows.length - 1) {
      const b = blank();
      setRows((rs) => [...rs, b]);
      focus(b.key, 'item');
    } else focus(rows[idx + 1].key, 'item');
  };

  return (
    <div className="animate-slide-up">
      <PageHeader icon={<Truck className="h-5 w-5" />} title={editing ? `Edit purchase ${editing.number}` : 'New purchase'} subtitle={editing ? 'Change anything on this bill and save. Stock, cost, the supplier account and payments are corrected; the bill keeps its number.' : "Enter the supplier's bill. Stock, batches, cost and input GST update automatically."} actions={<><ImportBillButton onLoad={(list) => setRows([...list.map((x) => rowFor(x.item, x)), blank()])} /><Button variant="primary" icon={<Save className="h-4 w-4" />} kbd="F9" loading={saving} onClick={save} data-testid="purchase-save">{editing ? 'Save changes' : 'Save purchase'}</Button></>} />
      {po && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-sm text-primary" data-testid="purchase-from-po">
          <ClipboardList className="h-4 w-4" /> Receiving goods against {po.number}. Change quantities to what actually arrived.
        </p>
      )}
      <Card className="mb-4">
        <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-5">
          <Field label="Bill" hint={noBill ? 'No input GST, and left out of GST returns. Enter the supplier’s invoice later as a GST bill if one comes.' : undefined}>
            <Segmented value={noBill ? 'none' : 'gst'} onChange={(v) => {
              const nb = v === 'none';
              setNoBill(nb);
              if (nb && !supplier && payNow === 'none') setPayNow('cash');
            }} options={[{ value: 'gst', label: 'GST bill' }, { value: 'none', label: 'No bill / challan' }]} />
          </Field>
          <Field label={noBill ? 'Bought from (optional)' : 'Supplier *'}>
            <button onClick={() => setPick(true)} className="input flex items-center justify-between text-left" data-testid="purchase-supplier">
              <span className={supplier ? '' : 'text-faint'}>{supplier?.name ?? (noBill ? 'Nearby shop / not saved' : 'Pick supplier…')}</span>
              <Kbd>F7</Kbd>
            </button>
          </Field>
          <Field label={noBill ? 'Receipt / note (optional)' : 'Supplier invoice no. *'} error={billNoMissing ? "Enter the invoice number printed on the supplier's bill" : undefined}>
            <Input ref={billNoRef} value={billNo} onChange={(e) => (setBillNo(e.target.value), setBillNoMissing(false))} placeholder={noBill ? 'e.g. Sharma Stores' : 'e.g. MD/2291'} data-testid="purchase-billno" />
          </Field>
          <Field label="Bill date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          {godowns.length > 1 && (
            <Field label="Goods go to">
              <select className="input" value={godownId ?? godowns.find((g) => g.is_default)?.id ?? 1} onChange={(e) => setGodownId(Number(e.target.value))} data-testid="purchase-godown">
                {godowns.filter((g) => g.active).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
          )}
          {noBill ? (
            <Field label="Tax" hint="Any GST you paid is part of the price; no input credit.">
              <div className="flex h-9 items-center" data-testid="purchase-nobill"><Badge tone="warn">No GST bill · full price is the cost</Badge></div>
            </Field>
          ) : (
            <Field label="Tax" hint={supplier ? (preview.data?.interState ? 'Other state → IGST input' : 'Same state → CGST + SGST input') : ' '}>
              <div className="flex h-9 items-center">{supplier?.gstin ? <Badge tone="good">GSTIN {supplier.gstin}</Badge> : <Badge>Unregistered supplier</Badge>}</div>
            </Field>
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="table-base min-w-[1220px]">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th className="min-w-[260px]">Item</th>
                <th className="w-24">Unit</th>
                <th className="w-20 text-right">Qty</th>
                <th className="w-20 text-right">Free</th>
                <th className="w-28 text-right">{noBill ? 'Price paid' : 'Rate (excl. GST)'}</th>
                <th className="w-16 text-right">Disc %</th>
                <th className="w-28">Batch</th>
                <th className="w-36">Expiry</th>
                <th className="w-24 text-right">MRP</th>
                <th className="w-32 whitespace-nowrap" title="Supplier coupon: worth (₹), and one coupon per how many units">Coupon ₹ / per</th>
                <th className="w-28 text-right">Amount</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const amt = Math.round(Number(r.qty || 0) * Number(r.rate || 0) * (1 - (Number(r.disc) || 0) / 100) * 100);
                const cell = (col: (typeof COLS)[number]) => ({ ref: (el: HTMLInputElement | null) => (cells.current[`${r.key}:${col}`] = el), onKeyDown: (e: React.KeyboardEvent) => nav(e, r, col) });
                return (
                  <tr key={r.key}>
                    <td className="text-xs text-faint">{i + 1}</td>
                    <td>
                      <ItemCell
                        inputRef={cell('item').ref}
                        item={r.item}
                        onText={(t) => update(r.key, { typed: t, ...(r.item && t !== r.item.name ? { item: null } : {}) })}
                        onPick={(it) => {
                          update(r.key, { typed: '', item: it, unit: it.base_unit, factor: 1, rate: it.purchase_price ? (it.purchase_price / 100).toFixed(2) : '', mrp: it.mrp ? (it.mrp / 100).toFixed(2) : '', ...couponOf(it) });
                          focus(r.key, 'qty');
                        }}
                      />
                    </td>
                    <td>
                      {r.item && r.item.units.length > 1 ? (
                        <select className="input h-8 px-2 text-xs" value={r.unit} onChange={(e) => {
                          const u = r.item!.units.find((x) => x.name === e.target.value)!;
                          const baseCost = (r.item!.purchase_price ?? 0) / 100;
                          update(r.key, { unit: u.name, factor: u.factor, rate: baseCost ? (baseCost * u.factor).toFixed(2) : r.rate, mrp: r.item!.mrp ? ((r.item!.mrp * u.factor) / 100).toFixed(2) : '' });
                        }}>
                          {r.item.units.map((u) => <option key={u.name}>{u.name}</option>)}
                        </select>
                      ) : (
                        <span className="text-xs text-muted">{r.unit}</span>
                      )}
                    </td>
                    <td><NumCell {...cell('qty')} value={r.qty} onChange={(v) => update(r.key, { qty: v })} testid="pur-qty" /></td>
                    <td><NumCell {...cell('free')} value={r.free} onChange={(v) => update(r.key, { free: v })} /></td>
                    <td><NumCell {...cell('rate')} value={r.rate} onChange={(v) => update(r.key, { rate: v })} testid="pur-rate" /></td>
                    <td><NumCell {...cell('disc')} value={r.disc} onChange={(v) => update(r.key, { disc: v })} /></td>
                    <td><input {...cell('batch')} className="input h-8 px-2 font-mono text-xs" disabled={!r.item?.track_batch} placeholder={r.item?.track_batch ? 'B123' : '—'} value={r.batch} onChange={(e) => update(r.key, { batch: e.target.value.toUpperCase() })} data-testid="pur-batch" /></td>
                    <td><input {...cell('expiry')} type="date" className="input h-8 px-2 text-xs" disabled={!r.item?.track_batch} value={r.expiry} onChange={(e) => update(r.key, { expiry: e.target.value })} data-testid="pur-expiry" /></td>
                    <td><NumCell {...cell('mrp')} value={r.mrp} onChange={(v) => update(r.key, { mrp: v })} /></td>
                    <td>
                      <div className="flex items-center gap-1">
                        <input className="input h-8 w-14 px-1.5 text-right text-xs tnum" inputMode="decimal" placeholder="₹" value={r.couponValue} onChange={(e) => update(r.key, { couponValue: e.target.value })} data-testid="pur-coupon-value" tabIndex={-1} />
                        <span className="text-xs text-faint">/</span>
                        <input className="input h-8 w-11 px-1.5 text-right text-xs tnum" inputMode="decimal" placeholder="qty" value={r.couponPer} onChange={(e) => update(r.key, { couponPer: e.target.value })} data-testid="pur-coupon-per" tabIndex={-1} />
                      </div>
                      {(() => {
                        const c = rowCoupons(r);
                        return c.has && c.count > 0 ? <div className="mt-0.5 whitespace-nowrap text-[11px] text-good" data-testid="pur-real-cost">{c.count} coupon{c.count > 1 ? 's' : ''} · real {inr(c.realCost)}</div> : null;
                      })()}
                    </td>
                    <td className="text-right font-medium tnum">{r.item || amt ? inr(amt) : ''}</td>
                    <td>
                      <button tabIndex={-1} className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [blank()]))} aria-label="Remove row">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-6 border-t border-border p-4">
          <div className="space-y-3">
            <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => { const b = blank(); setRows([...rows, b]); focus(b.key, 'item'); }}>Add row</Button>
            <p className="text-xs text-muted">Press <Kbd>Enter</Kbd> to move across cells. A new row appears after MRP. Rates are before GST, per unit shown.</p>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted">Paid now?</span>
              <Segmented size="sm" value={payNow} onChange={setPayNow} options={[{ value: 'none', label: 'On credit' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'upi', label: 'UPI' }]} />
            </div>
          </div>
          <div className="w-72 space-y-1.5 text-sm">
            <div className="flex justify-between text-muted"><span>Taxable</span><span className="tnum">{inr(t?.taxable ?? 0)}</span></div>
            {preview.data?.interState ? (
              <div className="flex justify-between text-muted"><span>IGST (input)</span><span className="tnum">{inr(t?.igst ?? 0)}</span></div>
            ) : (
              <>
                <div className="flex justify-between text-muted"><span>CGST (input)</span><span className="tnum">{inr(t?.cgst ?? 0)}</span></div>
                <div className="flex justify-between text-muted"><span>SGST (input)</span><span className="tnum">{inr(t?.sgst ?? 0)}</span></div>
              </>
            )}
            <div className="flex items-center justify-between text-muted"><span>Freight / other</span><MoneyInput className="w-28" value={other} onChange={setOther} /></div>
            {!!t?.roundOff && <div className="flex justify-between text-muted"><span>Round off</span><span className="tnum">{inr(t.roundOff)}</span></div>}
            <div className="flex justify-between border-t border-border pt-2 text-lg font-semibold"><span>Bill total</span><span className="tnum" data-testid="purchase-total">{inr(t?.payable ?? 0)}</span></div>
            {(() => {
              const cs = rows.filter((r) => r.item).map(rowCoupons);
              const n = cs.reduce((a, c) => a + c.count, 0);
              return n > 0 ? <div className="flex justify-between text-good" data-testid="purchase-coupons"><span>Coupons with this bill · {n}</span><span className="tnum">{inr(cs.reduce((a, c) => a + c.value, 0))} to redeem</span></div> : null;
            })()}
          </div>
        </div>
      </Card>

      <CustomerPicker
        kind="supplier"
        open={pick}
        onOpenChange={setPick}
        onPick={(p) => {
          setSupplier(p);
          setPick(false);
          focus(rows[0].key, 'item');
        }}
      />
    </div>
  );
}

const NumCell = forwardRef<HTMLInputElement, { value: string; onChange: (v: string) => void; testid?: string; onKeyDown?: (e: React.KeyboardEvent) => void }>(function NumCell({ value, onChange, testid, ...rest }, ref) {
  return <input ref={ref} {...rest} value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} onFocus={(e) => e.target.select()} inputMode="decimal" className="input h-8 min-w-[64px] px-2 text-right tnum" data-testid={testid} />;
});

function ItemCell({ item, onPick, onText, inputRef }: { item: Item | null; onPick: (i: Item) => void; onText: (t: string) => void; inputRef: (el: HTMLInputElement | null) => void }) {
  const [q, setQ] = useState(item?.name ?? '');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const [creating, setCreating] = useState<string | null>(null);
  // Closing waits a moment (so clicks on the list land); refocusing cancels it.
  const closing = useRef<ReturnType<typeof setTimeout>>();
  // The list floats above the page (the grid scrolls and would clip it), placed under the input.
  const box = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = box.current?.getBoundingClientRect();
      if (r) setPos({ left: r.left, top: r.bottom + 4, width: Math.max(r.width, 360) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);
  useEffect(() => {
    if (item) setQ(item.name);
  }, [item]);
  const res = useQuery({ queryKey: ['items.list', { q, limit: 8 }], queryFn: () => call('items.list', { q, limit: 8 }), enabled: open && q.length > 0 && q !== item?.name });
  const list = res.data ?? [];
  const typedNew = !!q.trim() && !item;
  // The last option in the list is always "Create item" for text that isn't an item yet.
  const canCreate = typedNew && !list.some((i) => i.name.toLowerCase() === q.trim().toLowerCase());
  const options = list.length + (canCreate ? 1 : 0);
  return (
    <div className="relative">
      {creating !== null && <QuickItem name={creating} onClose={() => setCreating(null)} onCreated={(it) => (setCreating(null), onPick(it))} />}
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <input
        ref={(el) => ((box.current = el), inputRef(el))}
        value={q}
        onChange={(e) => (setQ(e.target.value), onText(e.target.value), setOpen(true), setHl(0))}
        onFocus={(e) => (clearTimeout(closing.current), e.target.select(), !item && q.trim() && setOpen(true))}
        onBlur={() => (closing.current = setTimeout(() => setOpen(false), 150))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHl((h) => Math.min(h + 1, options - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setHl((h) => Math.max(h - 1, 0)));
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (list[hl]) (onPick(list[hl]), setOpen(false));
            else if (canCreate) (setCreating(q.trim()), setOpen(false));
          }
        }}
        placeholder="Search item…"
        className={cn('input h-8 pl-8', typedNew && !open && 'border-warn ring-1 ring-warn/40')}
        title={typedNew ? 'Not an item yet: pick from the list or create it' : undefined}
        data-testid="pur-item"
      />
      {typedNew && !open && <span className="absolute -bottom-3.5 left-2 text-[10px] text-warn">Not an item yet — press Enter to create</span>}
      {open && options > 0 && pos && createPortal(
        <div style={{ position: 'fixed', left: pos.left, top: pos.top, width: pos.width }} className="z-50 max-h-80 overflow-auto rounded-lg border border-border bg-surface shadow-pop" data-testid="pur-item-list">
          {list.map((it, i) => (
            <button key={it.id} onMouseDown={(e) => (e.preventDefault(), onPick(it), setOpen(false))} className={cn('flex w-full justify-between px-3 py-2 text-left text-sm', i === hl ? 'bg-primary-soft' : 'hover:bg-surface-2')}>
              <span className="truncate">{it.name}</span>
              <span className="text-xs text-muted">{it.stock} {it.base_unit} · last {inr(it.purchase_price ?? 0)}</span>
            </button>
          ))}
          {canCreate && (
            <button onMouseDown={(e) => (e.preventDefault(), setCreating(q.trim()), setOpen(false))} className={cn('flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm font-medium text-primary', hl === list.length ? 'bg-primary-soft' : 'hover:bg-surface-2')} data-testid="pur-item-create">
              <Plus className="h-3.5 w-3.5" /> Create item “{q.trim()}”
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

const UNITS = ['Pcs', 'Kg', 'g', 'Ltr', 'ml', 'Box', 'Pack', 'Bag', 'Dozen', 'Bottle', 'Carton'];

/** Add a new item right from the purchase grid: name, unit, GST and prices; the rest can be filled later in Items. */
function QuickItem({ name, onClose, onCreated }: { name: string; onClose: () => void; onCreated: (i: Item) => void }) {
  const [f, setF] = useState({ name, unit: 'Pcs', gst: 5, hsn: '', mrp: 0, sell: 0 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const id = await call('items.save', { name: f.name.trim(), base_unit: f.unit, gst_rate: f.gst, hsn: f.hsn || null, mrp: f.mrp, retail_price: f.sell || f.mrp, purchase_price: 0, is_loose: ['Kg', 'g', 'Ltr', 'ml'].includes(f.unit) } as never);
      onCreated(await call('items.get', { id: id as number }));
      toast.success(`${f.name.trim()} added to your items`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="New item" description="Add the item now; set barcode, batches and other prices later in Items." size="sm"
      footer={<Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={save} data-testid="quick-item-save">Add item</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2"><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} data-testid="quick-item-name" /></Field>
        <Field label="Unit">
          <select className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
        </Field>
        <Field label="GST %">
          <select className="input" value={f.gst} onChange={(e) => setF({ ...f, gst: Number(e.target.value) })} data-testid="quick-item-gst">{[0, 5, 12, 18, 28, 40].map((g) => <option key={g} value={g}>{g}%</option>)}</select>
        </Field>
        <Field label="HSN (optional)"><Input inputMode="numeric" value={f.hsn} onChange={(e) => setF({ ...f, hsn: e.target.value.replace(/\D/g, '').slice(0, 8) })} /></Field>
        <Field label="MRP"><MoneyInput value={f.mrp} onChange={(mrp) => setF({ ...f, mrp })} /></Field>
        <Field label="Selling price" className="col-span-2" hint="Leave empty to sell at MRP."><MoneyInput value={f.sell} onChange={(sell) => setF({ ...f, sell })} /></Field>
      </div>
    </Dialog>
  );
}
