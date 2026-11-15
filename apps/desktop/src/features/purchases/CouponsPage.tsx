import { Ticket } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Loading, MoneyInput, PageHeader, Segmented, Select, toast } from '../../components/ui';
import type { CouponRow, RedeemInput } from '../../db/repos/coupons';
import { fmtDate, fmtQty, inr, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

const HOW: Record<string, string> = { purchase: 'Came with purchase', cash: 'Redeemed for cash', upi: 'Redeemed by UPI', bill: 'Taken off distributor bill', goods: 'Exchanged for free goods', return: 'Returned to supplier', cancel: 'Purchase cancelled' };

/** Purchases → Supplier coupons: what is in hand to redeem, and redeeming it. */
export function CouponsPage() {
  const list = useApi('coupons.summary');
  const history = useApi('coupons.history');
  const canDo = useCan();
  const [redeem, setRedeem] = useState<CouponRow | null>(null);
  if (!list.data) return <Loading />;
  const rows = list.data;
  const total = rows.reduce((a, r) => a + r.value_in_hand, 0);
  return (
    <div className="animate-slide-up space-y-5">
      <PageHeader
        icon={<Ticket className="h-5 w-5" />}
        title="Supplier coupons"
        subtitle="Coupons and schemes that come with purchases (e.g. one in every 5 packs of pan masala). They lower the real cost of the stock; redeem them with the distributor here."
        actions={total > 0 ? <Badge tone="good">To collect {inr(total)}</Badge> : undefined}
      />
      <Card padded={false} title="Coupons in hand">
        {!rows.length ? (
          <EmptyState icon={<Ticket />} title="No coupons yet" body="Set a coupon on an item (Items → edit → Supplier coupon), or enter it on a purchase bill line. Coupons are counted when you buy." />
        ) : (
          <table className="table-base" data-testid="coupons-table">
            <thead>
              <tr><th>Item</th><th>Supplier</th><th className="text-right">Earned</th><th className="text-right">Used</th><th className="text-right">In hand</th><th className="text-right">Worth</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.item_id} data-testid="coupon-row">
                  <td><div className="font-medium">{r.item}</div>{r.coupon_value > 0 && <div className="text-xs text-muted">{inr(r.coupon_value)} per {fmtQty(r.coupon_per)}</div>}</td>
                  <td>{r.supplier ?? '—'}</td>
                  <td className="text-right tnum">{fmtQty(r.earned)}</td>
                  <td className="text-right tnum">{fmtQty(r.used)}</td>
                  <td className="text-right font-semibold tnum" data-testid="coupon-in-hand">{fmtQty(r.in_hand)}</td>
                  <td className="text-right tnum">{inr(r.value_in_hand)}</td>
                  <td className="text-right">{r.in_hand > 0 && canDo('purchase.create') && <Button size="sm" variant="outline" onClick={() => setRedeem(r)} data-testid="coupon-redeem">Redeem</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {!!history.data?.length && (
        <Card padded={false} title="History">
          <table className="table-base">
            <thead><tr><th>Date</th><th>Item</th><th>What</th><th>Party / bill</th><th className="text-right">Coupons</th><th className="text-right">Value</th></tr></thead>
            <tbody>
              {history.data.map((h) => (
                <tr key={h.id}>
                  <td className="whitespace-nowrap text-muted">{fmtDate(h.date)}</td>
                  <td>{h.item}</td>
                  <td>{HOW[h.how] ?? h.how}{h.note ? <span className="text-xs text-muted"> · {h.note}</span> : null}</td>
                  <td>{h.party ?? '—'}{h.number ? <span className="text-xs text-muted"> · {h.number}</span> : null}</td>
                  <td className={`text-right tnum ${h.kind === 'earned' ? 'text-good' : ''}`}>{h.kind === 'earned' ? '+' : '−'}{fmtQty(h.count)}</td>
                  <td className="text-right tnum">{inr(h.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {redeem && <RedeemDialog row={redeem} onClose={() => setRedeem(null)} />}
    </div>
  );
}

function RedeemDialog({ row, onClose }: { row: CouponRow; onClose: () => void }) {
  const [count, setCount] = useState(String(row.in_hand));
  const n = Math.min(Number(count) || 0, row.in_hand);
  const worth = row.in_hand > 0 ? Math.round((row.value_in_hand / row.in_hand) * n) : 0;
  const [value, setValue] = useState<number | null>(null);
  const [how, setHow] = useState<RedeemInput['how']>('cash');
  const [partyId, setPartyId] = useState<number | null>(row.supplier_id);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [goodsItem, setGoodsItem] = useState<number>(row.item_id);
  const [goodsQty, setGoodsQty] = useState('');
  const [date, setDate] = useState(today());
  const suppliers = useApi('parties.list', { kind: 'supplier', limit: 300 }, { enabled: how === 'bill' }).data ?? [];
  const bills = useApi('payments.openBills', { partyId: partyId ?? 0, kind: 'purchase' }, { enabled: how === 'bill' && !!partyId }).data ?? [];
  const items = useApi('items.list', { limit: 500 }, { enabled: how === 'goods' }).data;
  const got = value ?? worth;
  const save = useAction('coupons.redeem', { success: (r) => `Coupons redeemed · ${inr(r.value)}`, onSuccess: onClose });

  // The coupons' value goes to the chosen bills, oldest first.
  const against = (() => {
    let left = got;
    return bills.filter((b) => picked[b.id]).map((b) => {
      const amount = Math.max(0, Math.min(b.due, left));
      left -= amount;
      return { invoiceId: b.id, amount };
    }).filter((a) => a.amount > 0);
  })();
  const go = () => {
    if (!(n > 0)) return toast.error(new Error('Enter how many coupons.'));
    save.mutate({
      itemId: row.item_id, count: n, value: got, how, date,
      ...(how === 'bill' ? { partyId, againstBills: against } : {}),
      ...(how === 'goods' ? { goods: { itemId: goodsItem, qty: Number(goodsQty) || 0 } } : {}),
    });
  };
  const itemList = Array.isArray(items) ? items : (items as { items?: Array<{ id: number; name: string }> } | undefined)?.items ?? [];
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title={`Redeem ${row.item} coupons`} description={`${fmtQty(row.in_hand)} in hand · worth ${inr(row.value_in_hand)}`} size="md"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!(n > 0) || !(got > 0)} onClick={go} data-testid="redeem-save">Redeem · {inr(got)}</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Coupons"><Input type="number" min={1} max={row.in_hand} value={count} onChange={(e) => setCount(e.target.value)} data-testid="redeem-count" /></Field>
          <Field label="Got for them" hint={worth !== got ? `Worth ${inr(worth)}` : undefined}><MoneyInput value={got} onChange={setValue} data-testid="redeem-value" /></Field>
          <Field label="Date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label="How the distributor gave it">
          <Segmented value={how} onChange={setHow} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI / bank' }, { value: 'bill', label: 'Less on bill' }, { value: 'goods', label: 'Free goods' }]} />
        </Field>
        {how === 'bill' && (
          <div className="space-y-3">
            <Field label="Distributor">
              <Select value={partyId ?? ''} onChange={(e) => (setPartyId(Number(e.target.value) || null), setPicked({}))} data-testid="redeem-party">
                <option value="">Pick the supplier…</option>
                {suppliers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            {bills.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Take it off these bills <span className="font-normal text-muted">(optional)</span></p>
                <ul className="max-h-40 divide-y divide-border overflow-auto rounded-lg border border-border text-sm">
                  {bills.map((b) => (
                    <li key={b.id}>
                      <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                        <input type="checkbox" checked={!!picked[b.id]} onChange={(e) => setPicked({ ...picked, [b.id]: e.target.checked })} data-testid="redeem-bill" />
                        <span className="flex-1">{b.supplier_bill_no ?? b.number} <span className="text-xs text-muted">· {fmtDate(b.date)}</span></span>
                        <span className="tnum text-muted">due {inr(b.due)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-muted">The distributor's dues go down by {inr(got)}.</p>
          </div>
        )}
        {how === 'goods' && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Free item received">
              <Select value={goodsItem} onChange={(e) => setGoodsItem(Number(e.target.value))}>
                <option value={row.item_id}>{row.item}</option>
                {itemList.filter((i) => i.id !== row.item_id).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </Select>
            </Field>
            <Field label="Quantity received" hint="Added to stock at the coupons' value"><Input type="number" min={0} step="any" value={goodsQty} onChange={(e) => setGoodsQty(e.target.value)} data-testid="redeem-goods-qty" /></Field>
          </div>
        )}
      </div>
    </Dialog>
  );
}
