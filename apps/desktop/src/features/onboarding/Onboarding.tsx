import { isEmail, isPhone, panFromGstin, STATES, validateEnterprise, validateGstin, type EnterpriseDetails } from '@hisaab/core';
import { ArrowLeft, ArrowRight, Building2, Check, FileBadge, Landmark, Link2, ShieldCheck, Upload, UserRound, X } from 'lucide-react';
import { JoinShop } from '../cloud/JoinShop';
import { useRef, useState } from 'react';
import { Logo } from '../../components/Logo';
import { Button, Field, Input, MoneyInput, toast } from '../../components/ui';
import { call, db, queryClient } from '../../db/client';
import type { BusinessType } from '../../db/repos/company';
import { BUSINESS_TYPES } from '../../db/templates';
import { cn } from '../../lib/cn';
import { useUi } from '../../lib/store';

const STEPS = [
  { title: 'Business & contact', icon: Building2 },
  { title: 'GST & licences', icon: FileBadge },
  { title: 'Owner login', icon: UserRound },
];

type Form = {
  name: string; businessType: BusinessType | ''; phone: string; email: string; address: string; city: string; pincode: string; tagline: string;
  gstin: string; legalName: string; fssai: string; fssaiExpiry: string; upiId: string; bankName: string; bankAccount: string; bankIfsc: string; bankBranch: string;
  ownerName: string; ownerPin: string; pin2: string; openingCash: number;
  existing: '' | 'new' | 'existing';
};

const STEP_FIELDS: Array<Array<keyof EnterpriseDetails>> = [
  ['name', 'businessType', 'phone', 'email', 'address', 'city', 'pincode'],
  ['gstin', 'fssai', 'fssaiExpiry', 'bankIfsc', 'bankAccount'],
  [],
];

