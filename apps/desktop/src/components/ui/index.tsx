import * as RD from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { forwardRef, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { create } from 'zustand';
import { cn } from '../../lib/cn';
import { inr } from '../../lib/format';

/* ───────────── Button ───────────── */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'saffron' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl';
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary/90 shadow-sm',
  secondary: 'bg-surface-2 text-ink hover:bg-border/70',
  ghost: 'text-muted hover:bg-surface-2 hover:text-ink',
  danger: 'bg-bad text-white hover:bg-bad/90',
  saffron: 'bg-saffron text-black/85 hover:bg-saffron/90 shadow-sm',
  outline: 'border border-border bg-surface text-ink hover:bg-surface-2',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-4 text-sm gap-2 rounded-lg',
  xl: 'h-14 px-5 text-base gap-2.5 rounded-xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  kbd?: string;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, kbd, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-all active:scale-[.98] disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
      {kbd && (
        <span
          className={cn(
            'kbd ml-1',
            (variant === 'primary' || variant === 'danger') && 'border-white/25 bg-white/15 text-white',
            variant === 'saffron' && 'border-black/10 bg-black/10 text-black/70',
          )}
        >
          {kbd}
        </span>
      )}
    </button>
  );
});

/* ───────────── Inputs ───────────── */
export const Input = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> & { prefix?: ReactNode; suffix?: ReactNode }>(
  function Input({ className, prefix, suffix, ...rest }, ref) {
    if (!prefix && !suffix) return <input ref={ref} className={cn('input', className)} {...rest} />;
    return (
      <div className={cn('relative flex items-center', className)}>
        {prefix && <span className="pointer-events-none absolute left-3 text-sm text-faint">{prefix}</span>}
        <input ref={ref} className={cn('input', prefix ? 'pl-7' : '', suffix ? 'pr-10' : '')} {...rest} />
        {suffix && <span className="absolute right-3 text-xs text-faint">{suffix}</span>}
      </div>
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn('input appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8', className)} style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23949bac' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-bad">{error}</span> : hint ? <span className="mt-1 block text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

/** Rupee amount input — keeps the text the user types, reports paise. */
export const MoneyInput = forwardRef<HTMLInputElement, { value: number | null | undefined; onChange: (p: number) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'prefix'>>(
  function MoneyInput({ value, onChange, className, ...rest }, ref) {
    const [text, setText] = useState(value ? (value / 100).toString() : '');
    useEffect(() => {
      const cur = Math.round(parseFloat(text || '0') * 100);
      if ((value ?? 0) !== cur) setText(value ? (value / 100).toString() : '');
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value]);
    return (
      <Input
        ref={ref}
        prefix="₹"
        inputMode="decimal"
        className={className}
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d.]/g, '');
          setText(t);
          onChange(Math.round(parseFloat(t || '0') * 100));
        }}
        {...rest}
      />
    );
  },
);

export function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-primary' : 'bg-border')}
      >
        <span className={cn('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
      </button>
      {label && (
        <span>
          <span className="block text-sm font-medium">{label}</span>
          {hint && <span className="block text-xs text-muted">{hint}</span>}
        </span>
      )}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, size = 'md', full = false }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; size?: 'sm' | 'md'; full?: boolean }) {
  return (
    <div className={cn('rounded-lg bg-surface-2 p-0.5', full ? 'grid w-full auto-cols-fr grid-flow-col' : 'inline-flex')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-md font-medium transition-all',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ───────────── Display ───────────── */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('kbd', className)}>{children}</kbd>;
}

type Tone = 'neutral' | 'primary' | 'good' | 'bad' | 'warn' | 'saffron';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted',
  primary: 'bg-primary-soft text-primary',
  good: 'bg-good-soft text-good',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  saffron: 'bg-saffron-soft text-saffron-ink',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('chip', tones[tone], className)}>{children}</span>;
}

export function Money({ value, className, tone, decimals = true }: { value: number | null | undefined; className?: string; tone?: 'auto' | 'in' | 'out'; decimals?: boolean }) {
  const v = value ?? 0;
  return (
    <span className={cn('money tnum', tone === 'in' && 'text-saffron-ink', tone === 'out' && 'text-bad', tone === 'auto' && (v < 0 ? 'text-bad' : v > 0 ? 'text-good' : 'text-muted'), className)}>
      {inr(v, decimals)}
    </span>
  );
}

