import { PackageX, UserX, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button } from '../../components/ui';
import { inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

/**
 * What the sync noticed after merging bills made offline on several devices: stock sold twice
 * (the last packet went to two customers) or udhaar past a customer's limit. Both bills stand;
 * this asks the owner to count the shelf, record the missing purchase, or follow up.
 */
export function SyncAlerts() {
  const canDo = useCan();
  const navigate = useNavigate();
  const alerts = useApi('sync.alerts', undefined, { enabled: canDo('item.view') }).data ?? [];
  const dismiss = useAction('sync.dismissAlert');
  if (!alerts.length) return null;
  return (
    <div className="space-y-2" data-testid="sync-alerts">
      {alerts.map((a) => (
        <div key={a.id} className="flex flex-wrap items-start gap-3 rounded-xl border border-bad/30 bg-bad-soft p-3 text-sm" data-testid="sync-alert">
          {a.kind === 'stock' ? <PackageX className="mt-0.5 h-4 w-4 shrink-0 text-bad" /> : <UserX className="mt-0.5 h-4 w-4 shrink-0 text-bad" />}
          <div className="min-w-0 flex-1">
            <p className="font-medium text-bad">{a.message}</p>
            <p className="mt-1 flex flex-wrap gap-1.5 text-xs text-muted">
              {a.bills.map((b) => (
                <button key={b.invoiceId} className="hover:underline" onClick={() => navigate(`/sales/${b.invoiceId}`)}>
                  <Badge>{b.number} · {b.device}{b.by ? ` · ${b.by}` : ''}{b.qty != null ? ` · ${+b.qty.toFixed(3)}` : ''}{b.amount != null ? ` · ${inr(b.amount)}` : ''}</Badge>
                </button>
              ))}
            </p>
            <p className="mt-1 text-xs text-muted">
              {a.kind === 'stock'
                ? 'Both sales are kept — the customers have the goods. Count the shelf, or enter the purchase that was not recorded; this closes by itself once stock is back to zero or more.'
                : 'Both bills are kept. Collect a payment or raise the limit; this closes by itself once the dues are within the limit.'}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            {a.kind === 'stock' ? (
              <>
                {canDo('item.edit') && <Button size="sm" variant="outline" onClick={() => navigate(`/items?id=${a.refId}`)} data-testid="sync-alert-count">Count stock</Button>}
                {canDo('purchase.create') && <Button size="sm" variant="outline" onClick={() => navigate('/purchases/new')}>Record purchase</Button>}
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => navigate(`/parties/${a.refId}`)}>Open customer</Button>
            )}
            {canDo('item.edit') && (
              <button className="rounded-md p-1 text-muted hover:bg-surface-2" title="Dismiss" onClick={() => dismiss.mutate({ id: a.id })} data-testid="sync-alert-dismiss">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
