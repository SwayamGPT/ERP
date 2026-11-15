/**
 * Supplier coupons / schemes, e.g. a Rs 50 coupon in every 5 packs of pan masala. They come with
 * purchases (see writeInvoice: they lower the real cost of the stock) and wait here until the
 * shop redeems them with the distributor: for cash / UPI, as a cut on the distributor's bill, or
 * for free goods.
 */
import { AppError, allowed, audit, guard, localNow, postVoucher, type Ctx } from './base';
import { assertCouponsInHand, couponsInHand, receivePayment } from './invoices';
import { defaultGodown } from './purchasing';

export interface CouponRow {
  item_id: number;
  item: string;
  coupon_value: number;
  coupon_per: number;
  earned: number;
  used: number;
  in_hand: number;
  value_in_hand: number;
  supplier_id: number | null;
  supplier: string | null;
}

/** Coupons per item: earned, redeemed or taken back, and still in hand (with their value). */
export function couponSummary(ctx: Ctx): CouponRow[] {
  guard(ctx, 'purchase.view');
  return ctx.db.query<CouponRow>(
    `SELECT m.item_id, i.name AS item, i.coupon_value, i.coupon_per,
       SUM(CASE WHEN m.kind = 'earned' THEN m.count ELSE 0 END) AS earned,
       SUM(CASE WHEN m.kind <> 'earned' THEN m.count ELSE 0 END) AS used,
       SUM(CASE WHEN m.kind = 'earned' THEN m.count ELSE -m.count END) AS in_hand,
       SUM(CASE WHEN m.kind = 'earned' THEN m.value ELSE -m.value END) AS value_in_hand,
       (SELECT m2.party_id FROM coupon_moves m2 WHERE m2.item_id = m.item_id AND m2.kind = 'earned' AND m2.cancelled = 0 ORDER BY m2.id DESC LIMIT 1) AS supplier_id,
       (SELECT p.name FROM coupon_moves m2 JOIN parties p ON p.id = m2.party_id WHERE m2.item_id = m.item_id AND m2.kind = 'earned' AND m2.cancelled = 0 ORDER BY m2.id DESC LIMIT 1) AS supplier
     FROM coupon_moves m JOIN items i ON i.id = m.item_id
     WHERE m.cancelled = 0 GROUP BY m.item_id ORDER BY in_hand DESC, i.name`,
  );
}

export function couponHistory(ctx: Ctx, itemId?: number) {
  guard(ctx, 'purchase.view');
  return ctx.db.query<{ id: number; date: string; item: string; kind: string; how: string; count: number; value: number; party: string | null; number: string | null; note: string | null }>(
    `SELECT m.id, m.date, i.name AS item, m.kind, m.how, m.count, m.value, p.name AS party, inv.number, m.note
     FROM coupon_moves m JOIN items i ON i.id = m.item_id LEFT JOIN parties p ON p.id = m.party_id LEFT JOIN invoices inv ON inv.id = m.invoice_id
     WHERE m.cancelled = 0 ${itemId ? 'AND m.item_id = ?' : ''} ORDER BY m.date DESC, m.id DESC LIMIT 300`,
    (itemId ? [itemId] : []) as never,
  );
}

export interface RedeemInput {
  itemId: number;
  count: number;
  /** What the distributor gave for them (paise). Default: what they were worth when earned. */
  value?: number;
  how: 'cash' | 'upi' | 'bill' | 'goods';
  /** bill: the distributor (supplier) whose dues go down; optional bills to mark paid. */
  partyId?: number | null;
  againstBills?: Array<{ invoiceId: number; amount: number }>;
  /** goods: free packs received (of this or another item), in base units. */
  goods?: { itemId: number; qty: number } | null;
  date?: string;
  note?: string;
}

