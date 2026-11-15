import { FileSpreadsheet } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Dialog, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Item } from '../../db/types';
import { inr } from '../../lib/format';
import { guessColumns, readSheet, toIsoDate, toPaiseLoose } from '../../lib/sheet';

type Loaded = { item: Item; qty: number; rate?: number; batch?: string; expiry?: string; mrp?: number };
type Match = Awaited<ReturnType<typeof matchRows>>[number];

const WANT = {
  name: /item|product|desc|particular|name/,
  barcode: /barcode|ean|upc/,
  hsn: /hsn/,
  qty: /^qty|quantity|qnty|pcs/,
  rate: /rate|price|cost/,
  mrp: /mrp/,
  batch: /batch/,
  expiry: /exp/,
};

async function matchRows(rows: Array<Record<string, string | undefined>>) {
  const parsed = rows.map((r) => ({
    name: r.name, barcode: r.barcode, hsn: r.hsn, qty: Number((r.qty ?? '').replace(/[^\d.]/g, '')) || 0,
    rate: toPaiseLoose(r.rate), mrp: toPaiseLoose(r.mrp), batch: r.batch, expiry: toIsoDate(r.expiry),
  }));
  return call('purchases.matchImport', { rows: parsed.filter((p) => p.qty > 0 && (p.name || p.barcode)) });
}

/** Load a distributor's bill (CSV or Excel) into the purchase grid. Items are matched by barcode, then name. */
export function ImportBillButton({ onLoad }: { onLoad: (rows: Loaded[]) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async (f: File) => {
    setBusy(true);
    try {
      const sheet = await readSheet(f);
      const { header, cols } = guessColumns(sheet, WANT);
      if (cols.qty == null || (cols.name == null && cols.barcode == null)) throw new Error('Could not find the item name and quantity columns in this file.');
      const rows = sheet.slice(header + 1).map((r) => Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, r[i as number]])));
      setMatches(await matchRows(rows));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };

  const load = async () => {
    const ok = matches!.filter((m) => m.item);
    const items = await Promise.all(ok.map((m) => call('items.get', { id: m.item!.id })));
    onLoad(ok.map((m, i) => ({ item: items[i], qty: m.row.qty!, rate: m.row.rate, batch: m.row.batch, expiry: m.row.expiry, mrp: m.row.mrp })));
    const skipped = matches!.length - ok.length;
    toast.success(`${ok.length} lines loaded`, skipped ? `${skipped} lines had no matching item — add those items first, then import again or type them in.` : 'Check quantities and rates, then save.');
    setMatches(null);
  };

  const found = matches?.filter((m) => m.item).length ?? 0;
  return (
    <>
      <Button variant="outline" icon={<FileSpreadsheet className="h-4 w-4" />} loading={busy} onClick={() => file.current?.click()} data-testid="purchase-import">Import bill</Button>
      <input ref={file} type="file" accept=".csv,.xlsx,.txt" className="hidden" data-testid="purchase-import-file" onChange={(e) => e.target.files?.[0] && read(e.target.files[0])} />
      <Dialog
        open={!!matches}
        onOpenChange={(v) => !v && setMatches(null)}
        title="Import distributor bill"
        description={matches ? `${found} of ${matches.length} lines matched to your items.` : undefined}
        size="lg"
        footer={<Button variant="primary" disabled={!found} onClick={load} data-testid="import-load">Load {found} lines</Button>}
      >
        <div className="max-h-[50vh] overflow-auto">
          <table className="table-base text-sm">
            <thead><tr><th>In the file</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th>Your item</th></tr></thead>
            <tbody>
              {matches?.map((m, i) => (
                <tr key={i}>
                  <td>{m.row.name ?? m.row.barcode}</td>
                  <td className="text-right tnum">{m.row.qty}</td>
                  <td className="text-right tnum">{m.row.rate != null ? inr(m.row.rate) : '—'}</td>
                  <td>{m.item ? <span>{m.item.name} {m.item.how !== 'barcode' && m.item.how !== 'name' && <Badge tone="warn">check</Badge>}</span> : <Badge tone="bad">No match</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Dialog>
    </>
  );
}
