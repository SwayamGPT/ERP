import { Plus, Receipt, X } from 'lucide-react';
import { Kbd } from '../../components/ui';
import { cn } from '../../lib/cn';
import { MAX_BILLS, usePos } from './store';

/** Several customers at the counter? Each gets their own bill tab. */
export function BillTabs({ onNew, onSwitch, onClose }: { onNew: () => void; onSwitch: (i: number) => void; onClose: (i: number) => void }) {
  const bills = usePos((s) => s.bills);
  const active = usePos((s) => s.active);
  return (
    <div className="flex items-end gap-1 overflow-x-auto border-b border-border bg-surface-2/60 px-3 pt-2" role="tablist" aria-label="Open bills" data-testid="bill-tabs">
      {bills.map((b, i) => {
        const label = b.party && !b.party.is_walkin ? b.party.name : `Bill ${b.no}`;
        const items = b.lines.length;
        return (
          <div
            key={b.id}
            role="tab"
            aria-selected={i === active}
            tabIndex={0}
            onClick={() => onSwitch(i)}
            onKeyDown={(e) => e.key === 'Enter' && onSwitch(i)}
            onMouseDown={(e) => e.button === 1 && (e.preventDefault(), onClose(i))}
            title={`${label} · Alt+${i + 1}`}
            data-testid="bill-tab"
            className={cn(
              'group relative flex h-10 min-w-[110px] max-w-[200px] shrink-0 cursor-pointer select-none items-center gap-2 rounded-t-xl border border-b-0 px-3 text-sm transition',
              i === active ? 'z-[1] -mb-px border-border bg-surface font-semibold text-ink' : 'border-transparent text-muted hover:bg-surface/70 hover:text-ink',
            )}
          >
            <Receipt className={cn('h-4 w-4 shrink-0', i === active ? 'text-primary' : 'text-faint')} />
            <span className="truncate">{label}</span>
            {items > 0 && <span className={cn('rounded-full px-1.5 text-[10px] font-semibold tnum', i === active ? 'bg-primary text-primary-fg' : 'bg-border text-muted')}>{items}</span>}
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Close ${label}`}
              onClick={(e) => (e.stopPropagation(), onClose(i))}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-faint opacity-60 hover:bg-bad-soft hover:text-bad group-hover:opacity-100"
              data-testid="bill-tab-close"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        );
      })}
      {bills.length < MAX_BILLS && (
        <button onClick={onNew} className="mb-1 ml-1 flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-sm font-medium text-primary hover:bg-primary-soft" data-testid="bill-new">
          <Plus className="h-4 w-4" /> New bill <Kbd>F2</Kbd>
        </button>
      )}
      <span className="mb-2 ml-auto hidden whitespace-nowrap text-[11px] text-faint 2xl:block">F3 next bill · Alt+1…9 jump · Alt+X close</span>
    </div>
  );
}
