import { CURRENT_GST_SLABS, expiryBucket, GST_RATES, internalItemBarcode, marginPct, searchHsn, type Scheme } from '@hisaab/core';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BarcodeSvg } from '../../components/BarcodeSvg';
import { Badge, Button, Dialog, Drawer, Field, Input, Loading, MoneyInput, Segmented, Select, Switch, Tabs } from '../../components/ui';
import type { ItemUnit } from '../../db/types';
import { cn } from '../../lib/cn';
import { fmtDate, fmtQty, inr, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

const UNITS = ['Pcs', 'Kg', 'g', 'L', 'ml', 'Pkt', 'Box', 'Dozen', 'Bag', 'Bottle', 'Strip', 'Pair', 'Set', 'Mtr'];

export function ItemEditor({ id, onClose }: { id: number | null; onClose: () => void }) {
  const canDo = useCan();
  const existing = useApi('items.get', { id: id ?? 0 }, { enabled: !!id });
  const nextPlu = useApi('items.nextPlu', undefined, { enabled: !id });
  const [tab, setTab] = useState<'details' | 'stock' | 'variants'>('details');
  const [adjOpen, setAdjOpen] = useState(false);
  const [f, setF] = useState({
    name: '', short_code: '', barcode: '', plu: '', category: '', brand: '', hsn: '', gst_rate: 5, cess_rate: 0, base_unit: 'Pcs', is_loose: false, tax_inclusive: true,
    mrp: 0, retail_price: 0, wholesale_price: 0, super_price: 0, purchase_price: 0, coupon_value: 0, coupon_per: 0, reorder_level: 0, track_batch: false, active: true,
    units: [] as ItemUnit[], scheme: null as Scheme | null, openingQty: '', openingExpiry: '', openingBatch: '',
  });
  const [hsnQ, setHsnQ] = useState('');
  useEffect(() => {
    const it = existing.data;
    if (!it) return;
    setF((s) => ({
      ...s,
      name: it.name, short_code: it.short_code ?? '', barcode: it.barcode ?? '', plu: it.plu ?? '', category: it.category ?? '', brand: it.brand ?? '', hsn: it.hsn ?? '',
      gst_rate: it.gst_rate, cess_rate: it.cess_rate, base_unit: it.base_unit, is_loose: !!it.is_loose, tax_inclusive: !!it.tax_inclusive,
      mrp: it.mrp, retail_price: it.retail_price, wholesale_price: it.wholesale_price ?? 0, super_price: it.super_price ?? 0, purchase_price: it.purchase_price ?? 0, coupon_value: it.coupon_value ?? 0, coupon_per: it.coupon_per ?? 0,
      reorder_level: it.reorder_level, track_batch: !!it.track_batch, active: !!it.active, units: it.units.slice(1), scheme: it.scheme,
    }));
  }, [existing.data]);
  useEffect(() => {
    if (!id && f.is_loose && !f.plu && nextPlu.data) setF((s) => ({ ...s, plu: nextPlu.data! }));
  }, [f.is_loose, id, nextPlu.data, f.plu]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const cats = useApi('items.categories');
  const save = useAction('items.save', { success: id ? 'Item saved' : 'Item added', onSuccess: onClose });
  const hsn = searchHsn(hsnQ, 6);
  const canCost = canDo('cost.view');
  const exclusiveSell = f.tax_inclusive ? Math.round(f.retail_price / (1 + f.gst_rate / 100)) : f.retail_price;
  const m = f.purchase_price && f.retail_price ? marginPct(exclusiveSell, f.purchase_price) : null;
  const readonly = !canDo('item.edit');

  const submit = () =>
    save.mutate({
      id: id ?? undefined,
      ...f,
      wholesale_price: f.wholesale_price || null,
      super_price: f.super_price || null,
      purchase_price: canCost ? f.purchase_price : undefined,
      coupon_value: canCost ? f.coupon_value : undefined,
      coupon_per: canCost ? f.coupon_per : undefined,
      plu: f.is_loose ? f.plu : null,
      opening: !id && Number(f.openingQty) ? { qty: Number(f.openingQty), cost: f.purchase_price, expiry: f.openingExpiry || null, batchNo: f.openingBatch || null } : null,
    });

  if (id && !existing.data) return <Drawer open onOpenChange={(v) => !v && onClose()} title="Item"><Loading /></Drawer>;
  const it = existing.data;

  return (
    <Drawer
      open
      onOpenChange={(v) => !v && onClose()}
      title={id ? it?.name : 'New item'}
      width="max-w-2xl"
      footer={
        readonly ? undefined : (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} disabled={!f.name.trim()} onClick={submit} data-testid="item-save">{id ? 'Save changes' : 'Add item'}</Button>
          </>
        )
      }
    >
      {id && (
        <div className="mb-4">
          <Tabs value={tab} onChange={setTab} tabs={[{ value: 'details', label: 'Details & prices' }, { value: 'stock', label: 'Stock & batches', count: it?.batches?.length }, ...(it && !(it as { parent_id?: number | null }).parent_id ? [{ value: 'variants' as const, label: 'Variants' }] : [])]} />
        </div>
      )}
      {tab === 'variants' && it ? (
        <Variants parentId={it.id} />
      ) : tab === 'stock' && it ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-xl bg-surface-2 p-4">
            <div>
              <div className="text-xs text-muted">In stock</div>
              <div className="text-2xl font-semibold tnum">{fmtQty(it.stock)} {it.base_unit}</div>
            </div>
            {canDo('stock.adjust') && <Button variant="outline" onClick={() => setAdjOpen(true)}>Adjust stock</Button>}
          </div>
          <table className="table-base">
            <thead><tr><th>Batch</th><th>Expiry</th><th className="text-right">Qty</th><th className="text-right">MRP</th>{canCost && <th className="text-right">Cost</th>}</tr></thead>
            <tbody>
              {it.batches?.map((b) => {
                const bucket = expiryBucket(b.expiry, today());
                return (
                  <tr key={b.id}>
                    <td className="font-mono text-xs">{b.batch_no ?? '—'}</td>
                    <td>{b.expiry ? <Badge tone={bucket === 'expired' ? 'bad' : bucket === 'd30' ? 'warn' : bucket === 'd90' ? 'saffron' : 'neutral'}>{fmtDate(b.expiry)}</Badge> : '—'}</td>
                    <td className="text-right tnum">{fmtQty(b.qty)}</td>
                    <td className="text-right text-muted">{b.mrp ? inr(b.mrp) : '—'}</td>
                    {canCost && <td className="text-right text-muted">{inr(b.cost ?? 0)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <h4 className="text-sm font-semibold">Recent movement</h4>
          <table className="table-base text-xs">
            <tbody>
              {(it.moves as Array<{ id: number; date: string; reason: string; qty: number; ref_number: string | null; note: string | null }> | undefined)?.map((mv) => (
                <tr key={mv.id}>
                  <td className="text-muted">{fmtDate(mv.date)}</td>
                  <td className="capitalize">{mv.reason.replace('_', ' ')} {mv.ref_number && <span className="font-mono text-faint">{mv.ref_number}</span>} {mv.note && <span className="text-faint">· {mv.note}</span>}</td>
                  <td className={cn('text-right font-medium tnum', mv.qty < 0 ? 'text-bad' : 'text-good')}>{mv.qty > 0 ? '+' : ''}{fmtQty(mv.qty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {adjOpen && <AdjustDialog itemId={it.id} unit={it.base_unit} batches={it.batches ?? []} onClose={() => setAdjOpen(false)} />}
        </div>
      ) : (
        <fieldset disabled={readonly} className="space-y-5">
          <section className="grid gap-3 sm:grid-cols-2">
            <Field label="Item name *" className="sm:col-span-2"><Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Toor Dal 1kg" data-testid="item-name" /></Field>
            <Field label="Category">
              <Input list="cats" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="e.g. Pulses & Dal" />
              <datalist id="cats">{cats.data?.map((c) => <option key={c} value={c} />)}</datalist>
            </Field>
            <Field label="Brand"><Input value={f.brand} onChange={(e) => set('brand', e.target.value)} /></Field>
            <Field label="Short code" hint="Type it at the counter, e.g. SUG"><Input value={f.short_code} onChange={(e) => set('short_code', e.target.value.toUpperCase())} className="font-mono" /></Field>
            <Field label="Barcode" hint={<button type="button" className="text-primary hover:underline" onClick={() => set('barcode', internalItemBarcode(id ?? Date.now() % 1e8))}>Generate one</button>}>
              <Input value={f.barcode} onChange={(e) => set('barcode', e.target.value.replace(/\s/g, ''))} className="font-mono" placeholder="Scan or type" />
            </Field>
            {f.barcode && /^\d{13}$/.test(f.barcode) && <div className="sm:col-span-2"><BarcodeSvg code={f.barcode} height={34} /></div>}
          </section>

          <section className="rounded-xl border border-border p-4">
            <h4 className="mb-3 text-sm font-semibold">Units</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Sell / stock in">
                <Select value={f.base_unit} onChange={(e) => set('base_unit', e.target.value)}>{UNITS.map((u) => <option key={u}>{u}</option>)}</Select>
              </Field>
              <div className="sm:col-span-2 flex items-end pb-1.5">
                <Switch checked={f.is_loose} onChange={(v) => (set('is_loose', v), v && set('base_unit', f.base_unit === 'Pcs' ? 'Kg' : f.base_unit))} label="Loose / weighed item" hint={f.is_loose ? `Scale barcode PLU ${f.plu || '—'} · sells in fractions` : 'Rice, sugar, dal sold by weight'} />
              </div>
            </div>
            <div className="mt-3 space-y-2">
              {f.units.map((u, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-sm text-muted">1</span>
                  <Input className="w-32" value={u.name} onChange={(e) => set('units', f.units.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Box" />
                  <span className="text-sm text-muted">=</span>
                  <Input className="w-20" inputMode="decimal" value={u.factor || ''} onChange={(e) => set('units', f.units.map((x, j) => (j === i ? { ...x, factor: Number(e.target.value) || 0 } : x)))} />
                  <span className="text-sm text-muted">{f.base_unit}</span>
                  <MoneyInput className="w-32" placeholder="Price (auto)" value={u.price ?? 0} onChange={(v) => set('units', f.units.map((x, j) => (j === i ? { ...x, price: v || null } : x)))} />
                  <button type="button" onClick={() => set('units', f.units.filter((_, j) => j !== i))} className="grid h-8 w-8 place-items-center rounded-md text-faint hover:bg-bad-soft hover:text-bad"><Trash2 className="h-4 w-4" /></button>
                </div>
              ))}
              <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => set('units', [...f.units, { name: '', factor: 12, price: null }])}>Add bigger unit (box, carton, bag)</Button>
            </div>
          </section>

          <section className="rounded-xl border border-border p-4">
            <h4 className="mb-3 text-sm font-semibold">Prices <span className="font-normal text-muted">per {f.base_unit}</span></h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="MRP"><MoneyInput value={f.mrp} onChange={(v) => set('mrp', v)} /></Field>
              <Field label="Selling (retail) *" error={f.mrp && f.retail_price > f.mrp ? 'Above MRP' : null}><MoneyInput value={f.retail_price} onChange={(v) => set('retail_price', v)} data-testid="item-price" /></Field>
              {canCost && <Field label="Purchase cost" hint={`${m !== null ? `Margin ${m}% · ` : 'Before GST · '}Updates opening stock and its past sales. Wrong rate on a purchase bill? Edit that bill.`}><MoneyInput value={f.purchase_price} onChange={(v) => set('purchase_price', v)} data-testid="item-cost" /></Field>}
              <Field label="Wholesale rate"><MoneyInput value={f.wholesale_price} onChange={(v) => set('wholesale_price', v)} /></Field>
              <Field label="Super-stockist rate"><MoneyInput value={f.super_price} onChange={(v) => set('super_price', v)} /></Field>
              <div className="flex items-end pb-1.5"><Switch checked={f.tax_inclusive} onChange={(v) => set('tax_inclusive', v)} label="Price includes GST" /></div>
            </div>
          </section>

          {canCost && (
            <section className="rounded-xl border border-border p-4" data-testid="item-coupon">
              <h4 className="text-sm font-semibold">Supplier coupon / scheme <span className="font-normal text-muted">optional</span></h4>
              <p className="mb-3 text-xs text-muted">E.g. a coupon in every 5 packs of pan masala that you redeem with the distributor. It lowers the real cost, so selling a little under the bill rate isn't shown as a loss. You can change it on each purchase bill.</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Coupon worth"><MoneyInput value={f.coupon_value} onChange={(v) => set('coupon_value', v)} data-testid="item-coupon-value" /></Field>
                <Field label={`One coupon per (${f.base_unit})`}><Input type="number" min={0} step="any" value={f.coupon_per || ''} onChange={(e) => set('coupon_per', Math.max(0, Number(e.target.value) || 0))} placeholder="e.g. 5" data-testid="item-coupon-per" /></Field>
                <div className="flex items-end pb-2 text-sm">
                  {f.coupon_value > 0 && f.coupon_per > 0 && f.purchase_price > 0 ? (
                    <span data-testid="item-real-cost">Real cost <b>{inr(Math.round(f.purchase_price - f.coupon_value / f.coupon_per))}</b> <span className="text-muted">(bill {inr(f.purchase_price)} − coupon {inr(Math.round(f.coupon_value / f.coupon_per))})</span></span>
                  ) : <span className="text-faint">No coupon</span>}
                </div>
              </div>
            </section>
          )}

          <section className="rounded-xl border border-border p-4">
            <h4 className="mb-3 text-sm font-semibold">GST</h4>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="HSN code" className="relative">
                <Input value={f.hsn || hsnQ} onChange={(e) => (set('hsn', ''), setHsnQ(e.target.value))} placeholder="Search: rice, 1006…" className="font-mono" />
                {!f.hsn && hsnQ && (
                  <div className="absolute left-0 top-full z-10 mt-1 w-[420px] overflow-hidden rounded-lg border border-border bg-surface shadow-pop">
                    {hsn.map((h) => (
                      <button type="button" key={h.code + h.description} onClick={() => (set('hsn', h.code), set('gst_rate', h.rate), setHsnQ(''))} className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2">
                        <span className="w-20 font-mono text-xs">{h.code}</span>
                        <span className="flex-1 truncate">{h.description}</span>
                        <Badge tone="primary">{h.rate}%</Badge>
                      </button>
                    ))}
                    {!hsn.length && <button type="button" className="w-full px-3 py-2 text-left text-sm" onClick={() => (set('hsn', hsnQ.replace(/\D/g, '')), setHsnQ(''))}>Use “{hsnQ}”</button>}
                  </div>
                )}
              </Field>
              <Field label="GST rate" hint="GST 2.0 slabs: 0, 5, 18, 40">
                <Select value={f.gst_rate} onChange={(e) => set('gst_rate', Number(e.target.value))}>
                  {GST_RATES.map((r) => <option key={r} value={r}>{r}%{(CURRENT_GST_SLABS as readonly number[]).includes(r) ? '' : ' (special/legacy)'}</option>)}
                </Select>
              </Field>
              <Field label="Cess %"><Input inputMode="decimal" value={f.cess_rate || ''} onChange={(e) => set('cess_rate', Number(e.target.value) || 0)} placeholder="0" /></Field>
            </div>
          </section>

          <section className="rounded-xl border border-border p-4">
            <h4 className="mb-3 text-sm font-semibold">Stock control & schemes</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={`Reorder at (${f.base_unit})`} hint="Shows in Running low"><Input inputMode="decimal" value={f.reorder_level || ''} onChange={(e) => set('reorder_level', Number(e.target.value) || 0)} /></Field>
              <div className="flex items-end pb-1.5"><Switch checked={f.track_batch} onChange={(v) => set('track_batch', v)} label="Track batch & expiry" hint="FIFO — earliest expiry sells first" /></div>
            </div>
            <div className="mt-4">
              <span className="label">Scheme / offer</span>
              <Segmented size="sm" value={f.scheme?.type ?? 'none'} onChange={(v) => set('scheme', v === 'none' ? null : v === 'bxgy' ? { type: 'bxgy', buy: 10, free: 1 } : { type: 'slab', slabs: [{ minQty: 10, discountPct: 2 }] })} options={[{ value: 'none', label: 'None' }, { value: 'bxgy', label: 'Buy X get Y free' }, { value: 'slab', label: 'Quantity discount' }]} />
              {f.scheme?.type === 'bxgy' && (
                <div className="mt-2 flex items-center gap-2 text-sm">
                  Buy <Input className="w-20" inputMode="numeric" value={f.scheme.buy} onChange={(e) => set('scheme', { type: 'bxgy', buy: Number(e.target.value) || 0, free: (f.scheme as { free: number }).free })} />
                  get <Input className="w-20" inputMode="numeric" value={f.scheme.free} onChange={(e) => set('scheme', { type: 'bxgy', buy: (f.scheme as { buy: number }).buy, free: Number(e.target.value) || 0 })} /> free
                </div>
              )}
              {f.scheme?.type === 'slab' && (
                <div className="mt-2 space-y-2">
                  {f.scheme.slabs.map((s, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      From <Input className="w-20" inputMode="numeric" value={s.minQty} onChange={(e) => set('scheme', { type: 'slab', slabs: (f.scheme as { slabs: typeof s[] }).slabs.map((x, j) => (j === i ? { ...x, minQty: Number(e.target.value) || 0 } : x)) })} /> {f.base_unit}
                      → <Input className="w-20" inputMode="decimal" value={s.discountPct} onChange={(e) => set('scheme', { type: 'slab', slabs: (f.scheme as { slabs: typeof s[] }).slabs.map((x, j) => (j === i ? { ...x, discountPct: Number(e.target.value) || 0 } : x)) })} /> % off
                    </div>
                  ))}
                  <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => set('scheme', { type: 'slab', slabs: [...(f.scheme as { slabs: Array<{ minQty: number; discountPct: number }> }).slabs, { minQty: 50, discountPct: 4 }] })}>Add slab</Button>
                </div>
              )}
            </div>
          </section>

          {!id && (
            <section className="rounded-xl border border-dashed border-border p-4">
              <h4 className="mb-3 text-sm font-semibold">Opening stock <span className="font-normal text-muted">(optional)</span></h4>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={`Quantity (${f.base_unit})`}><Input inputMode="decimal" value={f.openingQty} onChange={(e) => set('openingQty', e.target.value.replace(/[^\d.]/g, ''))} data-testid="item-opening" /></Field>
                {f.track_batch && <Field label="Batch"><Input value={f.openingBatch} onChange={(e) => set('openingBatch', e.target.value.toUpperCase())} /></Field>}
                {f.track_batch && <Field label="Expiry"><Input type="date" value={f.openingExpiry} onChange={(e) => set('openingExpiry', e.target.value)} /></Field>}
              </div>
            </section>
          )}
          {id && <Switch checked={f.active} onChange={(v) => set('active', v)} label="Active" hint="Inactive items are hidden from billing" />}
        </fieldset>
      )}
      {tab === 'stock' && it && <GodownStock itemId={it.id} />}
    </Drawer>
  );
}

function AdjustDialog({ itemId, unit, batches, onClose }: { itemId: number; unit: string; batches: Array<{ id: number; batch_no: string | null; qty: number }>; onClose: () => void }) {
  const [dir, setDir] = useState<'add' | 'remove'>('remove');
  const [qty, setQty] = useState('');
  const [batchId, setBatchId] = useState<string>('');
  const [reason, setReason] = useState('Damaged / expired');
  const act = useAction('items.adjust', { success: 'Stock updated', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Adjust stock" description="For counting differences, damage, expiry write-off or opening stock." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={act.isPending} disabled={!Number(qty)} onClick={() => act.mutate({ itemId, delta: (dir === 'add' ? 1 : -1) * Number(qty), batchId: batchId ? Number(batchId) : null, note: reason })}>Save</Button></>}>
      <div className="space-y-3">
        <Segmented value={dir} onChange={setDir} options={[{ value: 'remove', label: 'Remove' }, { value: 'add', label: 'Add' }]} />
        <Field label={`Quantity (${unit})`}><Input autoFocus inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        {batches.length > 1 && (
          <Field label="Batch"><Select value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">Auto</option>{batches.map((b) => <option key={b.id} value={b.id}>{b.batch_no ?? 'No batch'} · {b.qty}</option>)}</Select></Field>
        )}
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}>{['Damaged / expired', 'Stock count correction', 'Own use', 'Free sample', 'Opening stock', 'Other'].map((r) => <option key={r}>{r}</option>)}</Select></Field>
      </div>
    </Dialog>
  );
}

function GodownStock({ itemId }: { itemId: number }) {
  const rows = useApi('stock.byGodown', { itemId }).data ?? [];
  if (rows.length < 2) return null;
  return (
    <div className="mt-4 rounded-lg border border-border p-3 text-sm" data-testid="item-godowns">
      <p className="mb-1 font-medium">By godown</p>
      {rows.map((g) => (
        <div key={g.godown_id} className="flex justify-between"><span>{g.name}</span><span className="tnum">{g.qty}</span></div>
      ))}
    </div>
  );
}

/** Size / colour variants: each becomes its own item with its own barcode, price and stock. */
function Variants({ parentId }: { parentId: number }) {
  const list = useApi('items.variants', { parentId });
  const [text, setText] = useState('');
  const add = useAction('items.createVariants', { success: (ids) => `${ids.length} variant${ids.length > 1 ? 's' : ''} added`, onSuccess: () => setText('') });
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Selling the same product in sizes or colours? Add each as a variant. It gets its own barcode, price and stock, and appears in billing search.</p>
      <div className="flex gap-2">
        <Input placeholder="e.g. S, M, L, XL  or  Red, Blue" value={text} onChange={(e) => setText(e.target.value)} data-testid="variant-input" />
        <Button variant="primary" disabled={!text.trim()} loading={add.isPending} onClick={() => add.mutate({ parentId, variants: text.split(',').map((v) => ({ variant: v.trim() })).filter((v) => v.variant) })} data-testid="variant-add">Add</Button>
      </div>
      <table className="table-base text-sm">
        <thead><tr><th>Variant</th><th>Barcode</th><th className="text-right">Price</th><th className="text-right">Stock</th></tr></thead>
        <tbody>
          {(list.data ?? []).map((v) => (
            <tr key={v.id}><td>{v.variant}</td><td className="font-mono text-xs">{v.barcode ?? '—'}</td><td className="text-right tnum">{inr(v.retail_price)}</td><td className="text-right tnum">{v.stock}</td></tr>
          ))}
          {!list.data?.length && <tr><td colSpan={4} className="text-faint">No variants yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