export function Card({ children, className, title, action, padded = true }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode; padded?: boolean }) {
  return (
    <section className={cn('card', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h3 className="text-sm font-semibold">{title}</h3>
          {action}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, icon }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {icon && <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary-soft text-primary">{icon}</div>}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-surface-2 text-faint">{icon}</div>
      <p className="font-medium">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, icon, tone = 'neutral', onClick }: { label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; tone?: Tone; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={cn('card group flex w-full flex-col p-4 text-left transition-all', onClick && 'hover:-translate-y-px hover:shadow-pop')}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">{label}</span>
        {icon && <span className={cn('grid h-7 w-7 place-items-center rounded-lg', tones[tone])}>{icon}</span>}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tnum">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: ReactNode; count?: number }> }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-border" data-testid="tabs">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            '-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors',
            value === t.value ? 'border-primary text-ink' : 'border-transparent text-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-surface-2 px-1.5 text-[10px] text-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-5 w-5 animate-spin text-faint', className)} />;
}

export function Loading() {
  return (
    <div className="grid place-items-center py-20">
      <Spinner />
    </div>
  );
}

/* ───────────── Dialog & Drawer ───────────── */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const w = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] animate-fade-in" />
        <RD.Content
          className={cn('fixed left-1/2 top-[8vh] z-50 flex max-h-[84vh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-2xl border border-border bg-surface shadow-pop animate-pop focus:outline-none', w)}
          aria-describedby={undefined}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <RD.Title className="text-base font-semibold">{title}</RD.Title>
              {description && <RD.Description className="mt-0.5 text-sm text-muted">{description}</RD.Description>}
            </div>
            <RD.Close className="rounded-md p-1 text-faint hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </RD.Close>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

export function Drawer({ open, onOpenChange, title, children, footer, width = 'max-w-xl' }: { open: boolean; onOpenChange: (v: boolean) => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  return (
    <RD.Root open={open} onOpenChange={onOpenChange}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-40 bg-black/30 animate-fade-in" />
        <RD.Content className={cn('fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-surface shadow-pop animate-slide-in-right focus:outline-none', width)} aria-describedby={undefined}>
          <div className="flex items-center justify-between border-b border-border px-5 py-4">
            <RD.Title className="text-base font-semibold">{title}</RD.Title>
            <RD.Close className="rounded-md p-1 text-faint hover:bg-surface-2 hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </RD.Close>
          </div>
          <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}

/* ───────────── Toasts ───────────── */
interface Toast {
  id: number;
  tone: 'good' | 'bad' | 'neutral';
  title: string;
  body?: string;
  action?: { label: string; run: () => void };
}
const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, 'id'>) => void; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.tone === 'bad' ? 6000 : 3500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

export const toast = {
  success: (title: string, body?: string, action?: Toast['action']) => useToasts.getState().push({ tone: 'good', title, body, action }),
  error: (e: unknown) => useToasts.getState().push({ tone: 'bad', title: e instanceof Error ? e.message : String(e) }),
  info: (title: string, body?: string) => useToasts.getState().push({ tone: 'neutral', title, body }),
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="no-print pointer-events-none fixed bottom-14 left-1/2 z-[60] flex w-[380px] -translate-x-1/2 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-pop animate-pop" data-testid="toast">
          <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', t.tone === 'good' ? 'bg-good' : t.tone === 'bad' ? 'bg-bad' : 'bg-primary')} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            {t.body && <p className="mt-0.5 text-xs text-muted">{t.body}</p>}
          </div>
          {t.action && (
            <button className="text-xs font-semibold text-primary hover:underline" onClick={() => (t.action!.run(), dismiss(t.id))}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/* ───────────── Confirm ───────────── */
export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = 'Confirm', danger, onConfirm, children }: { open: boolean; onOpenChange: (v: boolean) => void; title: string; body?: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <div className="text-sm text-muted">{body}</div>}
      {children}
    </Dialog>
  );
}