/** Create a new enterprise. `onCancel` is offered when other enterprises already exist. */
export function Onboarding({ onCancel }: { onCancel?: () => void }) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [join, setJoin] = useState(false);
  const [showErrors, setShowErrors] = useState<Record<number, boolean>>({});
  const [f, setF] = useState<Form>({
    name: '', businessType: '', phone: '', email: '', address: '', city: '', pincode: '', tagline: '',
    gstin: '', legalName: '', fssai: '', fssaiExpiry: '', upiId: '', bankName: '', bankAccount: '', bankIfsc: '', bankBranch: '',
    ownerName: '', ownerPin: '', pin2: '', openingCash: 0, existing: '',
  });
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((s) => ({ ...s, [k]: v }));
  const fileRef = useRef<HTMLInputElement>(null);

  const errors = validateEnterprise({ ...f, stateCode: f.gstin.slice(0, 2) || undefined, businessType: f.businessType || undefined, bankIfsc: f.bankIfsc || null, bankAccount: f.bankAccount || null, fssaiExpiry: f.fssaiExpiry || null });
  const ownerErrors = {
    ownerName: !f.ownerName.trim() ? "Enter the owner's name" : undefined,
    ownerPin: !/^\d{4}$/.test(f.ownerPin) ? 'PIN must be exactly 4 digits' : undefined,
    pin2: f.pin2 !== f.ownerPin ? 'PINs do not match' : undefined,
    existing: !f.existing ? 'Tell us if the shop is already running' : undefined,
  };
  const stepValid = (i: number) => (i === 2 ? !Object.values(ownerErrors).some(Boolean) : STEP_FIELDS[i].every((k) => !errors[k]));
  const err = (k: keyof EnterpriseDetails) => (showErrors[step] ? errors[k] : undefined);
  const oerr = (k: keyof typeof ownerErrors) => (showErrors[step] ? ownerErrors[k] : undefined);
  const gstValid = validateGstin(f.gstin);

  const next = () => {
    if (!stepValid(step)) {
      setShowErrors((s) => ({ ...s, [step]: true }));
      toast.error(new Error('Please fill the highlighted details.'));
      return;
    }
    if (step < 2) setStep(step + 1);
    else void finish();
  };

  const finish = async () => {
    setBusy(true);
    try {
      const s = await call('company.setup', {
        name: f.name, businessType: f.businessType as BusinessType, phone: f.phone, email: f.email, address: f.address, city: f.city, pincode: f.pincode,
        tagline: f.tagline, gstin: f.gstin, legalName: f.legalName, fssai: f.fssai, fssaiExpiry: f.fssaiExpiry || null, upiId: f.upiId,
        bankName: f.bankName, bankAccount: f.bankAccount, bankIfsc: f.bankIfsc, bankBranch: f.bankBranch,
        ownerName: f.ownerName, ownerPin: f.ownerPin, openingCash: f.openingCash,
      });
      // An existing shop goes straight to bringing in its items, stock and customers.
      if (f.existing === 'existing') window.location.hash = '#/welcome';
      useUi.getState().setSession(s);
      await db.flush();
      await queryClient.invalidateQueries();
      toast.success(`${f.name} is ready`, 'Add your items next, then make your first bill.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (file: File) => {
    try {
      await db.importBytes(await file.arrayBuffer(), true);
      toast.success('Backup restored', 'Unlock with your PIN.');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
      <aside className="relative hidden overflow-hidden bg-primary p-10 text-primary-fg lg:flex lg:flex-col">
        <div className="absolute -right-24 -top-24 h-80 w-80 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-saffron/30 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <Logo className="h-10 w-10 [&_rect]:fill-white/15" />
          <span className="text-xl font-semibold tracking-tight">Hisaab</span>
        </div>
        <div className="relative mt-16 space-y-2">
          {STEPS.map((s, i) => (
            <div key={s.title} className={cn('flex items-center gap-3 rounded-xl px-3 py-2.5 transition', i === step ? 'bg-white/15' : 'opacity-70')}>
              <span className={cn('grid h-8 w-8 place-items-center rounded-lg', i < step ? 'bg-good text-white' : 'bg-white/15')}>{i < step ? <Check className="h-4 w-4" /> : <s.icon className="h-4 w-4" />}</span>
              <span className="text-sm font-medium">{s.title}</span>
            </div>
          ))}
        </div>
        <div className="relative mt-auto max-w-sm">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight">Set up your enterprise once. Bill in seconds forever.</h1>
          <p className="mt-3 text-sm text-white/80">Your GSTIN, contact details and (for food shops) FSSAI licence print on every bill exactly as the law and your customers expect.</p>
          <p className="mt-8 flex items-center gap-2 text-xs text-white/70"><ShieldCheck className="h-4 w-4" /> Everything is stored on this computer. Cloud sync is optional.</p>
        </div>
      </aside>

      <main className="flex flex-col p-6 sm:p-10">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">Step {step + 1} of 3</p>
            <h2 className="text-2xl font-semibold tracking-tight">{['Tell us about your business', 'GST, FSSAI & payments', 'Who owns this business?'][step]}</h2>
          </div>
          {onCancel && (
            <Button variant="ghost" icon={<X className="h-4 w-4" />} onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>

        <div className="w-full max-w-3xl flex-1 animate-slide-up" key={step}>
          {step === 0 && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Business / shop name *" error={err('name')} className="sm:col-span-2">
                  <Input className="input-lg" autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Sharma General Store" data-testid="ob-name" />
                </Field>
              </div>
              <div>
                <span className="label">Type of business *</span>
                <div className="grid gap-2 sm:grid-cols-3">
                  {(Object.keys(BUSINESS_TYPES) as BusinessType[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => set('businessType', t)}
                      data-testid={`type-${t}`}
                      className={cn('flex items-start gap-2.5 rounded-xl border-2 p-3 text-left transition', f.businessType === t ? 'border-primary bg-primary-soft/60' : 'border-border hover:border-primary/40')}
                    >
                      <span className="text-xl leading-none">{BUSINESS_TYPES[t].emoji}</span>
                      <span>
                        <span className="block text-sm font-semibold leading-tight">{BUSINESS_TYPES[t].label}</span>
                        <span className="mt-0.5 block text-[11px] leading-snug text-muted">{BUSINESS_TYPES[t].hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {err('businessType') && <p className="mt-1 text-xs text-bad">{err('businessType')}</p>}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Contact number *" error={err('phone')} hint={f.phone && isPhone(f.phone) ? 'Printed on bills; used for WhatsApp' : 'Mobile or landline with STD code'}>
                  <Input value={f.phone} onChange={(e) => set('phone', e.target.value.replace(/[^\d+ ]/g, '').slice(0, 15))} inputMode="tel" placeholder="98XXXXXXXX" data-testid="ob-phone" />
                </Field>
                <Field label="Email *" error={err('email')} hint={f.email && isEmail(f.email) ? undefined : 'For invoices and backups'}>
                  <Input type="email" value={f.email} onChange={(e) => set('email', e.target.value.trim())} placeholder="accounts@yourshop.in" data-testid="ob-email" />
                </Field>
                <Field label="Shop address *" error={err('address')} className="sm:col-span-2">
                  <Input value={f.address} onChange={(e) => set('address', e.target.value)} placeholder="Shop no., building, street, area" data-testid="ob-address" />
                </Field>
                <Field label="City / town *" error={err('city')}>
                  <Input value={f.city} onChange={(e) => set('city', e.target.value)} data-testid="ob-city" />
                </Field>
                <Field label="PIN code *" error={err('pincode')}>
                  <Input value={f.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" data-testid="ob-pincode" />
                </Field>
                <Field label="Tagline on bills" hint="Optional, e.g. 'Fresh groceries since 1998'" className="sm:col-span-2">
                  <Input value={f.tagline} onChange={(e) => set('tagline', e.target.value)} />
                </Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6">
              <section className="grid gap-4 sm:grid-cols-2">
                <Field label="GSTIN *" error={err('gstin')} hint={gstValid ? `State ${f.gstin.slice(0, 2)} · ${STATES[f.gstin.slice(0, 2)] ?? '—'} · PAN ${panFromGstin(f.gstin)}` : '15 characters, e.g. 27ABCDE1234F1Z5'}>
                  <Input autoFocus value={f.gstin} onChange={(e) => set('gstin', e.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15))} className="font-mono" placeholder="27ABCDE1234F1Z5" data-testid="ob-gstin" />
                </Field>
                <Field label="Legal name (as on GST certificate)" hint="Leave empty if same as the shop name">
                  <Input value={f.legalName} onChange={(e) => set('legalName', e.target.value)} />
                </Field>
                <Field label="FSSAI licence / registration no. (optional)" error={err('fssai')} hint="Only if you sell food items · 14 digits, printed on bills">
                  <Input value={f.fssai} onChange={(e) => set('fssai', e.target.value.replace(/\D/g, '').slice(0, 14))} inputMode="numeric" className="font-mono" placeholder="11523999000123" data-testid="ob-fssai" />
                </Field>
                <Field label="FSSAI valid until" error={err('fssaiExpiry')} hint="We'll remind you 60 days before renewal">
                  <Input type="date" value={f.fssaiExpiry} onChange={(e) => set('fssaiExpiry', e.target.value)} />
                </Field>
              </section>
              <section className="rounded-xl border border-border p-4">
                <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Landmark className="h-4 w-4 text-primary" /> Payment details <span className="font-normal text-muted">— optional, shown on bills</span></h3>
                <p className="mb-3 text-xs text-muted">UPI shows a QR with the exact bill amount. Bank details help wholesale customers pay by NEFT.</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="UPI ID"><Input value={f.upiId} onChange={(e) => set('upiId', e.target.value.trim())} placeholder="shopname@okaxis" /></Field>
                  <Field label="Bank name"><Input value={f.bankName} onChange={(e) => set('bankName', e.target.value)} placeholder="HDFC Bank" /></Field>
                  <Field label="Account number" error={err('bankAccount')}><Input value={f.bankAccount} onChange={(e) => set('bankAccount', e.target.value.replace(/\D/g, '').slice(0, 18))} inputMode="numeric" /></Field>
                  <Field label="IFSC" error={err('bankIfsc')}><Input value={f.bankIfsc} onChange={(e) => set('bankIfsc', e.target.value.toUpperCase().slice(0, 11))} className="font-mono" placeholder="HDFC0001234" /></Field>
                </div>
              </section>
            </div>
          )}

          {step === 2 && (
            <div className="max-w-xl space-y-4">
              <p className="text-sm text-muted">The owner sees everything — profit, purchase rates and reports — and can add staff with limited access later.</p>
              <Field label="Owner name *" error={oerr('ownerName')}>
                <Input className="input-lg" autoFocus value={f.ownerName} onChange={(e) => set('ownerName', e.target.value)} placeholder="e.g. Rakesh Sharma" data-testid="ob-owner" />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="4-digit PIN *" error={oerr('ownerPin')}>
                  <Input type="password" inputMode="numeric" value={f.ownerPin} onChange={(e) => set('ownerPin', e.target.value.replace(/\D/g, '').slice(0, 4))} data-testid="ob-pin" />
                </Field>
                <Field label="Confirm PIN *" error={oerr('pin2')}>
                  <Input type="password" inputMode="numeric" value={f.pin2} onChange={(e) => set('pin2', e.target.value.replace(/\D/g, '').slice(0, 4))} data-testid="ob-pin2" />
                </Field>
              </div>
              <div>
                <span className="label">Is this shop already running?</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  {([
                    ['existing', 'Yes — bring in my items', 'Import from Marg, Tally, Busy or Excel, or type them in quickly, with opening stock and customer dues.'],
                    ['new', 'No — a new shop', 'Start empty and add items as you go.'],
                  ] as const).map(([v, t, d]) => (
                    <button key={v} type="button" onClick={() => set('existing', v)} data-testid={`ob-${v}`}
                      className={cn('rounded-xl border-2 p-3 text-left transition', f.existing === v ? 'border-primary bg-primary-soft' : 'border-border hover:border-primary/40')}>
                      <span className="block text-sm font-semibold">{t}</span>
                      <span className="block text-xs text-muted">{d}</span>
                    </button>
                  ))}
                </div>
                {oerr('existing') && <p className="mt-1 text-xs text-bad">{oerr('existing')}</p>}
              </div>
              <Field label="Cash in the drawer right now" hint="Optional — starts your cash book">
                <MoneyInput value={f.openingCash} onChange={(v) => set('openingCash', v)} />
              </Field>
              <div className="rounded-xl bg-surface-2 p-4 text-sm">
                <div className="font-semibold">{f.name}</div>
                <div className="text-muted">{[f.address, f.city, f.pincode].filter(Boolean).join(', ')}</div>
                <div className="mt-1 font-mono text-xs text-muted">GSTIN {f.gstin} · FSSAI {f.fssai}</div>
                <div className="text-xs text-muted">{f.phone} · {f.email}</div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 flex w-full max-w-3xl items-center justify-between">
          {step > 0 ? (
            <Button variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStep(step - 1)}>Back</Button>
          ) : (
            <span className="flex flex-wrap items-center gap-4">
              <button className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline" onClick={() => setJoin(true)} data-testid="ob-join">
                <Link2 className="h-4 w-4" /> Join an existing shop
              </button>
              <button className="flex items-center gap-1.5 text-sm text-muted hover:text-ink" onClick={() => fileRef.current?.click()} data-testid="ob-restore">
                <Upload className="h-4 w-4" /> Restore from a backup file
              </button>
            </span>
          )}
          <Button variant="primary" size="lg" loading={busy} onClick={next} data-testid={step < 2 ? 'ob-next' : 'ob-finish'}>
            {step < 2 ? 'Continue' : 'Create enterprise'} <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
        <input ref={fileRef} type="file" accept=".hisaab,.sqlite,.db" className="hidden" data-testid="ob-restore-file" onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
        <JoinShop open={join} onOpenChange={setJoin} phone={typeof window !== 'undefined' && window.innerWidth < 700} />
      </main>
    </div>
  );
}
