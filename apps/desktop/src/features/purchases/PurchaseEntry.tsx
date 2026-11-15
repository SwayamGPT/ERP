import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ClipboardList, Plus, Save, Search, Trash2, Truck } from 'lucide-react';
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ImportBillButton } from './ImportBill';
import { useApi } from '../../lib/useApi';
import { Badge, Button, Card, Field, Input, Kbd, MoneyInput, PageHeader, Segmented, toast } from '../../components/ui';
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
  unit: string;
  factor: number;
  qty: string;
  free: string;
  rate: string; // rupees, excl. GST
  disc: string;
  batch: string;
  expiry: string;
  mrp: string;
}

let K = 0;
const blank = (): Row => ({ key: ++K, item: null, unit: '', factor: 1, qty: '', free: '', rate: '', disc: '', batch: '', expiry: '', mrp: '' });
const COLS = ['item', 'qty', 'free', 'rate', 'disc', 'batch', 'expiry', 'mrp'] as const;

/** A filled row for an item (from a purchase order or an imported bill). Rates in paise. */
export function rowFor(item: Item, o: { qty: number; rate?: number; batch?: string; expiry?: string; mrp?: number; unit?: string; factor?: number } ) {
  const factor = o.factor ?? 1;
  const rate = o.rate ?? Math.round((item.purchase_price ?? 0) * factor);
  return { ...blank(), item, unit: o.unit ?? item.base_unit, factor, qty: String(o.qty), rate: rate ? (rate / 100).toFixed(2) : '', batch: o.batch ?? '', expiry: o.expiry ?? '', mrp: (o.mrp ?? item.mrp) ? (((o.mrp ?? item.mrp) as number) / 100).toFixed(2) : '' };
}

