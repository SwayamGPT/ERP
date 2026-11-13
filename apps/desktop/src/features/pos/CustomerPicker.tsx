import { CircleUserRound, Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Dialog, Kbd } from '../../components/ui';
import { call } from '../../db/client';
import type { Party } from '../../db/types';
import { cn } from '../../lib/cn';
import { inr } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { PartyForm } from '../parties/PartyForm';

export function CustomerPicker({ open, onOpenChange, onPick, kind = 'customer' }: { open: boolean; onOpenChange: (v: boolean) => void; onPick: (p: Party) => void; kind?: 'customer' | 'supplier' }) {
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(0);
  const [adding, setAdding] = useState(false);
  const list = useApi('parties.list', { kind, q, limit: 30 }, { enabled: open });
  const rows = list.data ?? [];
  useEffect(() => {
    if (open) (setQ(''), setAdding(false), setHl(0));
  }, [open]);
  useEffect(() => setHl(0), [q]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={adding ? `New ${kind}` : kind === 'customer' ? 'Pick customer' : 'Pick supplier'} size="md">
      {adding ? (
        <PartyForm
          kind={kind}
          compact
          initial={{ name: /^\d+$/.test(q) ? '' : q, phone: /^\d+$/.test(q) ? q : '' }}
          onCancel={() => setAdding(false)}
          onSaved={async (id) => onPick(await call('parties.get', { id }))}
        />
      ) : (
        <div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') (e.preventDefault(), setHl((h) => Math.min(h + 1, rows.length)));
                if (e.key === 'ArrowUp') (e.preventDefault(), setHl((h) => Math.max(h - 1, 0)));
                if (e.key === 'Enter') {
                  e.preventDefault();
                  // Resolve against the current text, not a list that may still be loading.
                  void call('parties.list', { kind, q, limit: 30 }).then((fresh) => {
                    if (hl >= fresh.length || !fresh.length) setAdding(true);
                    else onPick(fresh[hl]);
                  });
                }
              }}
              placeholder="Name or mobile number…"
              className="input input-lg pl-9"
              data-testid="customer-search"
            />
          </div>
          <div className="mt-3 max-h-[50vh] space-y-1 overflow-y-auto">
            {rows.map((p, i) => (
              <button
                key={p.id}
                onMouseEnter={() => setHl(i)}
                onClick={() => onPick(p)}
                className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left', i === hl ? 'bg-primary-soft' : 'hover:bg-surface-2')}
              >
                <CircleUserRound className="h-5 w-5 shrink-0 text-faint" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {p.name}
                    {p.price_tier !== 'retail' && <Badge tone="primary">{p.price_tier}</Badge>}
                    {p.gstin && <Badge>GST</Badge>}
                  </span>
                  <span className="block text-xs text-muted">{p.phone ?? (p.is_walkin ? 'Pays at the counter' : 'No phone')}</span>
                </span>
                {p.balance !== 0 && (
                  <span className={cn('text-right text-xs', p.balance > 0 === (p.kind === 'customer') ? 'text-bad' : 'text-good')}>
                    {p.kind === 'customer' ? (p.balance > 0 ? 'Due' : 'Advance') : p.balance < 0 ? 'To pay' : 'Advance paid'}
                    <span className="block text-sm font-semibold tnum">{inr(Math.abs(p.balance))}</span>
                  </span>
                )}
                {i === hl && <Kbd>Enter</Kbd>}
              </button>
            ))}
            <button
              onMouseEnter={() => setHl(rows.length)}
              onClick={() => setAdding(true)}
              className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium text-primary', hl === rows.length ? 'bg-primary-soft' : 'hover:bg-surface-2')}
              data-testid="customer-add"
            >
              <Plus className="h-5 w-5" /> Add new {kind}{q ? ` "${q}"` : ''}
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
