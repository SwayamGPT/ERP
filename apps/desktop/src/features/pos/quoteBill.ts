import { call } from '../../db/client';
import { pickParty, usePos } from './store';

/** Open a quotation in a bill tab, at today's prices for the same items and quantities. */
export async function loadQuotationIntoBill(quotationId: number) {
  const q = await call('quotations.get', { id: quotationId });
  if (q.status === 'converted') throw new Error(`Quotation ${q.number} was already billed.`);
  if (q.status === 'cancelled') throw new Error(`Quotation ${q.number} was cancelled.`);
  const pos = usePos.getState();
  const open = pos.bills.findIndex((b) => b.quotationId === q.id);
  if (open >= 0) return pos.switchTo(open);
  const cur = pos.bills[pos.active];
  if ((cur.lines.length || cur.party) && !pos.newBill()) throw new Error('All bill tabs are in use. Finish or close one first.');
  const lines = q.lines ?? [];
  const [party, items] = await Promise.all([q.party_id ? call('parties.get', { id: q.party_id }) : Promise.resolve(null), Promise.all(lines.map((l) => call('items.get', { id: l.item_id })))]);
  await pickParty(party);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    usePos.getState().add(items[i], { qty: l.qty, unit: l.unit });
    // Keep the rate and discount that were quoted.
    usePos.getState().update(0, { rate: l.rate, manualRate: true, discountPct: l.line_discount_pct });
  }
  usePos.getState().set({ quotationId: q.id, quotationNumber: q.number, notes: q.notes ?? '', billDiscountPct: Number(q.bill_discount_pct) || 0 });
}
