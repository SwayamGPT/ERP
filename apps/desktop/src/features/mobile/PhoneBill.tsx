import { resolvePrice, type PriceTier } from '@hisaab/core';
import { Check, MessageCircle, Minus, Plus, Printer, Search, Smartphone, UserRound, Wifi, X } from 'lucide-react';
import { useState } from 'react';
import { printInvoice } from '../../components/print/PrintInvoice';
import { Button, Dialog, Field, Input, Segmented, toast } from '../../components/ui';
import { call, LAN } from '../../db/client';
import type { Company, Invoice, Item, Party } from '../../db/types';
import { fmtDate, fmtQty, inr } from '../../lib/format';
import { useDevice } from '../../lib/devicePrefs';
import { billMessage, whatsappLink } from '../../lib/share';
import { useApi } from '../../lib/useApi';
import { autoPrinted, lanPrint } from '../../lan/client';
import { isNative, native } from '../../native';
import { receiptBytes } from '../../native/print';

type Line = { item: Item; qty: number };
type Mode = 'cash' | 'upi' | 'card' | 'credit';

/** A quick bill on the phone. Saved straight onto the shop computer (or this device's own data). */
export function PhoneBill({ company }: { company: Company }) {
  const [party, setParty] = useState<Party | null>(null);
  const [picking, setPicking] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [mode, setMode] = useState<Mode>('cash');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<{ inv: Invoice; printed: boolean } | null>(null);
  const tier = (party?.price_tier as PriceTier) ?? 'retail';
  const price = (i: Item) => resolvePrice({ mrp: i.mrp, retail: i.retail_price, wholesale: i.wholesale_price, super: i.super_price }, tier).price;
  const draftLines = lines.map((l) => ({ itemId: l.item.id, unit: l.item.base_unit, factor: 1, qty: l.qty, rate: price(l.item) }));
  const preview = useApi('invoices.preview', { kind: 'sale', partyId: party?.id ?? null, lines: draftLines }, { enabled: lines.length > 0 });
  const total = lines.length ? preview.data?.totals.payable ?? 0 : 0;
  const add = (item: Item) => setLines((ls) => (ls.some((l) => l.item.id === item.id) ? ls.map((l) => (l.item.id === item.id ? { ...l, qty: l.qty + 1 } : l)) : [...ls, { item, qty: 1 }]));
  const setQty = (id: number, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.item.id !== id) : ls.map((l) => (l.item.id === id ? { ...l, qty } : l))));

  const save = async () => {
    if (mode === 'credit' && !party) return setPicking(true);
    setBusy(true);
    try {
      const amount = preview.isFetching || !preview.data ? (await preview.refetch()).data?.totals.payable ?? 0 : total;
      const inv = await call('invoices.create', { kind: 'sale', partyId: party?.id ?? null, lines: draftLines, payments: mode === 'credit' ? [] : [{ mode, amount }] });
      setSaved({ inv, printed: LAN && autoPrinted() });
      setLines([]);
      setParty(null);
      setMode('cash');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (picking) return <PickParty onPick={(p) => (setParty(p), setPicking(false))} onCancel={() => setPicking(false)} />;
  return (
    <div className="space-y-3" data-testid="m-bill">
      <button className="flex w-full items-center justify-between rounded-xl border border-border bg-surface p-3 text-left" onClick={() => setPicking(true)} data-testid="m-bill-customer">
        <span className="flex items-center gap-2"><UserRound className="h-4 w-4 text-muted" /><span className="font-medium">{party?.name ?? 'Cash'}</span></span>
        <span className="text-xs text-primary">{party ? 'Change' : 'Pick customer'}</span>
      </button>
      <ItemPicker onPick={add} price={price} />
      {lines.length > 0 && (
        <div className="divide-y divide-border rounded-xl border border-border bg-surface">
          {lines.map((l) => (
            <div key={l.item.id} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{l.item.name}</p>
                <p className="text-xs text-muted">{inr(price(l.item))} / {l.item.base_unit} · stock {fmtQty(l.item.stock)}</p>
              </div>
              <button className="grid h-8 w-8 place-items-center rounded-lg border border-border" onClick={() => setQty(l.item.id, l.qty - 1)} aria-label="Less"><Minus className="h-4 w-4" /></button>
              <input className="input h-8 w-14 text-center tnum" inputMode="decimal" value={l.qty} onChange={(e) => setQty(l.item.id, Number(e.target.value) || 0)} data-testid="m-bill-qty" />
              <button className="grid h-8 w-8 place-items-center rounded-lg border border-border" onClick={() => setQty(l.item.id, l.qty + 1)} aria-label="More"><Plus className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
      {lines.length > 0 && preview.data?.belowCost && (
        <p className="rounded-lg bg-bad/10 p-2 text-sm font-medium text-bad" data-testid="m-bill-loss">Selling below purchase cost{preview.data.loss != null ? ` · loss ${inr(preview.data.loss)}` : ''}</p>
      )}
      <Segmented full value={mode} onChange={setMode} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card' }, { value: 'credit', label: 'Udhaar' }]} />
      <div className="sticky bottom-0 -mx-4 border-t border-border bg-surface px-4 py-3">
        <Button variant="primary" size="lg" className="w-full" icon={<Check className="h-4 w-4" />} disabled={!lines.length || !total} loading={busy} onClick={save} data-testid="m-bill-save">
          Save bill · {inr(total)}
        </Button>
      </div>
      {saved && <AfterSave inv={saved.inv} printed={saved.printed} company={company} onClose={() => setSaved(null)} />}
    </div>
  );
}

/** After saving: print on the counter printer (default), a Wi-Fi printer, this phone, or WhatsApp. */
function AfterSave({ inv, printed, company, onClose }: { inv: Invoice; printed: boolean; company: Company; onClose: () => void }) {
  const d = useDevice();
  const [phone, setPhone] = useState(inv.party_phone ?? '');
  const [wifi, setWifi] = useState(d.wifiPrinter);
  const [done, setDone] = useState<string | null>(printed ? 'Printing on the counter printer…' : null);
  const run = (label: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn();
      setDone(label);
    } catch (e) {
      toast.error(e);
    }
  };
  const counter = LAN ? run('Sent to the counter printer', () => lanPrint(inv.id, 'counter')) : null;
  // The Android app prints to a Wi-Fi thermal printer itself; a browser asks the computer to.
  const wifiPrint = isNative()
    ? run(`Printed on ${wifi}`, async () => {
        if (!wifi.trim()) throw new Error('Enter the Wi-Fi printer address, e.g. 192.168.1.60.');
        d.set({ wifiPrinter: wifi.trim() });
        await native.printRaw(wifi.trim(), receiptBytes(inv, company, { drawer: false }));
      })
    : LAN
      ? run('Sent to the Wi-Fi printer', () => lanPrint(inv.id, 'network'))
      : null;
  const wa = whatsappLink(phone, billMessage({ shop: company.name, number: inv.number, date: fmtDate(inv.date), total: inv.total, items: inv.lines?.length ?? 0, balance: inv.total - inv.paid, upi: company.upi_id }));
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Bill ${inv.number} saved`} description={`${inv.party_name} · ${inr(inv.total)}`} size="sm"
      footer={<Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={onClose} data-testid="m-bill-done">Done</Button>}>
      <div className="space-y-2" data-testid="m-bill-after">
        {done && <p className="rounded-lg bg-good/10 p-2 text-sm text-good" data-testid="m-bill-status">{done}</p>}
        {counter && <Button variant="primary" className="w-full" icon={<Printer className="h-4 w-4" />} onClick={counter} data-testid="m-print-counter">{printed ? 'Print again on counter printer' : 'Print on counter printer'}</Button>}
        {wifiPrint && (
          <div className="flex gap-2">
            {isNative() && <Input value={wifi} onChange={(e) => setWifi(e.target.value)} placeholder="Wi-Fi printer IP" inputMode="url" />}
            <Button variant="outline" className="flex-1" icon={<Wifi className="h-4 w-4" />} onClick={wifiPrint} data-testid="m-print-wifi">Wi-Fi printer</Button>
          </div>
        )}
        <Button variant="outline" className="w-full" icon={<Smartphone className="h-4 w-4" />} onClick={() => printInvoice(inv, company)} data-testid="m-print-phone">Print / PDF from this phone</Button>
        <Field label="WhatsApp to">
          <div className="flex gap-2">
            <Input value={phone} onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))} inputMode="tel" placeholder="Customer's mobile" data-testid="m-wa-phone" />
            <a className={`btn btn-outline inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium ${phone.length >= 10 ? '' : 'pointer-events-none opacity-50'}`} href={wa} target="_blank" rel="noreferrer" data-testid="m-wa-send">
              <MessageCircle className="h-4 w-4 text-good" /> Send
            </a>
          </div>
        </Field>
      </div>
    </Dialog>
  );
}

function PickParty({ onPick, onCancel }: { onPick: (p: Party | null) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');
  const list = useApi('parties.list', { kind: 'customer', q, limit: 40 });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input autoFocus prefix={<Search className="h-4 w-4" />} placeholder="Customer name or phone" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-bill-party-search" />
        <Button variant="ghost" onClick={onCancel}>Back</Button>
      </div>
      <div className="divide-y divide-border rounded-xl border border-border bg-surface">
        <button className="block w-full px-3 py-2.5 text-left text-sm font-medium" onClick={() => onPick(null)}>Cash (no customer)</button>
        {(list.data ?? []).filter((p) => !p.is_walkin).map((p) => (
          <button key={p.id} className="flex w-full items-center justify-between px-3 py-2.5 text-left" onClick={() => onPick(p)}>
            <span><span className="block text-sm font-medium">{p.name}</span><span className="text-xs text-muted">{p.phone}</span></span>
            {p.balance ? <span className="text-xs text-muted">owes {inr(p.balance)}</span> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function ItemPicker({ onPick, price }: { onPick: (i: Item) => void; price: (i: Item) => number }) {
  const [q, setQ] = useState('');
  const r = useApi('items.search', { q }, { enabled: q.trim().length > 0 });
  return (
    <div>
      <Input prefix={<Search className="h-4 w-4" />} placeholder="Add item — name, code or barcode" value={q} onChange={(e) => setQ(e.target.value)} data-testid="m-bill-search" />
      {q.trim() && (
        <div className="mt-1 divide-y divide-border rounded-xl border border-border bg-surface">
          {(r.data?.items ?? []).slice(0, 8).map((i) => (
            <button key={i.id} className="flex w-full items-center justify-between px-3 py-2.5 text-left" onClick={() => (onPick(i), setQ(''))} data-testid="m-bill-result">
              <span><span className="block text-sm font-medium">{i.name}</span><span className="text-xs text-muted">{inr(price(i))} · stock {fmtQty(i.stock)} {i.base_unit}</span></span>
              <Plus className="h-4 w-4 text-primary" />
            </button>
          ))}
          {r.data && !r.data.items.length && <p className="p-3 text-sm text-faint">No item found</p>}
        </div>
      )}
    </div>
  );
}
