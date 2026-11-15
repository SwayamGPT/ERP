import { internalItemBarcode, tsplLabel } from '@hisaab/core';
import { Barcode, Download, Printer, Search } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { BarcodeSvg } from '../../components/BarcodeSvg';
import { Button, Card, EmptyState, Input, PageHeader, Segmented, toast } from '../../components/ui';
import { useDevice } from '../../lib/devicePrefs';
import { isNative } from '../../native';
import { printLabelsDirect } from '../../native/print';
import type { Item } from '../../db/types';
import { downloadBlob } from '../../lib/download';
import { inr } from '../../lib/format';
import { useApi } from '../../lib/useApi';

type Size = '50x25' | '38x25' | 'a4-65';

export function LabelsPage() {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Record<number, { item: Item; copies: number }>>({});
  const [size, setSize] = useState<Size>('a4-65');
  const [printing, setPrinting] = useState(false);
  const shop = useApi('app.status').data?.company?.name ?? '';
  const list = useApi('items.list', { q, limit: 50 });
  const sel = Object.values(picked);
  const labels = sel.flatMap((p) => Array.from({ length: p.copies }, () => p.item));
  const codeOf = (it: Item) => (it.barcode && /^\d{13}$/.test(it.barcode) ? it.barcode : internalItemBarcode(it.id));

  const print = () => {
    setPrinting(true);
    setTimeout(() => {
      window.print();
      setTimeout(() => setPrinting(false), 300);
    }, 60);
  };
  const labelPrinter = useDevice((d) => d.labelPrinter) && isNative();
  const direct = async () => {
    try {
      await printLabelsDirect(sel.map((p) => ({ name: p.item.name, barcode: codeOf(p.item), mrp: inr(p.item.mrp), price: inr(p.item.retail_price), copies: p.copies })));
      toast.success(`${labels.length} labels sent to the printer`);
    } catch (e) {
      toast.error(e);
    }
  };
  const tspl = () =>
    downloadBlob(sel.map((p) => tsplLabel({ name: p.item.name, barcode: codeOf(p.item), mrp: inr(p.item.mrp), price: inr(p.item.retail_price), copies: p.copies })).join(''), 'labels.prn', 'text/plain');

  return (
    <div className="animate-slide-up">
      <PageHeader icon={<Barcode className="h-5 w-5" />} title="Barcode labels" subtitle="Print stickers for items without a maker's barcode. Loose items get scale barcodes from the weighing machine."
        actions={<>{labelPrinter && <Button variant="outline" icon={<Printer className="h-4 w-4" />} disabled={!sel.length} onClick={direct} data-testid="labels-direct">Send to label printer</Button>}<Button variant="outline" icon={<Download className="h-4 w-4" />} disabled={!sel.length} onClick={tspl}>TSPL file (label printer)</Button><Button variant="primary" icon={<Printer className="h-4 w-4" />} disabled={!labels.length} onClick={print}>Print {labels.length || ''} labels</Button></>} />
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card padded={false}>
          <div className="border-b border-border p-3"><Input prefix={<Search className="h-3.5 w-3.5" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find items…" /></div>
          <div className="max-h-[60vh] overflow-y-auto">
            {list.data?.map((it) => (
              <label key={it.id} className="flex cursor-pointer items-center gap-3 border-b border-border/60 px-3 py-2 text-sm hover:bg-surface-2">
                <input type="checkbox" checked={!!picked[it.id]} onChange={(e) => setPicked((p) => { const n = { ...p }; if (e.target.checked) n[it.id] = { item: it, copies: 1 }; else delete n[it.id]; return n; })} className="accent-[rgb(var(--primary))]" />
                <span className="flex-1 truncate">{it.name}</span>
                {picked[it.id] && <input className="input h-7 w-14 px-1 text-center" inputMode="numeric" value={picked[it.id].copies} onClick={(e) => e.preventDefault()} onChange={(e) => setPicked((p) => ({ ...p, [it.id]: { ...p[it.id], copies: Math.max(1, Math.min(200, Number(e.target.value) || 1)) } }))} />}
              </label>
            ))}
          </div>
        </Card>
        <Card title="Preview" action={<Segmented size="sm" value={size} onChange={setSize} options={[{ value: 'a4-65', label: 'A4 sheet (65)' }, { value: '50x25', label: '50×25mm roll' }, { value: '38x25', label: '38×25mm' }]} />}>
          {labels.length ? <Sheet labels={labels} size={size} codeOf={codeOf} shop={shop} /> : <EmptyState icon={<Barcode />} title="Pick items on the left" body="Choose how many copies of each you need." />}
        </Card>
      </div>
      {printing && createPortal(<div className="print-area print-only a4"><Sheet labels={labels} size={size} codeOf={codeOf} shop={shop} /></div>, document.body)}
    </div>
  );
}

function Sheet({ labels, size, codeOf, shop }: { labels: Item[]; size: Size; codeOf: (i: Item) => string; shop: string }) {
  const dims = size === '50x25' ? { w: '50mm', h: '25mm', cols: 'repeat(1, 50mm)' } : size === '38x25' ? { w: '38mm', h: '25mm', cols: 'repeat(1, 38mm)' } : { w: '38.1mm', h: '21.2mm', cols: 'repeat(5, 38.1mm)' };
  return (
    <div className="grid gap-[2mm] bg-white text-black" style={{ gridTemplateColumns: dims.cols }}>
      {labels.map((it, i) => (
        <div key={i} className="flex flex-col items-center justify-center overflow-hidden border border-dashed border-gray-300 px-1 text-center" style={{ width: dims.w, height: dims.h, breakInside: 'avoid' }}>
          <div className="w-full truncate text-[7px] text-gray-600">{shop}</div>
          <div className="w-full truncate text-[8px] font-semibold leading-tight">{it.name}</div>
          <BarcodeSvg code={codeOf(it)} height={20} module={0.95} />
          <div className="flex w-full justify-between text-[7px] font-semibold"><span>MRP {inr(it.mrp)}</span><span>Our {inr(it.retail_price)}</span></div>
        </div>
      ))}
    </div>
  );
}
