import type { Role } from '@hisaab/core';
import { Building2, Delete, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { call, db, queryClient } from '../db/client';
import type { Company } from '../db/types';
import { cn } from '../lib/cn';
import { useUi } from '../lib/store';
import { Logo } from './Logo';

export function LockScreen({ users, company, enterpriseCount = 1 }: { users: Array<{ id: number; name: string; role: Role }>; company: Company; enterpriseCount?: number }) {
  const [userId, setUserId] = useState(users[0]?.id);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // PINs are 4 digits and unlock on the 4th; "longer PIN" is only for people still on an old 5–6 digit PIN.
  const [long, setLong] = useState(false);
  const max = long ? 6 : 4;
  const busy = useRef(false);

  useEffect(() => inputRef.current?.focus(), [userId]);

  const enter = (next: string) => {
    setError('');
    const v = next.replace(/\D/g, '').slice(0, max);
    setPin(v);
    if (!long && v.length === 4) void submit(v);
  };

  const submit = async (p = pin) => {
    if (!userId || p.length < 4 || busy.current) return;
    busy.current = true;
    try {
      const s = await call('auth.login', { userId, pin: p });
      useUi.getState().setSession(s);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
      setPin('');
      setShake(true);
      setTimeout(() => setShake(false), 400);
    } finally {
      busy.current = false;
    }
  };

  const press = (d: string) => enter(pin + d);

  return (
    <div className="relative grid h-full place-items-center overflow-hidden bg-bg p-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-24 h-[28rem] w-[28rem] rounded-full bg-saffron/10 blur-3xl" />
      <div className="relative w-full max-w-[380px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">{company.name}</h1>
          {company.gstin && <p className="font-mono text-[11px] text-faint">GSTIN {company.gstin}</p>}
          <p className="mt-1 text-sm text-muted">Who's at the counter?</p>
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
              onChange={(e) => enter(e.target.value)}
              maxLength={max}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              className="absolute h-0 w-0 opacity-0"
            />
            <div className={cn('mb-1 flex justify-center gap-3 py-3', shake && 'animate-[pop_.1s_ease-in-out_3]')} onClick={() => inputRef.current?.focus()}>
              {Array.from({ length: long ? Math.max(4, pin.length) : 4 }).map((_, i) => (
                <span key={i} className={cn('h-3.5 w-3.5 rounded-full border-2 transition-all', i < pin.length ? 'scale-110 border-primary bg-primary' : 'border-border')} />
              ))}
            </div>
            <p className="mb-3 h-5 text-center text-xs text-bad">{error}</p>
            {long && <p className="-mt-2 mb-2 text-center text-[11px] text-muted">Type your old PIN and press Unlock. You'll then choose a 4-digit PIN.</p>}
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
        <button className="mt-3 block w-full text-center text-[11px] text-faint hover:text-muted" onClick={() => (setLong(!long), setPin(''), setError(''), inputRef.current?.focus())} data-testid="pin-long">
          {long ? 'Back to 4-digit PIN' : 'My PIN has more than 4 digits'}
        </button>
        <div className="mt-3 flex items-center justify-between text-xs text-faint">
          <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> Your data stays on this computer</span>
          <button className="flex items-center gap-1 font-medium text-muted hover:text-primary" onClick={() => void (enterpriseCount > 1 ? db.closeEnterprise() : db.createEnterprise())} data-testid="lock-switch">
            <Building2 className="h-3.5 w-3.5" /> {enterpriseCount > 1 ? 'Switch enterprise' : 'Add another enterprise'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Key({ children, onClick, ...rest }: { children: React.ReactNode; onClick: () => void; 'aria-label'?: string }) {
  return (
    <button type="button" onClick={onClick} className="grid h-14 place-items-center rounded-xl bg-surface-2 text-lg font-medium transition hover:bg-border/70 active:scale-95" {...rest}>
      {children}
    </button>
  );
}

/** Shown once after signing in with an old longer PIN: choose the new 4-digit PIN. */
export function ChangePinScreen({ name }: { name: string }) {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [error, setError] = useState('');
  const save = async () => {
    if (!/^\d{4}$/.test(p1)) return setError('PIN must be exactly 4 digits.');
    if (p1 !== p2) return setError('The two PINs do not match.');
    try {
      const s = await call('auth.changePin', { pin: p1 });
      useUi.getState().setSession(s);
      await queryClient.invalidateQueries();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const box = (v: string, set: (s: string) => void, id: string, auto = false) => (
    <input autoFocus={auto} type="password" inputMode="numeric" maxLength={4} value={v} onChange={(e) => (setError(''), set(e.target.value.replace(/\D/g, '').slice(0, 4)))}
      className="input h-12 text-center text-2xl tracking-[0.6em]" data-testid={id} />
  );
  return (
    <div className="grid h-full place-items-center bg-bg p-6">
      <form className="card w-full max-w-[360px] space-y-3 p-6" onSubmit={(e) => (e.preventDefault(), void save())}>
        <h1 className="text-lg font-semibold">New 4-digit PIN for {name}</h1>
        <p className="text-sm text-muted">Hisaab now uses 4-digit PINs everywhere. Choose yours — you'll unlock with it from now on.</p>
        {box(p1, setP1, 'newpin-1', true)}
        {box(p2, setP2, 'newpin-2')}
        <p className="h-4 text-xs text-bad">{error}</p>
        <button type="submit" className="h-11 w-full rounded-xl bg-primary text-sm font-semibold text-primary-fg" data-testid="newpin-save">Save PIN</button>
      </form>
    </div>
  );
}
