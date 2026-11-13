import type { Permission } from '@hisaab/core';
import {
  BarChart3,
  Barcode,
  ChevronsLeft,
  CloudOff,
  Command,
  FileSpreadsheet,
  Home,
  Keyboard,
  Languages,
  Lock,
  Moon,
  Package,
  ScrollText,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sun,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { call } from '../db/client';
import type { Company } from '../db/types';
import { cn } from '../lib/cn';
import { useHotkeys } from '../lib/hotkeys';
import { useT } from '../lib/i18n';
import { useCan } from '../lib/perm';
import { useUi } from '../lib/store';
import { CommandPalette } from './CommandPalette';
import { ShortcutSheet } from './ShortcutSheet';
import { Logo } from './Logo';
import { queryClient } from '../db/client';

type NavItem = { to: string; label: string; icon: ReactNode; perm?: Permission; kbd?: string; end?: boolean };

export function useNav(): Array<{ group: string; items: NavItem[] }> {
  const t = useT();
  return [
    { group: '', items: [{ to: '/', label: t('nav.home'), icon: <Home />, end: true, kbd: 'Alt+H' }] },
    {
      group: t('nav.sell'),
      items: [
        { to: '/pos', label: t('nav.newBill'), icon: <ShoppingCart />, perm: 'sale.create', kbd: 'Alt+N' },
        { to: '/sales', label: t('nav.sales'), icon: <ScrollText />, perm: 'sale.view', kbd: 'Alt+S' },
      ],
    },
    {
      group: t('nav.buy'),
      items: [
        { to: '/purchases/new', label: t('nav.newPurchase'), icon: <Truck />, perm: 'purchase.create', kbd: 'Alt+P' },
        { to: '/purchases', label: t('nav.purchases'), icon: <ShoppingBag />, perm: 'purchase.view', end: true },
      ],
    },
    {
      group: t('nav.stock'),
      items: [
        { to: '/items', label: t('nav.items'), icon: <Package />, perm: 'item.view', kbd: 'Alt+I', end: true },
        { to: '/items/labels', label: t('nav.labels'), icon: <Barcode />, perm: 'item.edit' },
      ],
    },
    {
      group: t('nav.money'),
      items: [
        { to: '/parties', label: t('nav.parties'), icon: <Users />, perm: 'party.view', kbd: 'Alt+C' },
        { to: '/money', label: t('nav.moneyInOut'), icon: <Wallet />, perm: 'payment.in', kbd: 'Alt+M' },
      ],
    },
    {
      group: t('nav.insights'),
      items: [
        { to: '/reports', label: t('nav.reports'), icon: <BarChart3 />, perm: 'report.view', kbd: 'Alt+R' },
        { to: '/gst', label: t('nav.gst'), icon: <FileSpreadsheet />, perm: 'gst.view', kbd: 'Alt+G' },
      ],
    },
  ];
}

export function AppShell({ company, children }: { company: Company; children: ReactNode }) {
  const nav = useNav();
  const canDo = useCan();
  const navigate = useNavigate();
  const loc = useLocation();
  const t = useT();
  const { sidebarCollapsed, toggleSidebar, setPaletteOpen, setShortcutsOpen, session, setTheme, lang, setLang, saveState } = useUi();
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => (window.removeEventListener('online', on), window.removeEventListener('offline', off));
  }, []);

  const lock = async () => {
    await call('auth.lock');
    useUi.getState().setSession(null);
    await queryClient.invalidateQueries();
  };

  const go = (to: string, perm?: Permission) => () => (!perm || canDo(perm)) && navigate(to);
  useHotkeys({
    'mod+k': () => setPaletteOpen(true),
    '?': () => setShortcutsOpen(true),
    'alt+h': go('/'),
    'alt+n': go('/pos', 'sale.create'),
    'alt+s': go('/sales', 'sale.view'),
    'alt+p': go('/purchases/new', 'purchase.create'),
    'alt+i': go('/items', 'item.view'),
    'alt+c': go('/parties', 'party.view'),
    'alt+m': go('/money', 'payment.in'),
    'alt+r': go('/reports', 'report.view'),
    'alt+g': go('/gst', 'gst.view'),
    'alt+l': () => void lock(),
    'mod+b': toggleSidebar,
  });

  const isPos = loc.pathname === '/pos';
  const dark = document.documentElement.dataset.theme === 'dark';

  return (
    <div className="flex h-full">
      <aside className={cn('no-print flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200', sidebarCollapsed ? 'w-[60px]' : 'w-[232px]')}>
        <div className={cn('flex h-14 items-center gap-2.5 px-4', sidebarCollapsed && 'justify-center px-0')}>
          <Logo className="h-7 w-7 shrink-0" />
          {!sidebarCollapsed && (
            <div className="min-w-0">
              <div className="text-[15px] font-semibold leading-tight tracking-tight">Hisaab</div>
              <div className="truncate text-[11px] text-muted" title={company.name}>
                {company.name}
              </div>
            </div>
          )}
        </div>
        <nav className="flex-1 space-y-4 overflow-y-auto px-2.5 py-2">
          {nav.map((g) => {
            const items = g.items.filter((i) => !i.perm || canDo(i.perm));
            if (!items.length) return null;
            return (
              <div key={g.group || 'root'}>
                {g.group && !sidebarCollapsed && <div className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-faint">{g.group}</div>}
                <div className="space-y-0.5">
                  {items.map((i) => (
                    <NavLink
                      key={i.to}
                      to={i.to}
                      end={i.end}
                      title={sidebarCollapsed ? `${i.label}${i.kbd ? ` (${i.kbd})` : ''}` : i.kbd}
                      className={({ isActive }) =>
                        cn(
                          'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors [&>svg]:h-[18px] [&>svg]:w-[18px] [&>svg]:shrink-0',
                          sidebarCollapsed && 'justify-center px-0',
                          isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-ink',
                        )
                      }
                    >
                      {i.icon}
                      {!sidebarCollapsed && <span className="truncate">{i.label}</span>}
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="space-y-0.5 border-t border-border p-2.5">
          {canDo('settings.edit') || canDo('users.manage') ? (
            <NavLink to="/settings" className={({ isActive }) => cn('flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium [&>svg]:h-[18px] [&>svg]:w-[18px]', sidebarCollapsed && 'justify-center px-0', isActive ? 'bg-primary-soft text-primary' : 'text-muted hover:bg-surface-2 hover:text-ink')}>
              <Settings />
              {!sidebarCollapsed && t('nav.settings')}
            </NavLink>
          ) : null}
          <button onClick={toggleSidebar} className={cn('flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-faint hover:bg-surface-2 hover:text-ink', sidebarCollapsed && 'justify-center px-0')} title="Collapse sidebar (Ctrl+B)">
            <ChevronsLeft className={cn('h-[18px] w-[18px] transition-transform', sidebarCollapsed && 'rotate-180')} />
            {!sidebarCollapsed && 'Collapse'}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2/60 px-3 text-sm text-faint transition-colors hover:border-primary/40 hover:text-muted"
            data-testid="open-palette"
          >
            <Command className="h-4 w-4" />
            <span className="flex-1 text-left">Search or jump to…</span>
            <kbd className="kbd">Ctrl</kbd>
            <kbd className="kbd">K</kbd>
          </button>
          <div className="flex-1" />
          <div className="hidden items-center gap-1.5 text-xs text-muted md:flex" title="Every bill is saved on this computer instantly. Cloud sync arrives in the next release.">
            {online ? (
              <span className={cn('h-2 w-2 rounded-full', saveState === 'saved' ? 'bg-good' : 'bg-saffron animate-pulse')} />
            ) : (
              <CloudOff className="h-3.5 w-3.5 text-warn" />
            )}
            <span data-testid="save-state">{saveState === 'saved' ? (online ? 'Saved on this PC' : 'Offline · saved locally') : 'Saving…'}</span>
          </div>
          <IconBtn title="Keyboard shortcuts (?)" onClick={() => setShortcutsOpen(true)}>
            <Keyboard />
          </IconBtn>
          <IconBtn title={lang === 'en' ? 'हिन्दी में देखें' : 'Switch to English'} onClick={() => setLang(lang === 'en' ? 'hi' : 'en')}>
            <Languages />
          </IconBtn>
          <IconBtn title="Toggle theme" onClick={() => setTheme(dark ? 'light' : 'dark')}>
            {dark ? <Sun /> : <Moon />}
          </IconBtn>
          <div className="mx-1 h-6 w-px bg-border" />
          <button onClick={lock} className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 hover:bg-surface-2" title="Lock / switch user (Alt+L)" data-testid="user-menu">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-fg">{session?.name.slice(0, 1).toUpperCase()}</span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-xs font-medium">{session?.name}</span>
              <span className="block text-[10px] capitalize text-muted">{session?.role}</span>
            </span>
            <Lock className="h-3.5 w-3.5 text-faint" />
          </button>
        </header>
        <main className={cn('min-h-0 flex-1 overflow-y-auto', isPos ? '' : 'px-6 py-6')}>
          <div className={cn(isPos ? 'h-full' : 'mx-auto max-w-[1400px]')}>{children}</div>
        </main>
      </div>
      <CommandPalette />
      <ShortcutSheet />
    </div>
  );
}

function IconBtn({ children, title, onClick }: { children: ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]">
      {children}
    </button>
  );
}
