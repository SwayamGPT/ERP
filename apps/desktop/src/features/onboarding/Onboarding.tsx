import { STATES, validateGstin } from '@hisaab/core';
import { ArrowLeft, ArrowRight, Check, Database, Sparkles, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, MoneyInput, Select, Switch, toast } from '../../components/ui';
import { call, db, queryClient } from '../../db/client';
import { TEMPLATES, type Template } from '../../db/templates';
import { cn } from '../../lib/cn';
import { useUi } from '../../lib/store';

const STEPS = ['Your business', 'Type of shop', 'Owner PIN'];

export function Onboarding() {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: '',
    gstin: '',
    stateCode: '27',
    phone: '',
    city: '',
    address: '',
    pincode: '',
    upiId: '',
    template: 'kirana' as Template,
    ownerName: '',
    ownerPin: '',
    pin2: '',
    loadSample: true,
    openingCash: 0,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const gstinErr = f.gstin && !validateGstin(f.gstin) ? 'This GSTIN does not look right — check the 15 characters.' : null;
  const fileRef = useRef<HTMLInputElement>(null);

  const canNext = [
    f.name.trim().length > 1 && !gstinErr,
    true,
    f.ownerName.trim().length > 0 && /^\d{4,6}$/.test(f.ownerPin) && f.ownerPin === f.pin2,
  ][step];

  const finish = async () => {
    setBusy(true);
    try {
      const s = await call('company.setup', {
        name: f.name,
        gstin: f.gstin || null,
        stateCode: f.gstin ? f.gstin.slice(0, 2) : f.stateCode,
        phone: f.phone,
        city: f.city,
        address: f.address,
        pincode: f.pincode,
        upiId: f.upiId,
        template: f.template,
        ownerName: f.ownerName,
        ownerPin: f.ownerPin,
        loadSample: f.loadSample,
        openingCash: f.openingCash,
      });
      useUi.getState().setSession(s);
      await db.flush();
      await queryClient.invalidateQueries();
      toast.success(`Welcome to Hisaab, ${s.name}!`, f.loadSample ? 'Sample items, customers and a month of bills are loaded so you can explore.' : undefined);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File) => {
    try {
      await db.importBytes(await file.arrayBuffer());
      toast.success('Backup restored. Unlock with your PIN.');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <aside className="relative hidden overflow-hidden bg-primary p-10 text-primary-fg lg:flex lg:flex-col">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-saffron/30 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <Logo className="h-10 w-10 [&_rect]:fill-white/15" />
          <span className="text-xl font-semibold tracking-tight">Hisaab</span>
        </div>
        <div className="relative mt-auto max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">Billing, stock & GST that just works.</h1>
          <p className="mt-4 text-base text-white/80">Fast counter billing that never stops when the internet does. Udhaar, schemes, batches and GST returns — in plain language.</p>
          <ul className="mt-8 space-y-3 text-sm text-white/90">
            {['Bill in seconds — scan, Enter, F9', 'Works fully offline on this PC', 'CGST / SGST / IGST done for you', 'GSTR-1 & 3B JSON in one click'].map((t) => (
              <li key={t} className="flex items-center gap-2.5">
                <span className="grid h-5 w-5 place-items-center rounded-full bg-white/20"><Check className="h-3 w-3" /></span>
                {t}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative mt-10 text-xs text-white/60">Setup takes under 2 minutes.</p>
      </aside>

      <main className="flex flex-col p-6 sm:p-10">
        <div className="mb-8 flex items-center gap-2">
          {STEPS.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <span className={cn('grid h-6 w-6 place-items-center rounded-full text-xs font-semibold', i < step ? 'bg-good text-white' : i === step ? 'bg-primary text-primary-fg' : 'bg-surface-2 text-muted')}>
                {i < step ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cn('text-sm', i === step ? 'font-medium' : 'text-muted')}>{s}</span>
              {i < STEPS.length - 1 && <span className="mx-2 h-px w-8 bg-border" />}
            </div>
          ))}
        </div>

        <div className="mx-auto w-full max-w-xl flex-1 animate-slide-up" key={step}>
          {step === 0 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Tell us about your shop</h2>
                <p className="mt-1 text-sm text-muted">This appears on your bills. You can change it any time in Settings.</p>
              </div>
              <Field label="Shop / business name *">
                <Input className="input-lg" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sharma General Store" data-testid="ob-name" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="GSTIN" hint="Leave empty if you are not GST registered" error={gstinErr}>
                  <Input value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase().slice(0, 15))} placeholder="27ABCDE1234F1Z5" className="font-mono" />
                </Field>
                <Field label="State" hint={f.gstin ? 'Taken from your GSTIN' : 'Decides CGST+SGST vs IGST'}>
                  <Select value={f.gstin && validateGstin(f.gstin) ? f.gstin.slice(0, 2) : f.stateCode} disabled={!!f.gstin && validateGstin(f.gstin)} onChange={(e) => set('stateCode', e.target.value)}>
                    {Object.entries(STATES).map(([c, n]) => (
                      <option key={c} value={c}>{c} · {n}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Mobile">
                  <Input value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="98XXXXXXXX" inputMode="tel" />
                </Field>
                <Field label="UPI ID" hint="Shows a QR with the exact bill amount">
                  <Input value={f.upiId} onChange={(e) => set('upiId', e.target.value.trim())} placeholder="shopname@okaxis" />
                </Field>
                <Field label="City">
                  <Input value={f.city} onChange={(e) => set('city', e.target.value)} />
                </Field>
                <Field label="PIN code">
                  <Input value={f.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" />
                </Field>
              </div>
              <Field label="Address">
                <Input value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Shop no., street, area" />
              </Field>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">What kind of business is it?</h2>
                <p className="mt-1 text-sm text-muted">We'll set sensible defaults — units, price levels, print format — so you don't have to.</p>
              </div>
              <div className="grid gap-3">
                {(Object.keys(TEMPLATES) as Template[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => set('template', t)}
                    data-testid={`tpl-${t}`}
                    className={cn('flex items-center gap-4 rounded-xl border-2 p-4 text-left transition-all', f.template === t ? 'border-primary bg-primary-soft/60' : 'border-border hover:border-primary/40')}
                  >
                    <span className="text-3xl">{TEMPLATES[t].emoji}</span>
                    <span className="flex-1">
                      <span className="block font-semibold">{TEMPLATES[t].label}</span>
                      <span className="block text-sm text-muted">{TEMPLATES[t].hint}</span>
                    </span>
                    <span className={cn('grid h-5 w-5 place-items-center rounded-full border-2', f.template === t ? 'border-primary bg-primary text-white' : 'border-border')}>{f.template === t && <Check className="h-3 w-3" />}</span>
                  </button>
                ))}
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <Switch checked={f.loadSample} onChange={(v) => set('loadSample', v)} label="Load sample items, customers & a month of bills" hint="Best way to explore. You can erase sample data later in Settings → Backup." />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">Set the owner PIN</h2>
                <p className="mt-1 text-sm text-muted">The owner sees everything — profit, purchase rates, reports. You can add cashiers with limited access later.</p>
              </div>
              <Field label="Your name *">
                <Input className="input-lg" autoFocus value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} placeholder="e.g. Rakesh" data-testid="ob-owner" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="PIN (4–6 digits) *">
                  <Input type="password" inputMode="numeric" value={f.ownerPin} onChange={(e) => set('ownerPin', e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="ob-pin" />
                </Field>
                <Field label="Confirm PIN *" error={f.pin2 && f.pin2 !== f.ownerPin ? 'PINs do not match' : null}>
                  <Input type="password" inputMode="numeric" value={f.pin2} onChange={(e) => set('pin2', e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="ob-pin2" />
                </Field>
              </div>
              <Field label="Cash in the drawer right now" hint="Optional — starts your cash book">
                <MoneyInput value={f.openingCash} onChange={(v) => set('openingCash', v)} />
              </Field>
            </div>
          )}
        </div>

        <div className="mx-auto mt-8 flex w-full max-w-xl items-center justify-between">
          {step > 0 ? (
            <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep(step - 1)}>
              Back
            </Button>
          ) : (
            <button className="flex items-center gap-1.5 text-sm text-muted hover:text-ink" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Restore a backup
            </button>
          )}
          {step < 2 ? (
            <Button variant="primary" size="lg" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="ob-next">
              Continue <ArrowRight className="h-4 w-4" />
            </Button>
          ) : (
            <Button variant="primary" size="lg" disabled={!canNext} loading={busy} onClick={finish} icon={f.loadSample ? <Sparkles className="h-4 w-4" /> : <Database className="h-4 w-4" />} data-testid="ob-finish">
              {busy && f.loadSample ? 'Setting up sample shop…' : 'Start billing'}
            </Button>
          )}
        </div>
        <input ref={fileRef} type="file" accept=".hisaab,.sqlite,.db" className="hidden" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
      </main>
    </div>
  );
}
