import { call } from '../../db/client';
import { pickParty, usePos } from './store';

/** Open a saved sale in a bill tab so it can be changed and saved again under the same number. */
export async function loadSaleForEdit(invoiceId: number) {
  const d = await call('invoices.forEdit', { id: invoiceId });
  const v = d.invoice;
  const pos = usePos.getState();
  const open = pos.bills.findIndex((b) => b.editId === v.id);
  if (open >= 0) return pos.switchTo(open);
  const cur = pos.bills[pos.active];
  if ((cur.lines.length || cur.party) && !pos.newBill()) throw new Error('All bill tabs are in use. Finish or close one first.');
  const [party, items] = await Promise.all([call('parties.get', { id: v.party_id }), Promise.all(d.lines.map((l) => call('items.get', { id: l.item_id })))]);
  await pickParty(party.is_walkin ? null : party);
  // add() puts each line on top, so add them last-first to keep the bill's order
  for (let i = d.lines.length - 1; i >= 0; i--) {
    const l = d.lines[i];
    usePos.getState().add(items[i], { qty: l.qty, unit: l.unit });
    usePos.getState().update(0, { rate: l.rate, manualRate: true, discountPct: l.line_discount_pct });
  }
  const pays = d.payments;
  const paid = pays.reduce((a, p) => a + p.amount, 0);
  const one = (m?: string) => (m === 'upi' || m === 'card' ? m : 'cash') as 'cash' | 'upi' | 'card';
  const mode = paid < v.total ? 'credit' : pays.length > 1 ? 'split' : one(pays[0]?.mode);
  const s = usePos.getState();
  s.setMode(mode);
  s.set({
    editId: v.id,
    editNumber: v.number,
    notes: v.notes ?? '',
    otherCharges: v.other_charges ?? 0,
    paidNow: mode === 'credit' ? paid : 0,
    paidNowMode: one(pays[0]?.mode),
    splitCash: mode === 'split' ? pays.filter((p) => p.mode === 'cash').reduce((a, p) => a + p.amount, 0) : undefined,
    splitOther: mode === 'split' ? (pays.find((p) => p.mode === 'card') ? 'card' : 'upi') : undefined,
    couponCode: d.couponCode ?? '',
    redeemPoints: d.redeemPoints || 0,
    servedBy: v.served_by ? { id: v.served_by, name: v.served_by_name ?? '' } : null,
  });
}
