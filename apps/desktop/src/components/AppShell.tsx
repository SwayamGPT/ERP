import type { Permission } from '@hisaab/core';
import {
  BarChart3,
  Boxes,
  Barcode,
  Check,
  ChevronsLeft,
  HandCoins,
  Contact,
  History,
  ReceiptText,
  ChevronsUpDown,
  ClipboardList,
  Plus,
  Cloud,
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
  Warehouse, Ticket, FileText } from 'lucide-react';
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
import { toast } from './ui';
import { ShortcutSheet } from './ShortcutSheet';
import { Logo } from './Logo';
import { PrintQueueBanner } from './PrintQueueBanner';
import { ImportReview } from './ImportReview';
import * as Popover from '@radix-ui/react-popover';
import { db } from '../db/client';
import { useApi } from '../lib/useApi';
import { usePos } from '../features/pos/store';
import { queryClient } from '../db/client';
import { useAutoCloudBackup } from '../features/cloud/backup';
import { useScheduledDriveBackup } from '../backup/schedule';

type NavItem = { to: string; label: string; icon: ReactNode; perm?: Permission; kbd?: string; end?: boolean; badge?: number };

export function useNav(): Array<{ group: string; items: NavItem[] }> {
  const t = useT();
  const status = useApi('app.status').data;
  return [
    { group: '', items: [{ to: '/', label: t('nav.home'), icon: <Home />, end: true, kbd: 'Alt+H' }] },
    {
      group: t('nav.sell'),
      items: [
        { to: '/pos', label: t('nav.newBill'), icon: <ShoppingCart />, perm: 'sale.create', kbd: 'Alt+N' },
        { to: '/sales', label: t('nav.sales'), icon: <ScrollText />, perm: 'sale.view', kbd: 'Alt+S' },
        { to: '/quotations', label: 'Quotations', icon: <FileText />, perm: 'sale.view' },
      ],
    },
    {
      group: t('nav.buy'),
      items: [
        { to: '/purchases/new', label: t('nav.newPurchase'), icon: <Truck />, perm: 'purchase.create', kbd: 'Alt+P' },
        { to: '/purchases', label: t('nav.purchases'), icon: <ShoppingBag />, perm: 'purchase.view', end: true },
        { to: '/purchases/orders', label: 'Orders & reorder', icon: <ClipboardList />, perm: 'purchase.view' },
        { to: '/purchases/coupons', label: 'Supplier coupons', icon: <Ticket />, perm: 'purchase.view' },
      ],
    },
    {
      group: t('nav.stock'),
      items: [
        { to: '/items', label: t('nav.items'), icon: <Package />, perm: 'item.view', kbd: 'Alt+I', end: true },
        { to: '/items/labels', label: t('nav.labels'), icon: <Barcode />, perm: 'item.edit' },
        { to: '/items/stock', label: 'Stock report', icon: <Boxes />, perm: 'item.view' },
        { to: '/items/godowns', label: 'Godowns', icon: <Warehouse />, perm: 'item.view' },
      ],
    },
    {
      group: t('nav.money'),
      items: [
        { to: '/parties', label: t('nav.parties'), icon: <Users />, perm: 'party.view', kbd: 'Alt+C' },
        { to: '/money', label: t('nav.moneyInOut'), icon: <Wallet />, perm: 'payment.in', kbd: 'Alt+M' },
        { to: '/expenses', label: t('nav.expenses'), icon: <ReceiptText />, perm: 'expense.view', kbd: 'Alt+E' },
        { to: '/staff', label: t('nav.staff'), icon: <Contact />, perm: 'payroll.manage', badge: status?.pendingRequests || undefined },
        ...(status?.me ? [{ to: '/me', label: t('nav.myPay'), icon: <HandCoins /> }] : []),
      ],
    },
    {
      group: t('nav.insights'),
      items: [
        { to: '/reports', label: t('nav.reports'), icon: <BarChart3 />, perm: 'report.view', kbd: 'Alt+R' },
        { to: '/gst', label: t('nav.gst'), icon: <FileSpreadsheet />, perm: 'gst.view', kbd: 'Alt+G' },
        { to: '/activity', label: t('nav.activity'), icon: <History />, perm: 'users.manage' },
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
  useAutoCloudBackup();
  useScheduledDriveBackup();
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
    'alt+e': go('/expenses', 'expense.view'),
    'alt+r': go('/reports', 'report.view'),
    'alt+g': go('/gst', 'gst.view'),
    'alt+l': () => void lock(),
    'mod+b': toggleSidebar,
  });

  const enterpriseId = useApi('app.status').data?.enterpriseId ?? null;
  useEffect(() => {
    // Create due bills for repeating expenses (rent, EMIs…) whenever someone unlocks.
    if (session) call('expenses.sync').then((n) => n > 0 && toast.info(`${n} repeating bill${n > 1 ? 's' : ''} added to Bills to pay`)).catch(() => {});
  }, [session?.userId, enterpriseId]);
  useEffect(() => usePos.getState().attach(enterpriseId), [enterpriseId]);
  const openBills = usePos((s) => s.bills.filter((b) => b.lines.length > 0).length);
  const isPos = loc.pathname === '/pos';
  const dark = document.documentElement.dataset.theme === 'dark';

  return (
    <div className="flex h-full">
      <aside className={cn('no-print flex shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200', sidebarCollapsed ? 'w-[60px]' : 'w-[232px]')}>
        <EnterpriseSwitcher company={company} collapsed={sidebarCollapsed} />
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
                      {!sidebarCollapsed && <span className="flex-1 truncate">{i.label}</span>}
                      {!sidebarCollapsed && !!i.badge && <span className="rounded-full bg-saffron px-1.5 text-[10px] font-semibold text-black/80" title="Waiting for you" data-testid="nav-badge">{i.badge}</span>}
                      {!sidebarCollapsed && i.to === '/pos' && openBills > 0 && <span className="rounded-full bg-saffron px-1.5 text-[10px] font-semibold text-black/80" title="Bills in progress">{openBills}</span>}
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
          <SyncPill />
          <div className="hidden items-center gap-1.5 text-xs text-muted md:flex" title="Every bill is saved on this computer instantly.">
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
        <PrintQueueBanner />
        <ImportReview />
        <main className={cn('min-h-0 flex-1 overflow-y-auto', isPos ? '' : 'px-6 py-6')}>
          <div className={cn(isPos ? 'h-full' : 'mx-auto max-w-[1400px]')}>{children}</div>
        </main>
      </div>
      <CommandPalette />
      <ShortcutSheet />
    </div>
  );
}

function EnterpriseSwitcher({ company, collapsed }: { company: Company; collapsed: boolean }) {
  const status = useApi('app.status');
  const enterprises = status.data?.enterprises ?? [];
  const current = status.data?.enterpriseId;
  const [open, setOpen] = useState(false);
  const go = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    await db.flush();
    usePos.getState().reset();
    await fn();
    useUi.getState().setSession(null);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className={cn('m-2 flex h-12 items-center gap-2.5 rounded-xl px-2 text-left transition hover:bg-surface-2', collapsed && 'justify-center')} title="Switch enterprise" data-testid="enterprise-switcher">
          <Logo className="h-7 w-7 shrink-0" />
          {!collapsed && (
            <>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold leading-tight tracking-tight">Hisaab</div>
                <div className="truncate text-[11px] text-muted" title={company.name}>{company.name}</div>
              </div>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-faint" />
            </>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="bottom" align="start" sideOffset={4} className="z-50 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-pop animate-pop">
          <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-faint">Enterprises</div>
          {enterprises.map((e) => (
            <button key={e.id} disabled={e.id === current} onClick={() => go(() => db.openEnterprise(e.id))} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2 disabled:bg-primary-soft/60">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-primary-soft text-xs font-semibold text-primary">{e.name.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{e.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted">{e.gstin}</span>
              </span>
              {e.id === current && <Check className="h-4 w-4 text-primary" />}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button onClick={() => go(() => db.createEnterprise())} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium text-primary hover:bg-surface-2" data-testid="enterprise-add">
            <Plus className="h-4 w-4" /> Add new enterprise
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function IconBtn({ children, title, onClick }: { children: ReactNode; title: string; onClick: () => void }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="grid h-9 w-9 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]">
      {children}
    </button>
  );
}

/** Cloud sync status, shown only when this enterprise is connected to a shop. */
function SyncPill() {
  const sync = useApi('app.status').data?.sync;
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!sync?.connected) return null;
  const last = sync.lastPullAt ? new Date(`${sync.lastPullAt.replace(' ', 'T')}Z`) : null;
  const ago = last ? relTime(last) : 'not yet';
  const err = sync.lastError;
  const label = err ? (sync.pending ? `${err} · ${sync.pending} waiting` : err) : sync.pending ? `Syncing · ${sync.pending} waiting` : `Synced ${ago}`;
  return (
    <button
      onClick={() => void db.syncNow()}
      className={cn('hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs md:flex', err ? 'border-warn/40 text-warn' : 'border-border text-muted hover:text-fg')}
      title={`Cloud sync${sync.deviceName ? ` — ${sync.deviceName}` : ''}. Click to sync now.`}
      data-testid="sync-state"
    >
      {err ? <CloudOff className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

function relTime(d: Date) {
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return d.toLocaleDateString();
}
