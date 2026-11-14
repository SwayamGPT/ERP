import { Search, UserCheck, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Dialog } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useApi } from '../../lib/useApi';
import { usePos } from './store';

const KEY = 'hisaab.servedBy';
/** The counter remembers who usually bills here, for new bill tabs. */
export const rememberedServedBy = (): { id: number; name: string } | null => {
  try {
    const v = localStorage.getItem(KEY);
    return v ? (JSON.parse(v) as { id: number; name: string }) : null;
  } catch {
    return null;
  }
};
const remember = (v: { id: number; name: string } | null) => {
  try {
    if (v) localStorage.setItem(KEY, JSON.stringify(v));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
};

/** Optional "Served by" chip on the billing screen. Shown only when turned on in Settings. */
export function ServedBy() {
  const bill = usePos((s) => s.bills[s.active]);
  const set = usePos((s) => s.set);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = useApi('staff.billers');
  const people = (list.data ?? []).filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  // New tabs pick up this counter's usual person (only if they still work here).
  useEffect(() => {
    if (bill.servedBy === undefined) {
      const r = rememberedServedBy();
      if (r && list.data) set({ servedBy: list.data.some((p) => p.id === r.id) ? r : null });
    }
  }, [bill.id, bill.servedBy, list.data, set]);
  const choose = (v: { id: number; name: string } | null) => {
    set({ servedBy: v });
    remember(v);
    setOpen(false);
  };
  const who = bill.servedBy;
  return (
    <>
      <button
        onClick={() => (setQ(''), setOpen(true))}
        className={cn('flex h-12 min-w-[150px] items-center gap-2 rounded-xl border px-3 text-left transition hover:border-primary/50', who ? 'border-good/40 bg-good-soft/40' : 'border-dashed border-border')}
        data-testid="pos-served-by"
        title="Who served this customer (optional)"
      >
        {who ? <UserCheck className="h-5 w-5 shrink-0 text-good" /> : <UserRound className="h-5 w-5 shrink-0 text-faint" />}
        <span className="min-w-0">
          <span className="block text-[11px] text-muted">Served by</span>
          <span className="block truncate text-sm font-medium">{who?.name ?? 'Not set'}</span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen} title="Who served this customer?" description="Optional. Used for sales-by-staff and incentives." size="sm">
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && people[0] && choose({ id: people[0].id, name: people[0].name })} className="input pl-9" placeholder="Name…" />
        </div>
        <div className="max-h-[50vh] space-y-1 overflow-y-auto" data-testid="served-by-list">
          <button onClick={() => choose(null)} className={cn('w-full rounded-lg px-3 py-2 text-left text-sm', !who ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2')}>Not set</button>
          {people.map((p) => (
            <button key={p.id} onClick={() => choose({ id: p.id, name: p.name })} className={cn('flex w-full justify-between rounded-lg px-3 py-2 text-left text-sm', who?.id === p.id ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2')}>
              <span className="font-medium">{p.name}</span>
              <span className="text-xs text-muted">{p.designation}</span>
            </button>
          ))}
          {!list.data?.length && <p className="px-3 py-2 text-sm text-muted">No staff added yet — the owner can add them in Staff & salary.</p>}
        </div>
      </Dialog>
    </>
  );
}
