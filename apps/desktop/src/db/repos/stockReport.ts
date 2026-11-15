import { addDays, allowed, guard, type Ctx } from './base';

/**
 * Stock overview and the detailed stock report: how many items, how much of each, and what it is
 * worth at cost, at selling price and at MRP — overall, by category, by godown and item by item.
 * Cost values are only returned to users allowed to see costs.
 */
export interface StockRow {
  id: number;
  name: string;
  category: string | null;
  brand: string | null;
  base_unit: string;
  qty: number;
  batches: number;
  cost_value: number;
  avg_cost: number;
  retail_price: number;
  retail_value: number;
  mrp: number;
  mrp_value: number;
  margin_pct: number | null;
  reorder_level: number;
  status: 'in' | 'low' | 'out' | 'negative';
  next_expiry: string | null;
  expired_qty: number;
  sold_30d: number;
  days_cover: number | null;
  last_purchase: string | null;
  last_sale: string | null;
}

export function stockReport(ctx: Ctx, opts: { category?: string; godownId?: number } = {}) {
  guard(ctx, 'item.view');
  const today = ctx.today();
  const from30 = addDays(today, -30);
  const g = opts.godownId ? ' AND b.godown_id = ?' : '';
  const gp = opts.godownId ? [opts.godownId] : [];
  const rows = ctx.db.query<StockRow & { cost_value: number }>(
    `SELECT i.id, i.name, i.category, i.brand, i.base_unit, i.reorder_level, i.retail_price, i.mrp,
       ROUND(COALESCE(s.qty, 0), 3) AS qty, COALESCE(s.batches, 0) AS batches, ROUND(COALESCE(s.cost_value, 0)) AS cost_value,
       COALESCE(s.expired_qty, 0) AS expired_qty, s.next_expiry,
       (SELECT COALESCE(SUM(-m.qty), 0) FROM stock_moves m WHERE m.item_id = i.id AND m.reason = 'sale' AND m.date >= ?) AS sold_30d,
       (SELECT MAX(v.date) FROM invoices v JOIN invoice_lines l ON l.invoice_id = v.id WHERE l.item_id = i.id AND v.kind = 'purchase' AND v.status = 'final') AS last_purchase,
       (SELECT MAX(v.date) FROM invoices v JOIN invoice_lines l ON l.invoice_id = v.id WHERE l.item_id = i.id AND v.kind = 'sale' AND v.status = 'final') AS last_sale
     FROM items i
     LEFT JOIN (
       SELECT b.item_id, SUM(b.qty) AS qty, SUM(CASE WHEN b.qty > 0 THEN 1 ELSE 0 END) AS batches,
         SUM(CASE WHEN b.qty > 0 THEN b.qty * b.cost ELSE 0 END) AS cost_value,
         SUM(CASE WHEN b.qty > 0 AND b.expiry IS NOT NULL AND b.expiry < ? THEN b.qty ELSE 0 END) AS expired_qty,
         MIN(CASE WHEN b.qty > 0 AND b.expiry >= ? THEN b.expiry END) AS next_expiry
       FROM batches b WHERE 1 = 1${g} GROUP BY b.item_id
     ) s ON s.item_id = i.id
     WHERE i.active = 1 ${opts.category ? 'AND i.category = ?' : ''}
     ORDER BY i.name`,
    [from30, today, today, ...gp, ...(opts.category ? [opts.category] : [])] as never,
  );
  const canCost = allowed(ctx, 'cost.view');
  const items: StockRow[] = rows.map((r) => {
    const pos = Math.max(0, r.qty);
    const status: StockRow['status'] = r.qty < 0 ? 'negative' : r.qty === 0 ? 'out' : r.reorder_level > 0 && r.qty <= r.reorder_level ? 'low' : 'in';
    const perDay = r.sold_30d / 30;
    const row: StockRow = {
      ...r,
      avg_cost: pos > 0 ? Math.round(r.cost_value / pos) : 0,
      retail_value: Math.round(pos * r.retail_price),
      mrp_value: Math.round(pos * r.mrp),
      margin_pct: r.retail_price > 0 && pos > 0 ? Math.round(((r.retail_price - r.cost_value / pos) / r.retail_price) * 1000) / 10 : null,
      status,
      days_cover: perDay > 0 ? Math.round(pos / perDay) : null,
    };
    if (!canCost) {
      row.cost_value = 0;
      row.avg_cost = 0;
      row.margin_pct = null;
    }
    return row;
  });

  const sum = (list: StockRow[]) => ({
    items: list.length,
    inStock: list.filter((r) => r.qty > 0).length,
    low: list.filter((r) => r.status === 'low').length,
    out: list.filter((r) => r.status === 'out' || r.status === 'negative').length,
    batches: list.reduce((a, r) => a + r.batches, 0),
    costValue: list.reduce((a, r) => a + r.cost_value, 0),
    retailValue: list.reduce((a, r) => a + r.retail_value, 0),
    mrpValue: list.reduce((a, r) => a + r.mrp_value, 0),
  });
  const cats = new Map<string, StockRow[]>();
  for (const r of items) cats.set(r.category || 'Uncategorised', [...(cats.get(r.category || 'Uncategorised') ?? []), r]);
  const byCategory = [...cats].map(([category, list]) => ({ category, ...sum(list) })).sort((a, b) => b.retailValue - a.retailValue);

  const byGodown = ctx.db.query<{ id: number; name: string; items: number; cost_value: number; retail_value: number; mrp_value: number }>(
    `SELECT g.id, g.name, COUNT(DISTINCT b.item_id) AS items, ROUND(COALESCE(SUM(b.qty * b.cost), 0)) AS cost_value,
       ROUND(COALESCE(SUM(b.qty * i.retail_price), 0)) AS retail_value, ROUND(COALESCE(SUM(b.qty * i.mrp), 0)) AS mrp_value
     FROM godowns g LEFT JOIN batches b ON b.godown_id = g.id AND b.qty > 0 LEFT JOIN items i ON i.id = b.item_id AND i.active = 1
     WHERE g.active = 1 GROUP BY g.id ORDER BY g.is_default DESC, g.name`,
  ).map((r) => (canCost ? r : { ...r, cost_value: 0 }));

  const totals = sum(items);
  const expiredValue = items.reduce((a, r) => a + (r.expired_qty > 0 && r.qty > 0 ? Math.round((r.cost_value / Math.max(r.qty, 1e-9)) * r.expired_qty) : 0), 0);
  return {
    canCost,
    totals: { ...totals, expiredItems: items.filter((r) => r.expired_qty > 0).length, expiredValue: canCost ? expiredValue : 0, potentialProfit: canCost ? totals.retailValue - totals.costValue : 0 },
    byCategory,
    byGodown,
    items,
  };
}
