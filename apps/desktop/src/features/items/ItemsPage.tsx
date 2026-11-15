import { describeQty, describeScheme, marginPct, toCsv } from '@hisaab/core';
import { Download, Package, Plus, Search, Upload } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, EmptyState, Input, Loading, PageHeader, Segmented, Select, Stat } from '../../components/ui';
import { downloadCsv } from '../../lib/download';
import { fmtQty, inr, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useApi } from '../../lib/useApi';
import { ItemEditor } from './ItemEditor';

export function ItemsPage() {
  const canDo = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const filter = (params.get('filter') as 'low' | 'out' | 'expiring' | null) ?? 'all';
  const editing = params.get('id') ? Number(params.get('id')) : params.get('new') ? 0 : null;
  const list = useApi('items.list', { q, category: category || undefined, filter: filter === 'all' ? undefined : filter, limit: 1000 });
  const cats = useApi('items.categories');
  const rows = list.data ?? [];
  const canCost = canDo('cost.view');

  const setFilter = (f: string) => setParams((p) => (f === 'all' ? p.delete('filter') : p.set('filter', f), p));
  const open = (id: number | null) => setParams((p) => (p.delete('id'), p.delete('new'), id === 0 ? p.set('new', '1') : id ? p.set('id', String(id)) : null, p));

  const exportCsv = () =>
    downloadCsv(
      toCsv(rows.map((r) => ({ name: r.name, code: r.short_code ?? '', barcode: r.barcode ?? '', category: r.category ?? '', hsn: r.hsn ?? '', gst: r.gst_rate, unit: r.base_unit, stock: r.stock, mrp: r.mrp / 100, retail: r.retail_price / 100, wholesale: (r.wholesale_price ?? 0) / 100, ...(canCost ? { cost: (r.purchase_price ?? 0) / 100 } : {}) }))),
      `items-${today()}.csv`,
    );

  return (
    <div className="animate-slide-up">
      <PageHeader
        icon={<Package className="h-5 w-5" />}
        title="Items & stock"
        subtitle={`${rows.length} items`}
        actions={
          <>
            {canDo('settings.edit') && <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => navigate('/import')} data-testid="items-import">Import</Button>}
            <Button variant="outline" icon={<Download className="h-4 w-4" />} onClick={exportCsv}>Export</Button>
            {canDo('item.edit') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => open(0)} data-testid="item-new">Add item</Button>}
          </>
        }
      />
      <StockStrip />
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
          <Input prefix={<Search className="h-3.5 w-3.5" />} placeholder="Name, code, barcode, brand, HSN…" value={q} onChange={(e) => setQ(e.target.value)} className="w-80" autoFocus data-testid="items-search" />
          <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-48">
            <option value="">All categories</option>
            {cats.data?.map((c) => <option key={c}>{c}</option>)}
          </Select>
          <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'low', label: 'Low stock' }, { value: 'out', label: 'Out of stock' }, { value: 'expiring', label: 'Expiring' }]} />
        </div>
        {list.isLoading ? (
          <Loading />
        ) : !rows.length ? (
          <EmptyState icon={<Package />} title={q || filter !== 'all' ? 'No items match' : 'No items yet'} body="Add items one by one, or load a sample catalogue from Settings." action={canDo('item.edit') && <Button variant="primary" onClick={() => open(0)}>Add item</Button>} />
        ) : (
          <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
            <table className="table-base" data-testid="items-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th className="text-right">GST</th>
                  <th className="text-right">Stock</th>
                  <th className="text-right">MRP</th>
                  <th className="text-right">Selling</th>
                  {canCost && <th className="text-right">Cost</th>}
                  {canCost && <th className="text-right">Margin</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const low = r.reorder_level > 0 && r.stock <= r.reorder_level;
                  const taxFactor = r.tax_inclusive ? 1 + r.gst_rate / 100 : 1;
                  const m = r.purchase_price ? marginPct(Math.round(r.retail_price / taxFactor), r.purchase_price) : null;
                  return (
                    <tr key={r.id} className="cursor-pointer" onClick={() => open(r.id)}>
                      <td>
                        <div className="font-medium">{r.name}</div>
                        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          {r.short_code && <span className="font-mono">{r.short_code}</span>}
                          {r.barcode && <span className="font-mono">{r.barcode}</span>}
                          {r.is_loose ? <Badge tone="primary">Loose · PLU {r.plu}</Badge> : null}
                          {r.units.length > 1 && <Badge>{r.units.slice(1).map((u) => u.name).join(', ')}</Badge>}
                          {r.scheme && <Badge tone="saffron">{describeScheme(r.scheme)}</Badge>}
                        </div>
                      </td>
                      <td className="text-muted">{r.category ?? '—'}</td>
                      <td className="text-right text-muted">{r.gst_rate}%</td>
                      <td className="text-right">
                        <span className={r.stock <= 0 ? 'font-medium text-bad' : low ? 'font-medium text-warn' : ''}>{fmtQty(r.stock)} {r.base_unit}</span>
                        {r.units.length > 1 && r.stock > 0 && <div className="text-[11px] text-faint">{describeQty(r.stock, r.base_unit, r.units)}</div>}
                      </td>
                      <td className="text-right text-muted">{r.mrp ? inr(r.mrp) : '—'}</td>
                      <td className="text-right font-medium">{inr(r.retail_price)}</td>
                      {canCost && <td className="text-right text-muted">{inr(r.purchase_price ?? 0)}</td>}
                      {canCost && <td className="text-right">{m !== null ? <span className={m < 5 ? 'text-bad' : m < 12 ? 'text-warn' : 'text-good'}>{m}%</span> : '—'}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {editing !== null && <ItemEditor id={editing || null} onClose={() => open(null)} />}
    </div>
  );
}

/** Totals at the top of Items: how many items, how much stock, and what it is worth. Opens the full report. */
function StockStrip() {
  const d = useApi('reports.stockDetail', {}).data;
  const navigate = useNavigate();
  if (!d) return null;
  const t = d.totals;
  const go = () => navigate('/items/stock');
  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5" data-testid="stock-strip">
      <Stat label="Total items" value={t.items} sub={`${t.inStock} in stock`} onClick={go} />
      <Stat label="Low / out of stock" value={`${t.low} / ${t.out}`} tone={t.out ? 'bad' : t.low ? 'warn' : 'good'} onClick={go} />
      {d.canCost && <Stat label="Stock value at cost" value={inr(t.costValue)} onClick={go} />}
      <Stat label="Value at selling price" value={inr(t.retailValue)} tone="good" onClick={go} />
      <Stat label="Value at MRP" value={inr(t.mrpValue)} sub={<span className="text-primary">Detailed stock report →</span>} onClick={go} />
    </div>
  );
}
