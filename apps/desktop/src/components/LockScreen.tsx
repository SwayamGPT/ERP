import type { Role } from '@hisaab/core';
import { Delete, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { call, queryClient } from '../db/client';
import type { Company } from '../db/types';
import { cn } from '../lib/cn';
import { useUi } from '../lib/store';
import { Logo } from './Logo';

export function LockScreen({ users, company }: { users: Array<{ id: number; name: string; role: Role }>; company: Company }) {
  const [userId, setUserId] = useState(users[0]?.id);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), [userId]);

  const submit = async (p = pin) => {
    if (!userId || p.length < 4) return;
    try {
      const s = await call('auth.login', { userId, pin: p });
      useUi.getState().setSession(s);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
      setPin('');
      setShake(true);
      setTimeout(() => setShake(false), 400);
    }
  };

  const press = (d: string) => {
    setError('');
    const next = (pin + d).slice(0, 6);
    setPin(next);
  };

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-bg p-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-saffron/10 blur-3xl" />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">{company.name}</h1>
          <p className="text-sm text-muted">Who's at the counter?</p>
        </div>
        <div className="card p-5">
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {users.map((u) => (
              <button
                key={u.id}
                onClick={() => (setUserId(u.id), setPin(''), setError(''), setTimeout(() => inputRef.current?.focus(), 0))}
                className={cn('flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors', u.id === userId ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-2')}
              >
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary text-[11px] font-semibold text-primary-fg">{u.name[0]}</span>
                {u.name}
                <span className="text-[10px] capitalize text-muted">{u.role}</span>
              </button>
            ))}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="sr-only" htmlFor="pin">PIN</label>
            <input
              id="pin"
              ref={inputRef}
              data-testid="pin-input"
              value={pin}
              onChange={(e) => (setError(''), setPin(e.target.value.replace(/\D/g, '').slice(0, 6)))}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="absolute h-0 w-0 opacity-0"
            />
            <div className={cn('mb-1 flex justify-center gap-3 py-3', shake && 'animate-[pop_.1s_ease-in-out_3]')} onClick={() => inputRef.current?.focus()}>
              {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                <span key={i} className={cn('h-3.5 w-3.5 rounded-full border-2 transition-all', i < pin.length ? 'scale-110 border-primary bg-primary' : 'border-border')} />
              ))}
            </div>
            <p className="mb-3 h-5 text-center text-xs text-bad">{error}</p>
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
                <Key key={d} onClick={() => press(d)}>{d}</Key>
              ))}
              <Key onClick={() => setPin(pin.slice(0, -1))} aria-label="Delete"><Delete className="h-5 w-5" /></Key>
              <Key onClick={() => press('0')}>0</Key>
              <button type="submit" className="h-14 rounded-xl bg-primary text-sm font-semibold text-primary-fg transition hover:bg-primary/90 active:scale-95 disabled:opacity-40" disabled={pin.length < 4} data-testid="unlock">
                Unlock
              </button>
            </div>
          </form>
        </div>
        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-faint">
          <ShieldCheck className="h-3.5 w-3.5" /> Your data stays on this computer
        </p>
      </div>
    </div>
  );
}

function Key({ children, onClick, ...rest }: { children: React.ReactNode; onClick: () => void; 'aria-label'?: string }) {
  return (
    <button type="button" onClick={onClick} className="h-14 rounded-xl bg-surface-2 text-lg font-medium transition hover:bg-border/70 active:scale-95" {...rest}>
      {children}
    </button>
  );
}
