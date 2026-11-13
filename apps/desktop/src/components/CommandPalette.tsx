import { Command } from 'cmdk';
import * as RD from '@radix-ui/react-dialog';
import { FileText, Package, Plus, User } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inr } from '../lib/format';
import { useCan } from '../lib/perm';
import { useUi } from '../lib/store';
import { useApi } from '../lib/useApi';
import { useNav } from './AppShell';

export function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useUi();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const nav = useNav();
  const canDo = useCan();
  const items = useApi('items.list', { q, limit: 6 }, { enabled: paletteOpen && q.length > 1 && canDo('item.view') });
  const parties = useApi('parties.list', { q, limit: 5 }, { enabled: paletteOpen && q.length > 1 && canDo('party.view') });
  const bills = useApi('invoices.list', { kind: 'sales_all', q, limit: 5 }, { enabled: paletteOpen && q.length > 1 && canDo('sale.view') });

  const go = (to: string) => {
    setPaletteOpen(false);
    setQ('');
    navigate(to);
  };

  const actions = [
    { label: 'New bill', to: '/pos', perm: 'sale.create' as const, kbd: 'Alt+N' },
    { label: 'New purchase entry', to: '/purchases/new', perm: 'purchase.create' as const, kbd: 'Alt+P' },
    { label: 'Add new item', to: '/items?new=1', perm: 'item.edit' as const },
    { label: 'Add customer or supplier', to: '/parties?new=1', perm: 'party.edit' as const },
    { label: 'Receive payment', to: '/money?action=in', perm: 'payment.in' as const },
    { label: 'Add expense (rent, electricity, tea…)', to: '/expenses?new=1', perm: 'expense.create' as const },
    { label: 'Bills to pay', to: '/expenses?tab=due', perm: 'expense.view' as const },
    { label: 'Run salary', to: '/staff', perm: 'payroll.manage' as const },
    { label: 'Count cash in drawer', to: '/money?action=check', perm: 'money.move' as const },
    { label: 'Deposit cash in bank', to: '/money?action=transfer', perm: 'money.move' as const },
    { label: 'Cash flow', to: '/money?tab=flow', perm: 'expense.view' as const },
    { label: 'Profit & loss', to: '/reports?tab=pnl', perm: 'report.profit' as const },
    { label: 'Download GSTR-1', to: '/gst', perm: 'gst.view' as const },
    { label: 'Low stock items', to: '/items?filter=low', perm: 'item.view' as const },
    { label: 'Take a backup', to: '/settings?tab=backup', perm: 'backup.manage' as const },
  ].filter((a) => canDo(a.perm));

  return (
    <RD.Root open={paletteOpen} onOpenChange={setPaletteOpen}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-fade-in" />
        <RD.Content className="fixed left-1/2 top-[12vh] z-50 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-pop animate-pop" aria-describedby={undefined}>
          <RD.Title className="sr-only">Command palette</RD.Title>
          <Command shouldFilter={true} loop className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-faint">
            <Command.Input value={q} onValueChange={setQ} autoFocus placeholder="Type a command, item, customer or bill number…" className="h-14 w-full border-b border-border bg-transparent px-5 text-[15px] outline-none placeholder:text-faint" />
            <Command.List className="max-h-[60vh] overflow-y-auto p-2">
              <Command.Empty className="py-10 text-center text-sm text-muted">Nothing found.</Command.Empty>
              <Command.Group heading="Actions">
                {actions.map((a) => (
                  <Row key={a.label} onSelect={() => go(a.to)} icon={<Plus />} kbd={a.kbd}>
                    {a.label}
                  </Row>
                ))}
              </Command.Group>
              <Command.Group heading="Go to">
                {nav.flatMap((g) => g.items.filter((i) => !i.perm || canDo(i.perm))).map((i) => (
                  <Row key={i.to} onSelect={() => go(i.to)} icon={i.icon} kbd={i.kbd}>
                    {i.label}
                  </Row>
                ))}
              </Command.Group>
              {!!items.data?.length && (
                <Command.Group heading="Items">
                  {items.data.map((i) => (
                    <Row key={i.id} value={`item ${i.name} ${i.barcode ?? ''} ${i.short_code ?? ''}`} onSelect={() => go(`/items?id=${i.id}`)} icon={<Package />} meta={`${inr(i.retail_price)} · ${i.stock} ${i.base_unit}`}>
                      {i.name}
                    </Row>
                  ))}
                </Command.Group>
              )}
              {!!parties.data?.length && (
                <Command.Group heading="Customers & suppliers">
                  {parties.data.filter((p) => !p.is_walkin).map((p) => (
                    <Row key={p.id} value={`party ${p.name} ${p.phone ?? ''}`} onSelect={() => go(`/parties/${p.id}`)} icon={<User />} meta={p.balance ? inr(Math.abs(p.balance)) + (p.balance > 0 ? ' to collect' : ' to pay') : p.kind}>
                      {p.name}
                    </Row>
                  ))}
                </Command.Group>
              )}
              {!!bills.data?.length && (
                <Command.Group heading="Bills">
                  {bills.data.map((b) => (
                    <Row key={b.id} value={`bill ${b.number} ${b.party_name}`} onSelect={() => go(`/sales/${b.id}`)} icon={<FileText />} meta={inr(b.total)}>
                      {b.number} · {b.party_name}
                    </Row>
                  ))}
                </Command.Group>
              )}
            </Command.List>
            <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-faint">
              <span><kbd className="kbd">↑</kbd> <kbd className="kbd">↓</kbd> move</span>
              <span><kbd className="kbd">Enter</kbd> open</span>
              <span><kbd className="kbd">Esc</kbd> close</span>
            </div>
          </Command>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

function Row({ children, icon, kbd, meta, onSelect, value }: { children: React.ReactNode; icon: React.ReactNode; kbd?: string; meta?: string; onSelect: () => void; value?: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-10 cursor-pointer items-center gap-3 rounded-lg px-3 text-sm text-ink aria-selected:bg-primary-soft aria-selected:text-primary [&>svg]:h-4 [&>svg]:w-4 [&>svg]:text-faint">
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {meta && <span className="text-xs text-muted">{meta}</span>}
      {kbd && <span className="kbd">{kbd}</span>}
    </Command.Item>
  );
}
