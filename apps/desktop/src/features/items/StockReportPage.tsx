import { toCsv } from '@hisaab/core';
import { ArrowDownUp, Boxes, Download, IndianRupee, Package, PackageX, Printer, Search, Tag, TrendingUp, Warehouse } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Input, Loading, PageHeader, Segmented, Select, Stat } from '../../components/ui';
import type { StockRow } from '../../db/repos/stockReport';
import { cn } from '../../lib/cn';
import { downloadCsv } from '../../lib/download';
import { fmtDate, fmtQty, inr, today } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { ItemEditor } from './ItemEditor';

type SortKey = 'name' | 'qty' | 'cost_value' | 'retail_value' | 'mrp_value' | 'margin_pct' | 'days_cover' | 'sold_30d';

const STATUS = { in: { label: 'In stock', tone: 'good' }, low: { label: 'Low', tone: 'warn' }, out: { label: 'Out', tone: 'bad' }, negative: { label: 'Negative', tone: 'bad' } } as const;

/** Items → Stock report: totals, value at cost / selling price / MRP, by category, by godown and item by item. */
export function StockReportPage() {
  const [params, setParams] = useSearchParams();
  const category = params.get('category') ?? '';
  const godownId = Number(params.get('godown')) || undefined;
  const set = (k: string, v: string) => setParams((p) => (v ? p.set(k, v) : p.delete(k), p));
  const q = useApi('reports.stockDetail', { category: category || undefined, godownId });
  const cats = useApi('items.categories').data ?? [];
  const godowns = useApi('stock.godowns').data ?? [];
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'in' | 'low' | 'out'>('all');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'retail_value', desc: true });
  const [open, setOpen] = useState<number | null>(null);

  const rows = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = (q.data?.items ?? []).filter(
      (r) => (!s || `${r.name} ${r.brand ?? ''} ${r.category ?? ''}`.toLowerCase().includes(s)) && (status === 'all' || (status === 'out' ? r.status === 'out' || r.status === 'negative' : r.status === status)),
    );
    const k = sort.key;
    return [...list].sort((a, b) => {
      const x = a[k] ?? -Infinity;
      const y = b[k] ?? -Infinity;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y);
      return sort.desc ? -c : c;
    });
  }, [q.data, search, status, sort]);

  if (!q.data) return <Loading />;
  const { totals: t, canCost } = q.data;
  const shown = rows.reduce((a, r) => ({ qty: a.qty + 1, cost: a.cost + r.cost_value, retail: a.retail + r.retail_value, mrp: a.mrp + r.mrp_value }), { qty: 0, cost: 0, retail: 0, mrp: 0 });

  const exportCsv = () =>
    downloadCsv(
      toCsv(rows.map((r) => ({
        Item: r.name, Category: r.category ?? '', Brand: r.brand ?? '', Unit: r.base_unit, Stock: r.qty, Batches: r.batches,
        ...(canCost ? { 'Avg cost': r.avg_cost / 100, 'Value at cost': r.cost_value / 100, 'Margin %': r.margin_pct ?? '' } : {}),
        'Selling price': r.retail_price / 100, 'Value at selling price': r.retail_value / 100, MRP: r.mrp / 100, 'Value at MRP': r.mrp_value / 100,
        'Sold (30 days)': r.sold_30d, 'Days of stock': r.days_cover ?? '', 'Next expiry': r.next_expiry ?? '', 'Expired qty': r.expired_qty,
        'Last purchase': r.last_purchase ?? '', 'Last sale': r.last_sale ?? '', Status: STATUS[r.status].label,
      }))),
      `stock-report-${today()}.csv`,
    );

  const th = (key: SortKey, label: string, right = true) => (
    <th className={cn('cursor-pointer select-none whitespace-nowrap', right && 'text-right')} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}>
      {label} {sort.key === key && <ArrowDownUp className="inline h-3 w-3" />}
    </th>
  );

  return (
    <div className="animate-slide-up space-y-4" data-testid="stock-report">
      <PageHeader
        icon={<Boxes className="h-5 w-5" />}
        title="Stock report"
        subtitle={`As on ${fmtDate(today())}${category ? ` · ${category}` : ''}${godownId ? ` · ${godowns.find((g) => g.id === godownId)?.name ?? ''}` : ''}`}
        actions={
          <>
            <Button variant="outline" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>Print</Button>
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv} data-testid="stock-csv">Export CSV</Button>
          </>
        }
      />
      <div className="no-print flex flex-wrap gap-3">
        <Select value={category} onChange={(e) => set('category', e.target.value)} className="w-52" data-testid="stock-category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </Select>
        {godowns.length > 1 && (
          <Select value={godownId ?? ''} onChange={(e) => set('godown', e.target.value)} className="w-48">
            <option value="">All godowns</option>
            {godowns.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        )}
      </div>

      <div className={cn('grid gap-3 sm:grid-cols-2', canCost ? 'xl:grid-cols-5' : 'xl:grid-cols-4')}>
        <Stat label="Total items" value={<span data-testid="stock-total-items">{t.items}</span>} sub={`${t.inStock} in stock · ${t.batches} batches`} icon={<Package className="h-4 w-4" />} />
        <Stat label="Low / out of stock" value={`${t.low} / ${t.out}`} sub={t.expiredItems ? `${t.expiredItems} items have expired stock` : 'No expired stock'} icon={<PackageX className="h-4 w-4" />} tone={t.out ? 'bad' : t.low ? 'warn' : 'good'} onClick={() => setStatus(t.out ? 'out' : 'low')} />
        {canCost && <Stat label="Stock value at cost" value={<span data-testid="stock-cost-value">{inr(t.costValue)}</span>} sub={t.expiredValue ? `${inr(t.expiredValue)} of it expired` : 'What you paid for it'} icon={<IndianRupee className="h-4 w-4" />} />}
        <Stat label="Value at selling price" value={<span data-testid="stock-retail-value">{inr(t.retailValue)}</span>} sub={canCost ? `Profit if all sold: ${inr(t.potentialProfit)}` : undefined} icon={<TrendingUp className="h-4 w-4" />} tone="good" />
        <Stat label="Value at MRP" value={inr(t.mrpValue)} icon={<Tag className="h-4 w-4" />} />
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="By category" padded={false}>
          <div className="max-h-72 overflow-auto">
            <table className="table-base text-sm" data-testid="stock-by-category">
              <thead><tr><th>Category</th><th className="text-right">Items</th><th className="text-right">In stock</th>{canCost && <th className="text-right">At cost</th>}<th className="text-right">At selling price</th><th className="text-right">At MRP</th></tr></thead>
              <tbody>
                {q.data.byCategory.map((c) => (
                  <tr key={c.category} className="cursor-pointer hover:bg-surface-2" onClick={() => set('category', c.category === 'Uncategorised' ? '' : c.category)}>
                    <td className="font-medium">{c.category}</td><td className="text-right tnum">{c.items}</td><td className="text-right tnum">{c.inStock}</td>
                    {canCost && <td className="text-right tnum">{inr(c.costValue)}</td>}<td className="text-right tnum">{inr(c.retailValue)}</td><td className="text-right tnum">{inr(c.mrpValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card title={<span className="flex items-center gap-2"><Warehouse className="h-4 w-4" /> By godown</span>} padded={false}>
          <table className="table-base text-sm">
            <thead><tr><th>Godown</th><th className="text-right">Items</th>{canCost && <th className="text-right">At cost</th>}<th className="text-right">At selling price</th><th className="text-right">At MRP</th></tr></thead>
            <tbody>
              {q.data.byGodown.map((g) => (
                <tr key={g.id} className="cursor-pointer hover:bg-surface-2" onClick={() => set('godown', String(g.id))}>
                  <td className="font-medium">{g.name}</td><td className="text-right tnum">{g.items}</td>{canCost && <td className="text-right tnum">{inr(g.cost_value)}</td>}<td className="text-right tnum">{inr(g.retail_value)}</td><td className="text-right tnum">{inr(g.mrp_value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card padded={false} title={`Item-wise stock (${rows.length})`}
        action={
          <div className="no-print flex flex-wrap items-center gap-2">
            <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 w-52" data-testid="stock-search" />
            <Segmented size="sm" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'in', label: 'In stock' }, { value: 'low', label: 'Low' }, { value: 'out', label: 'Out' }]} />
          </div>
        }>
        <div className="max-h-[70vh] overflow-auto">
          <table className="table-base text-sm" data-testid="stock-items">
            <thead className="sticky top-0 z-[1] bg-surface">
              <tr>
                {th('name', 'Item', false)}
                {th('qty', 'Stock')}
                {canCost && th('cost_value', 'Value at cost')}
                {th('retail_value', 'At selling price')}
                {th('mrp_value', 'At MRP')}
                {canCost && th('margin_pct', 'Margin')}
                {th('sold_30d', 'Sold 30 d')}
                {th('days_cover', 'Days of stock')}
                <th>Expiry</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <ItemRow key={r.id} r={r} canCost={canCost} onOpen={() => setOpen(r.id)} />)}
            </tbody>
            <tfoot className="sticky bottom-0 bg-surface-2 font-semibold">
              <tr>
                <td>Total ({shown.qty} items)</td><td />
                {canCost && <td className="text-right tnum">{inr(shown.cost)}</td>}
                <td className="text-right tnum" data-testid="stock-shown-retail">{inr(shown.retail)}</td><td className="text-right tnum">{inr(shown.mrp)}</td>
                {canCost && <td />}<td /><td /><td /><td />
              </tr>
            </tfoot>
          </table>
        </div>
      </Card>
      {open && <ItemEditor id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ItemRow({ r, canCost, onOpen }: { r: StockRow; canCost: boolean; onOpen: () => void }) {
  return (
    <tr className="cursor-pointer hover:bg-surface-2" onClick={onOpen} data-testid="stock-row">
      <td>
        <span className="font-medium">{r.name}</span>
        <span className="block text-xs text-muted">{[r.category, r.brand, `${r.batches} batch${r.batches === 1 ? '' : 'es'}`].filter(Boolean).join(' · ')}</span>
      </td>
      <td className={cn('text-right tnum', r.qty < 0 && 'text-bad')}>{fmtQty(r.qty)} {r.base_unit}</td>
      {canCost && <td className="text-right tnum">{inr(r.cost_value)}<span className="block text-xs text-muted">@ {inr(r.avg_cost)}</span></td>}
      <td className="text-right tnum">{inr(r.retail_value)}<span className="block text-xs text-muted">@ {inr(r.retail_price)}</span></td>
      <td className="text-right tnum">{inr(r.mrp_value)}</td>
      {canCost && <td className="text-right tnum">{r.margin_pct != null ? `${r.margin_pct}%` : '—'}</td>}
      <td className="text-right tnum">{fmtQty(r.sold_30d)}</td>
      <td className="text-right tnum">{r.days_cover ?? '—'}</td>
      <td className="text-xs">{r.expired_qty > 0 ? <Badge tone="bad">{fmtQty(r.expired_qty)} expired</Badge> : r.next_expiry ? fmtDate(r.next_expiry) : '—'}</td>
      <td><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge></td>
    </tr>
  );
}
