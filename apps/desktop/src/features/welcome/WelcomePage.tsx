import type { ItemRecord, PartyRecord } from '@hisaab/core';
import { ArrowRight, Download, FileUp, Keyboard, Plus, Sparkles, Store, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, PageHeader, Segmented, toast } from '../../components/ui';
import { call } from '../../db/client';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { useApi } from '../../lib/useApi';

/** CSV templates in the column names the smart importer reads; the "Example" rows are skipped on import. */
const ITEM_TEMPLATE = [
  'Item Name,Category,Unit,HSN,GST %,MRP,Sale Rate,Purchase Rate,Opening Stock,Batch,Expiry,Barcode',
  'Example: Tata Salt 1kg,Grocery,Pcs,2501,5,28,27,24,40,,,8901058000172',
  'Example: Sugar loose,Grocery,Kg,1701,5,0,46,40,50,,,',
  'Example: Paracetamol 500 strip,Medicines,Strip,3004,12,30,28,22,100,PCM101,06/27,',
].join('\n');
const PARTY_TEMPLATE = [
  'Party Name,Type,Mobile,GSTIN,City,Balance,Dr/Cr',
  'Example: Meena Aunty,Customer,9822012345,,Pune,1250,Dr',
  'Example: Mahalaxmi Distributors,Supplier,9822000000,27AAKFM4821K1Z5,Pune,45000,Cr',
].join('\n');

/** After setting up an existing shop: bring in its items, stock and customers. */
export function WelcomePage() {
  const company = useApi('app.status').data?.company;
  const [mode, setMode] = useState<'choose' | 'items' | 'parties'>('choose');
  const navigate = useNavigate();
  return (
    <div className="animate-slide-up space-y-4" data-testid="welcome">
      <PageHeader icon={<Store className="h-5 w-5" />} title={`Bring ${company?.name ?? 'your shop'} into Hisaab`} subtitle="Your items, current stock and who owes what — so billing starts with everything in place." />
      {mode === 'choose' && (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <Choice icon={<FileUp className="h-5 w-5" />} title="Import from Marg, Tally or Busy" testid="welcome-import"
              body="Export the stock statement and party / outstanding list to Excel or CSV and drop them in. Columns are matched for you and you check everything before saving."
              action={<Link to="/import"><Button variant="primary" icon={<ArrowRight className="h-4 w-4" />}>Import files</Button></Link>} />
            <Choice icon={<Download className="h-5 w-5" />} title="Fill our Excel template" testid="welcome-template"
              body="No software before? Download the template, fill it in Excel or Google Sheets (one row per item or batch), and import it."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(ITEM_TEMPLATE, 'hisaab-items-template.csv')} data-testid="template-items">Items template</Button>
                  <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={() => downloadCsv(PARTY_TEMPLATE, 'hisaab-customers-template.csv')}>Customers template</Button>
                  <Link to="/import" className="self-center text-sm text-primary hover:underline">Then import →</Link>
                </div>
              } />
            <Choice icon={<Keyboard className="h-5 w-5" />} title="Type them in quickly" testid="welcome-quick"
              body="A fast grid for a small shop: name, unit, GST, prices and the stock on your shelf. Also a grid for customers who owe you (udhaar)."
              action={
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setMode('items')} data-testid="welcome-quick-items">Add items</Button>
                  <Button variant="outline" icon={<Users className="h-4 w-4" />} onClick={() => setMode('parties')} data-testid="welcome-quick-parties">Add customer dues</Button>
                </div>
              } />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-dashed border-border px-4 py-3 text-sm text-muted">
            <span className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-primary" /> You can also add items while billing, and come back here any time from the dashboard checklist or Items → Import.</span>
            <Button variant="ghost" onClick={() => navigate('/')} data-testid="welcome-skip">Skip for now</Button>
          </div>
        </>
      )}
      {mode === 'items' && <QuickItems onBack={() => setMode('choose')} />}
      {mode === 'parties' && <QuickParties onBack={() => setMode('choose')} />}
    </div>
  );
}

