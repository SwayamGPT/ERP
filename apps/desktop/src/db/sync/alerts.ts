import type { SqlJsAdapter } from '../adapter';
import { ID_BLOCK, deviceCode } from './tables';

/**
 * "Allow, then flag": two counters (or phones) offline can both sell the last packet. Both bills
 * stand — the customers have the goods — and when the sync brings them together this notices the
 * stock went below zero because of bills from more than one device, and raises an alert naming
 * them, so the owner can count the shelf or record the purchase that was never entered.
 * The same for a customer pushed over their credit limit by bills on two devices.
 */

export interface AlertBill {
  invoiceId: number;
  number: string;
  device: string;
  by: string | null;
  qty?: number;
  amount?: number;
}

export interface SyncAlert {
  id: number;
  kind: 'stock' | 'credit';
  refId: number;
  message: string;
  bills: AlertBill[];
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

const deviceOf = (id: number) => Math.floor(id / ID_BLOCK);

function deviceLabel(db: SqlJsAdapter, index: number) {
  const own = db.get<{ device_index: number | null }>('SELECT device_index FROM _sync_state WHERE id = 1')?.device_index;
  if (own != null && own === index) return 'this device';
  return `device ${deviceCode(index) || 'A'}`;
}

function upsertAlert(db: SqlJsAdapter, kind: 'stock' | 'credit', refId: number, message: string, bills: AlertBill[]) {
  const open = db.get<{ id: number }>('SELECT id FROM _sync_alerts WHERE kind = ? AND ref_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL', [kind, refId]);
  if (open) db.exec("UPDATE _sync_alerts SET message = ?, detail = ?, updated_at = datetime('now') WHERE id = ?", [message, JSON.stringify(bills), open.id]);
  else db.exec('INSERT INTO _sync_alerts (kind, ref_id, message, detail) VALUES (?, ?, ?, ?)', [kind, refId, message, JSON.stringify(bills)]);
}

const qtyText = (q: number) => String(+q.toFixed(3));

/** Stock per item as this device knew it, taken just before a pull is applied. */
export function stockBefore(db: SqlJsAdapter, itemIds: Iterable<number>): Map<number, number> {
  const out = new Map<number, number>();
  for (const id of itemIds) out.set(id, db.get<{ s: number }>('SELECT COALESCE(SUM(qty), 0) AS s FROM stock_moves WHERE item_id = ?', [id])?.s ?? 0);
  return out;
}

/**
 * After a pull: an item is flagged when this device had it in stock (zero or more) before the
 * pull and the other devices' sales that just arrived took it below zero — both sides thought the
 * packet was theirs to sell. Clocks on different devices can't say who sold first, so this looks
 * at what each device knew rather than at timestamps. Stock this device had already sold below
 * zero on its own is not a sync alert: the bill screen warned the cashier then.
 */
export function detectOversell(db: SqlJsAdapter, before: Map<number, number>, pulledSales: Map<number, Set<number>>) {
  for (const [itemId, was] of before) {
    if (was < -1e-9) continue;
    const item = db.get<{ name: string; base_unit: string }>('SELECT name, base_unit FROM items WHERE id = ?', [itemId]);
    if (!item) continue;
    const now = db.get<{ s: number }>('SELECT COALESCE(SUM(qty), 0) AS s FROM stock_moves WHERE item_id = ?', [itemId])!.s;
    const remote = pulledSales.get(itemId);
    if (now >= -1e-9 || !remote?.size) continue;
    const short = -now;
    const qtyOf = (invoiceId: number) => -(db.get<{ q: number }>("SELECT COALESCE(SUM(qty), 0) AS q FROM stock_moves WHERE item_id = ? AND reason = 'sale' AND ref_id = ?", [itemId, invoiceId])?.q ?? 0);
    // The other side of the clash: this device's latest sales of the item, enough to cover the shortfall.
    const lastIn = db.get<{ id: number }>("SELECT MAX(id) AS id FROM stock_moves WHERE item_id = ? AND qty > 0 AND reason <> 'sale'", [itemId])?.id ?? 0;
    const remoteDevices = new Set([...remote].map(deviceOf));
    const local = db.query<{ ref_id: number }>(
      "SELECT ref_id FROM stock_moves WHERE item_id = ? AND reason = 'sale' AND qty < 0 AND ref_id IS NOT NULL AND id > ? GROUP BY ref_id ORDER BY MAX(created_at) DESC, MAX(id) DESC",
      [itemId, lastIn],
    ).filter((r) => !remote.has(r.ref_id) && !remoteDevices.has(deviceOf(r.ref_id)));
    const ids = [...remote];
    let took = 0;
    for (const r of local) {
      if (took >= short - 1e-9) break;
      ids.push(r.ref_id);
      took += qtyOf(r.ref_id);
    }
    const devices = new Set(ids.map(deviceOf)).size;
    if (devices < 2) continue; // one device oversold on its own: its bill screen already warned
    const bills: AlertBill[] = ids.map((invoiceId) => {
      const inv = db.get<{ number: string; by: string | null }>('SELECT i.number, u.name AS by FROM invoices i LEFT JOIN users u ON u.id = i.created_by WHERE i.id = ?', [invoiceId]);
      return { invoiceId, number: inv?.number ?? `#${invoiceId}`, device: deviceLabel(db, deviceOf(invoiceId)), by: inv?.by ?? null, qty: qtyOf(invoiceId) };
    });
    upsertAlert(db, 'stock', itemId, `${item.name} went ${qtyText(short)} ${item.base_unit} short — sold on ${devices} devices while they were offline`, bills);
  }
}

/** Customers whose unpaid bills, made on two or more devices, add up past their credit limit. */
export function detectCreditOverrun(db: SqlJsAdapter, partyIds: Iterable<number>) {
  for (const partyId of partyIds) {
    const p = db.get<{ name: string; credit_limit: number; is_walkin: number }>('SELECT name, credit_limit, is_walkin FROM parties WHERE id = ?', [partyId]);
    if (!p || p.is_walkin || p.credit_limit <= 0) continue;
    const bal = db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id = ?", [partyId])!.b;
    if (bal <= p.credit_limit) continue;
    const open = db.query<{ id: number; number: string; due: number; by: string | null }>(
      "SELECT i.id, i.number, i.total - i.paid AS due, u.name AS by FROM invoices i LEFT JOIN users u ON u.id = i.created_by WHERE i.party_id = ? AND i.kind = 'sale' AND i.status = 'final' AND i.total > i.paid ORDER BY i.date, i.id",
      [partyId],
    );
    const devices = new Set(open.map((b) => deviceOf(b.id)));
    if (devices.size < 2) continue;
    const bills = open.map((b) => ({ invoiceId: b.id, number: b.number, device: deviceLabel(db, deviceOf(b.id)), by: b.by, amount: b.due }));
    const over = ((bal - p.credit_limit) / 100).toFixed(2);
    upsertAlert(db, 'credit', partyId, `${p.name} is ₹${over} over the credit limit — udhaar was given on ${devices.size} devices while they were offline`, bills);
  }
}

/** Open alerts; ones fixed since (stock back to zero or more, dues back under the limit) are closed first. */
export function listAlerts(db: SqlJsAdapter, opts: { includeResolved?: boolean } = {}): SyncAlert[] {
  const open = db.query<{ id: number; kind: 'stock' | 'credit'; ref_id: number }>('SELECT id, kind, ref_id FROM _sync_alerts WHERE resolved_at IS NULL AND dismissed_at IS NULL');
  for (const a of open) {
    const fixed =
      a.kind === 'stock'
        ? (db.get<{ s: number }>('SELECT COALESCE(SUM(qty), 0) AS s FROM stock_moves WHERE item_id = ?', [a.ref_id])?.s ?? 0) >= -1e-9
        : (() => {
            const p = db.get<{ credit_limit: number }>('SELECT credit_limit FROM parties WHERE id = ?', [a.ref_id]);
            const bal = db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit), 0) AS b FROM ledger_entries WHERE account = 'PARTY' AND party_id = ?", [a.ref_id])!.b;
            return !p || p.credit_limit <= 0 || bal <= p.credit_limit;
          })();
    if (fixed) db.exec("UPDATE _sync_alerts SET resolved_at = datetime('now') WHERE id = ?", [a.id]);
  }
  const rows = db.query<{ id: number; kind: 'stock' | 'credit'; ref_id: number; message: string; detail: string | null; created_at: string; updated_at: string; resolved_at: string | null }>(
    `SELECT id, kind, ref_id, message, detail, created_at, updated_at, resolved_at FROM _sync_alerts WHERE dismissed_at IS NULL ${opts.includeResolved ? '' : 'AND resolved_at IS NULL'} ORDER BY updated_at DESC, id DESC LIMIT 100`,
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, refId: r.ref_id, message: r.message, bills: r.detail ? JSON.parse(r.detail) : [], createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at }));
}

export function dismissAlert(db: SqlJsAdapter, id: number) {
  db.exec("UPDATE _sync_alerts SET dismissed_at = datetime('now') WHERE id = ?", [id]);
}