/** Hand coupons to the distributor and record what came back. */
export function redeemCoupons(ctx: Ctx, input: RedeemInput) {
  const s = guard(ctx, input.how === 'bill' ? 'payment.out' : 'purchase.create');
  if (!(input.count > 0)) throw new AppError('Enter how many coupons.');
  const hand = couponsInHand(ctx, input.itemId);
  if (input.count > hand.n + 1e-9) throw new AppError(`Only ${hand.n} coupons are in hand.`);
  const worth = Math.round(hand.n > 0 ? (hand.v / hand.n) * input.count : 0);
  const value = Math.round(input.value ?? worth);
  if (!(value > 0) || !Number.isSafeInteger(value)) throw new AppError('Enter what the distributor gave for the coupons.');
  const date = input.date ?? ctx.today();
  const item = ctx.db.get<{ name: string }>('SELECT name FROM items WHERE id = ?', [input.itemId]);
  if (!item) throw new AppError('Item not found.');
  const label = `${input.count} ${item.name} coupon${input.count === 1 ? '' : 's'}`;
  const supplier =
    input.partyId ??
    ctx.db.get<{ p: number | null }>("SELECT party_id AS p FROM coupon_moves WHERE item_id = ? AND kind = 'earned' ORDER BY id DESC LIMIT 1", [input.itemId])?.p ??
    null;

  return ctx.db.transaction(() => {
    let paymentId: number | null = null;
    // The coupons leave the books at what they were worth; a different amount from the
    // distributor is a small gain or loss on them.
    const gain = value - worth;
    const settle = (account: string, amount: number, extra: Array<{ account: string; amount: number; partyId?: number }> = []) =>
      postVoucher(ctx, 'coupon_redeem', moveId, date, [
        { account, amount, narration: label },
        ...extra.map((e) => ({ ...e, narration: label })),
        { account: 'COUPONS', amount: -worth, narration: label },
        ...(gain ? [{ account: gain > 0 ? 'INCOME' : 'EXPENSE', amount: -gain, narration: `${label}: ${gain > 0 ? 'more' : 'less'} than their value` }] : []),
      ]);
    const moveId = ctx.db.exec(
      "INSERT INTO coupon_moves (item_id, party_id, kind, count, value, how, date, note, created_by, created_at) VALUES (?, ?, 'redeemed', ?, ?, ?, ?, ?, ?, ?)",
      [input.itemId, supplier, input.count, worth, input.how, date, input.note?.trim() || null, s.userId, localNow()],
    ).lastId;

    if (input.how === 'cash' || input.how === 'upi') {
      settle(input.how === 'cash' ? 'CASH' : 'BANK', value);
    } else if (input.how === 'bill') {
      if (!supplier) throw new AppError('Pick the distributor whose bill the coupons are taken off.');
      // Paying the distributor with coupons: their dues go down (and chosen bills count as paid).
      paymentId = receivePayment(ctx, {
        direction: 'out', partyId: supplier, amount: value, mode: 'coupon' as never, againstBills: input.againstBills,
        note: `Coupons: ${label}`, date,
      }) as number;
      if (gain) {
        postVoucher(ctx, 'coupon_redeem', moveId, date, [
          { account: 'COUPONS', amount: gain, narration: label },
          { account: gain > 0 ? 'INCOME' : 'EXPENSE', amount: -gain, narration: `${label}: ${gain > 0 ? 'more' : 'less'} than their value` },
        ]);
      }
      ctx.db.exec('UPDATE coupon_moves SET payment_id = ? WHERE id = ?', [paymentId, moveId]);
    } else if (input.how === 'goods') {
      const g = input.goods;
      if (!g || !(g.qty > 0)) throw new AppError('Enter the free goods received for the coupons.');
      const gi = ctx.db.get<{ name: string }>('SELECT name FROM items WHERE id = ?', [g.itemId]);
      if (!gi) throw new AppError('Item not found.');
      // Free packs come in at the coupons' value, so selling them later shows the real profit.
      const cost = Math.round(value / g.qty);
      const batchId = ctx.db.exec('INSERT INTO batches (item_id, cost, qty, received_at, godown_id) VALUES (?, ?, ?, ?, ?)', [g.itemId, cost, g.qty, `${date} ${localNow().slice(11)}`, defaultGodown(ctx)]).lastId;
      ctx.db.exec("INSERT INTO stock_moves (item_id, batch_id, qty, cost, reason, ref_id, date, note) VALUES (?, ?, ?, ?, 'adjust', ?, ?, ?)", [g.itemId, batchId, g.qty, cost, moveId, date, `Free goods for ${label}`]);
      settle('PURCHASE', value);
    } else {
      throw new AppError('Choose how the coupons were redeemed.');
    }
    assertCouponsInHand(ctx, input.itemId, 'This');
    audit(ctx, 'coupons.redeem', 'item', input.itemId, { count: input.count, value, how: input.how });
    return { id: moveId, value, worth, paymentId };
  });
}

/** Coupon value still to collect, for the dashboard (owner / manager). */
export function couponsToCollect(ctx: Ctx) {
  if (!allowed(ctx, 'purchase.view')) return null;
  return ctx.db.get<{ n: number; v: number }>(
    "SELECT COALESCE(SUM(CASE kind WHEN 'earned' THEN count ELSE -count END), 0) AS n, COALESCE(SUM(CASE kind WHEN 'earned' THEN value ELSE -value END), 0) AS v FROM coupon_moves WHERE cancelled = 0",
  )!;
}