function Choice({ icon, title, body, action, testid }: { icon: React.ReactNode; title: string; body: string; action: React.ReactNode; testid: string }) {
  return (
    <Card className="flex flex-col" padded>
      <div className="mb-2 flex items-center gap-2 font-semibold" data-testid={testid}><span className="grid h-9 w-9 place-items-center rounded-lg bg-primary-soft text-primary">{icon}</span>{title}</div>
      <p className="mb-4 flex-1 text-sm text-muted">{body}</p>
      {action}
    </Card>
  );
}

/* ───────── quick item grid ───────── */

const UNITS = ['Pcs', 'Kg', 'g', 'Ltr', 'ml', 'Box', 'Pack', 'Bag', 'Dozen', 'Bottle', 'Strip', 'Carton'];
const SLABS = [0, 5, 12, 18, 28, 40];

interface ItemLine { k: number; name: string; unit: string; gst: number; mrp: string; rate: string; cost: string; qty: string }
let K = 0;
const blankItem = (prev?: ItemLine): ItemLine => ({ k: ++K, name: '', unit: prev?.unit ?? 'Pcs', gst: prev?.gst ?? 5, mrp: '', rate: '', cost: '', qty: '' });
const paise = (s: string) => (s.trim() === '' ? undefined : Math.round(Number(s) * 100));

