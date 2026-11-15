import { ClipboardList, X } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Drawer, EmptyState, Loading, toast } from '../../components/ui';
import { call } from '../../db/client';
import { inr } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { usePos } from './store';

/** Open sale orders from salesmen (phones). One click loads an order into a new bill tab. */
export function OrdersButton() {
  const [open, setOpen] = useState(false);
  const count = useApi('app.status').data?.openOrders ?? 0;
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="mx-2 mb-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-xs font-medium text-muted hover:text-ink"
        data-testid="pos-orders"
        title="Orders taken by salesmen"
      >
        <ClipboardList className="h-4 w-4" /> Orders {count > 0 && <Badge tone="saffron">{count}</Badge>}
      </button>
      <Drawer open={open} onOpenChange={setOpen} title="Open orders" width="max-w-lg">
        {open && <OrdersList onLoaded={() => setOpen(false)} />}
      </Drawer>
    </>
  );
}

function OrdersList({ onLoaded }: { onLoaded: () => void }) {
  const q = useApi('orders.list', { status: 'open' });
  const [busy, setBusy] = useState<number | null>(null);
  const cancel = async (id: number) => {
    try {
      await call('orders.cancel', { id });
      toast.success('Order cancelled');
    } catch (e) {
      toast.error(e);
    }
  };
  const load = async (id: number) => {
    setBusy(id);
    try {
      await loadOrderIntoBill(id);
      onLoaded();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  if (!q.data) return <Loading />;
  if (!q.data.length) return <EmptyState icon={<ClipboardList className="h-6 w-6" />} title="No open orders" body="Orders taken by salesmen on the Hisaab phone app appear here as soon as their phone syncs." />;
  return (
    <ul className="divide-y divide-border" data-testid="orders-list">
      {q.data.map((o) => (
        <li key={o.id} className="flex items-center gap-3 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{o.party_name} <span className="text-xs text-muted">· {o.number}</span></p>
            <p className="text-xs text-muted">{o.created_by_name ?? 'Salesman'} · {o.created_at.slice(0, 16)}{o.notes ? ` · ${o.notes}` : ''}</p>
          </div>
          <span className="font-semibold tnum">{inr(o.total)}</span>
          <Button size="sm" variant="primary" loading={busy === o.id} onClick={() => load(o.id)} data-testid="order-bill">Bill this</Button>
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} title="Cancel order" onClick={() => cancel(o.id)} />
        </li>
      ))}
    </ul>
  );
}

export async function loadOrderIntoBill(orderId: number) {
  const o = await call('orders.get', { id: orderId });
  const [party, items] = await Promise.all([call('parties.get', { id: o.party_id }), Promise.all(o.lines!.map((l) => call('items.get', { id: l.item_id })))]);
  const pos = usePos.getState();
  if (pos.bills.some((b) => b.orderId === o.id)) throw new Error(`Order ${o.number} is already open in a bill tab.`);
  const cur = pos.bills[pos.active];
  if ((cur.lines.length || cur.party) && !pos.newBill()) throw new Error('All bill tabs are in use. Finish or close one first.');
  pos.setParty(party);
  o.lines!.forEach((l, i) => pos.add(items[i], { qty: l.qty, unit: l.unit }));
  const s = usePos.getState();
  s.bills[s.active].lines.forEach((ln, i) => {
    const ol = o.lines!.find((x) => x.item_id === ln.itemId && x.unit === ln.unit);
    if (ol && ol.rate !== ln.rate) s.update(i, { rate: ol.rate, manualRate: true });
  });
  s.set({ orderId: o.id, orderNumber: o.number, notes: o.notes ?? '' });
}