export function PurchaseEntry() {
  const navigate = useNavigate();
  const canDo = useCan();
  const [supplier, setSupplier] = useState<Party | null>(null);
  const [pick, setPick] = useState(true);
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState<Row[]>([blank()]);
  const [other, setOther] = useState(0);
  const [payNow, setPayNow] = useState<'none' | 'cash' | 'bank' | 'upi'>('none');
  const [saving, setSaving] = useState(false);
  const [po, setPo] = useState<{ id: number; number: string } | null>(null);
  const [godownId, setGodownId] = useState<number | null>(null);
  const godowns = useApi('stock.godowns').data ?? [];
  const [params] = useSearchParams();
  const poParam = Number(params.get('po')) || null;
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
        })),
    }),
    [rows, supplier?.id, date, billNo, other, po?.id, godownId],
  );
  const preview = useQuery({ queryKey: ['invoices.preview', draft], queryFn: () => call('invoices.preview', draft), enabled: !!supplier && draft.lines.length > 0, placeholderData: keepPreviousData });
  const t = draft.lines.length ? preview.data?.totals : undefined;

  const save = async () => {
    if (!supplier) return setPick(true);
    if (!draft.lines.length) return toast.info('Add at least one item with quantity');
    setSaving(true);
    try {
      const payable = t?.payable ?? 0;
      const inv = await call('invoices.create', { ...draft, payments: payNow !== 'none' && payable > 0 ? [{ mode: payNow, amount: payable }] : [] });
      toast.success(`Purchase ${inv.number} saved`, `Stock updated for ${inv.lines?.length} items`);
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
      <PageHeader icon={<Truck className="h-5 w-5" />} title="New purchase" subtitle="Enter the supplier's bill. Stock, batches, cost and input GST update automatically." actions={<><ImportBillButton onLoad={(list) => setRows([...list.map((x) => rowFor(x.item, x)), blank()])} /><Button variant="primary" icon={<Save className="h-4 w-4" />} kbd="F9" loading={saving} onClick={save} data-testid="purchase-save">Save purchase</Button></>} />
      {po && (
        <p className="mb-3 flex items-center gap-2 rounded-lg bg-primary/5 px-3 py-2 text-sm text-primary" data-testid="purchase-from-po">
          <ClipboardList className="h-4 w-4" /> Receiving goods against {po.number}. Change quantities to what actually arrived.
        </p>
      )}
      <Card className="mb-4">
        <div className="grid gap-4 md:grid-cols-4 xl:grid-cols-5">
          <Field label="Supplier *">
            <button onClick={() => setPick(true)} className="input flex items-center justify-between text-left" data-testid="purchase-supplier">
              <span className={supplier ? '' : 'text-faint'}>{supplier?.name ?? 'Pick supplier…'}</span>
              <Kbd>F7</Kbd>
            </button>
          </Field>
          <Field label="Supplier bill no."><Input value={billNo} onChange={(e) => setBillNo(e.target.value)} placeholder="e.g. MD/2291" /></Field>
          <Field label="Bill date"><Input type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></Field>
          {godowns.length > 1 && (
            <Field label="Goods go to">
              <select className="input" value={godownId ?? godowns.find((g) => g.is_default)?.id ?? 1} onChange={(e) => setGodownId(Number(e.target.value))} data-testid="purchase-godown">
                {godowns.filter((g) => g.active).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Tax" hint={supplier ? (preview.data?.interState ? 'Other state → IGST input' : 'Same state → CGST + SGST input') : ' '}>
            <div className="flex h-9 items-center">{supplier?.gstin ? <Badge tone="good">GSTIN {supplier.gstin}</Badge> : <Badge>Unregistered supplier</Badge>}</div>
          </Field>
        </div>
      </Card>

      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="table-base min-w-[1000px]">
            <thead>
              <tr>
                <th className="w-8">#</th>
                <th className="min-w-[260px]">Item</th>
                <th className="w-24">Unit</th>
                <th className="w-20 text-right">Qty</th>
                <th className="w-20 text-right">Free</th>
                <th className="w-28 text-right">Rate (excl. GST)</th>
                <th className="w-16 text-right">Disc %</th>
                <th className="w-28">Batch</th>
                <th className="w-36">Expiry</th>
                <th className="w-24 text-right">MRP</th>
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
                        onPick={(it) => {
                          update(r.key, { item: it, unit: it.base_unit, factor: 1, rate: it.purchase_price ? (it.purchase_price / 100).toFixed(2) : '', mrp: it.mrp ? (it.mrp / 100).toFixed(2) : '' });
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
                    <td className="text-right font-medium tnum">{r.item ? inr(amt) : ''}</td>
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
  return <input ref={ref} {...rest} value={value} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))} onFocus={(e) => e.target.select()} inputMode="decimal" className="input h-8 px-2 text-right tnum" data-testid={testid} />;
});

function ItemCell({ item, onPick, inputRef }: { item: Item | null; onPick: (i: Item) => void; inputRef: (el: HTMLInputElement | null) => void }) {
  const [q, setQ] = useState(item?.name ?? '');
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  useEffect(() => setQ(item?.name ?? ''), [item]);
  const res = useQuery({ queryKey: ['items.list', { q, limit: 8 }], queryFn: () => call('items.list', { q, limit: 8 }), enabled: open && q.length > 0 && q !== item?.name });
  const list = res.data ?? [];
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setHl(0))}
        onFocus={(e) => e.target.select()}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setHl((h) => Math.min(h + 1, list.length - 1)));
          if (e.key === 'ArrowUp') (e.preventDefault(), setHl((h) => Math.max(h - 1, 0)));
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            if (list[hl]) (onPick(list[hl]), setOpen(false));
          }
        }}
        placeholder="Search item…"
        className="input h-8 pl-8"
        data-testid="pur-item"
      />
      {open && list.length > 0 && (
        <div className="absolute left-0 top-full z-20 mt-1 w-[360px] overflow-hidden rounded-lg border border-border bg-surface shadow-pop">
          {list.map((it, i) => (
            <button key={it.id} onMouseDown={(e) => (e.preventDefault(), onPick(it), setOpen(false))} className={cn('flex w-full justify-between px-3 py-2 text-left text-sm', i === hl ? 'bg-primary-soft' : 'hover:bg-surface-2')}>
              <span className="truncate">{it.name}</span>
              <span className="text-xs text-muted">{it.stock} {it.base_unit} · last {inr(it.purchase_price ?? 0)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