/** Many items in one go; saved through the same import path (no duplicates, opening stock as a batch). */
export function QuickItems({ onBack }: { onBack?: () => void }) {
  const [lines, setLines] = useState<ItemLine[]>(() => Array.from({ length: 5 }, () => blankItem()));
  const [busy, setBusy] = useState(false);
  const set = (k: number, p: Partial<ItemLine>) => setLines((ls) => {
    const next = ls.map((l) => (l.k === k ? { ...l, ...p } : l));
    const last = next[next.length - 1];
    return last.name.trim() ? [...next, blankItem(last)] : next; // a fresh row appears as you fill the last one
  });
  const filled = lines.filter((l) => l.name.trim());
  const save = async () => {
    setBusy(true);
    try {
      const records: ItemRecord[] = filled.map((l, i) => ({
        row: i + 1, name: l.name.trim(), unit: l.unit, gst: l.gst, warnings: [],
        mrp: paise(l.mrp), rate: paise(l.rate) ?? paise(l.mrp), cost: paise(l.cost), qty: l.qty.trim() ? Number(l.qty) : undefined,
      }));
      const r = await call('import.items', { records, ratesIncludeGst: true });
      if (r.errors.length) toast.error(new Error(r.errors.map((e) => `${e.name}: ${e.reason}`).join(' · ')));
      toast.success(`${r.created} items added${r.unchanged ? ` · ${r.unchanged} already existed` : ''}`, r.batches ? `Opening stock entered for ${r.batches} items.` : undefined);
      setLines(Array.from({ length: 5 }, () => blankItem()));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const cell = 'input h-8 px-2 text-sm';
  return (
    <Card padded={false} title="Add items quickly" action={<div className="flex gap-2">{onBack && <Button variant="ghost" onClick={onBack}>Back</Button>}<Button variant="primary" loading={busy} disabled={!filled.length} onClick={save} data-testid="quick-items-save">Save {filled.length || ''} items</Button></div>}>
      <p className="px-4 pt-3 text-xs text-muted">Prices include GST. Opening stock is what's on your shelf today. Barcodes, batches and other prices can be added later from Items.</p>
      <div className="overflow-x-auto p-3">
        <table className="table-base min-w-[900px] text-sm" data-testid="quick-items">
          <thead><tr><th className="w-8">#</th><th>Item name</th><th className="w-28">Unit</th><th className="w-24">GST</th><th className="w-28 text-right">MRP ₹</th><th className="w-28 text-right">Selling ₹</th><th className="w-28 text-right">Cost ₹</th><th className="w-28 text-right">Stock now</th><th className="w-8" /></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.k}>
                <td className="text-xs text-faint">{i + 1}</td>
                <td><input className={cell} value={l.name} onChange={(e) => set(l.k, { name: e.target.value })} placeholder={i === 0 ? 'e.g. Fortune Sunflower Oil 1L' : ''} data-testid="qi-name" /></td>
                <td><select className={cell} value={l.unit} onChange={(e) => set(l.k, { unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></td>
                <td><select className={cell} value={l.gst} onChange={(e) => set(l.k, { gst: Number(e.target.value) })}>{SLABS.map((g) => <option key={g} value={g}>{g}%</option>)}</select></td>
                {(['mrp', 'rate', 'cost', 'qty'] as const).map((f) => (
                  <td key={f}><input className={cn(cell, 'text-right tnum')} inputMode="decimal" value={l[f]} onChange={(e) => set(l.k, { [f]: e.target.value.replace(/[^\d.]/g, '') })} data-testid={`qi-${f}`} /></td>
                ))}
                <td>{l.name && <button className="text-faint hover:text-bad" onClick={() => setLines((ls) => ls.filter((x) => x.k !== l.k))} title="Remove"><Trash2 className="h-4 w-4" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/* ───────── quick customer dues ───────── */

interface PartyLine { k: number; name: string; phone: string; kind: 'customer' | 'supplier'; amount: string }
const blankParty = (kind: PartyLine['kind'] = 'customer'): PartyLine => ({ k: ++K, name: '', phone: '', kind, amount: '' });

function QuickParties({ onBack }: { onBack: () => void }) {
  const [lines, setLines] = useState<PartyLine[]>(() => Array.from({ length: 5 }, () => blankParty()));
  const [busy, setBusy] = useState(false);
  const set = (k: number, p: Partial<PartyLine>) => setLines((ls) => {
    const next = ls.map((l) => (l.k === k ? { ...l, ...p } : l));
    const last = next[next.length - 1];
    return last.name.trim() ? [...next, blankParty(last.kind)] : next;
  });
  const filled = lines.filter((l) => l.name.trim());
  const save = async () => {
    setBusy(true);
    try {
      const records: PartyRecord[] = filled.map((l, i) => {
        const amt = paise(l.amount) ?? 0;
        return { row: i + 1, name: l.name.trim(), kind: l.kind, phone: l.phone.replace(/\D/g, '').slice(-10) || undefined, balance: l.kind === 'customer' ? amt : -amt, warnings: [] };
      });
      const r = await call('import.parties', { records });
      if (r.errors.length) toast.error(new Error(r.errors.map((e) => `${e.name}: ${e.reason}`).join(' · ')));
      toast.success(`${r.created} added${r.unchanged ? ` · ${r.unchanged} already existed` : ''}`);
      setLines(Array.from({ length: 5 }, () => blankParty()));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const cell = 'input h-8 px-2 text-sm';
  return (
    <Card padded={false} title="Customer dues & supplier balances" action={<div className="flex gap-2"><Button variant="ghost" onClick={onBack}>Back</Button><Button variant="primary" loading={busy} disabled={!filled.length} onClick={save} data-testid="quick-parties-save">Save {filled.length || ''}</Button></div>}>
      <p className="px-4 pt-3 text-xs text-muted">Customers: how much they owe you today (udhaar). Suppliers: how much you owe them. Leave the amount empty if nothing is due.</p>
      <div className="overflow-x-auto p-3">
        <table className="table-base min-w-[720px] text-sm" data-testid="quick-parties">
          <thead><tr><th className="w-8">#</th><th>Name</th><th className="w-40">Mobile</th><th className="w-56">Who</th><th className="w-36 text-right">Amount ₹</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.k}>
                <td className="text-xs text-faint">{i + 1}</td>
                <td><input className={cell} value={l.name} onChange={(e) => set(l.k, { name: e.target.value })} data-testid="qp-name" /></td>
                <td><input className={cell} inputMode="tel" value={l.phone} onChange={(e) => set(l.k, { phone: e.target.value })} data-testid="qp-phone" /></td>
                <td><Segmented size="sm" value={l.kind} onChange={(kind) => set(l.k, { kind })} options={[{ value: 'customer', label: 'Customer owes' }, { value: 'supplier', label: 'I owe supplier' }]} /></td>
                <td><input className={cn(cell, 'text-right tnum')} inputMode="decimal" value={l.amount} onChange={(e) => set(l.k, { amount: e.target.value.replace(/[^\d.]/g, '') })} data-testid="qp-amount" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
