import { formatINR, isPan, panFromGstin, PRICE_TIERS, STATES, validateGstin, type PriceTier } from '@hisaab/core';
import { useEffect, useState } from 'react';
import { Button, Field, Input, MoneyInput, Segmented, Select } from '../../components/ui';
import type { Party } from '../../db/types';
import { useAction, useApi } from '../../lib/useApi';

export function PartyForm({ initial, kind = 'customer', onSaved, onCancel, compact }: { initial?: Partial<Party> & { name?: string }; kind?: 'customer' | 'supplier'; onSaved: (id: number) => void; onCancel?: () => void; compact?: boolean }) {
  const company = useApi('app.status').data?.company;
  const [f, setF] = useState({
    kind: (initial?.kind ?? kind) as 'customer' | 'supplier',
    name: initial?.name ?? '',
    phone: initial?.phone ?? '',
    gstin: initial?.gstin ?? '',
    pan: initial?.pan ?? '',
    state_code: initial?.state_code ?? company?.state_code ?? '27',
    address: initial?.address ?? '',
    city: initial?.city ?? '',
    pincode: initial?.pincode ?? '',
    price_tier: (initial?.price_tier ?? 'retail') as PriceTier,
    credit_limit: initial?.credit_limit ?? 0,
    credit_days: initial?.credit_days ?? 0,
    opening_balance: 0,
  });
  useEffect(() => {
    if (initial?.name && !f.name) setF((s) => ({ ...s, name: initial.name! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial?.name]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useAction('parties.save', { success: () => (initial?.id ? 'Saved' : `${f.name} added`), onSuccess: onSaved });
  const gstErr = f.gstin && !validateGstin(f.gstin) ? 'GSTIN looks wrong' : null;
  const panErr = f.pan && !isPan(f.pan) ? 'PAN is 10 characters, like ABCDE1234F' : null;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate({ ...f, id: initial?.id, gstin: f.gstin || null, pan: f.pan || null, opening_balance: f.kind === 'supplier' ? -f.opening_balance : f.opening_balance });
      }}
    >
      {!initial?.id && !compact && (
        <Segmented value={f.kind} onChange={(v) => set('kind', v)} options={[{ value: 'customer', label: 'Customer' }, { value: 'supplier', label: 'Supplier' }]} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name *" className="sm:col-span-2">
          <Input autoFocus value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={f.kind === 'customer' ? 'e.g. Sharma Ji' : 'e.g. Mahalaxmi Distributors'} data-testid="party-name" />
        </Field>
        <Field label="Mobile (for WhatsApp)">
          <Input value={f.phone} onChange={(e) => set('phone', e.target.value.replace(/[^\d+ ]/g, ''))} inputMode="tel" placeholder="98XXXXXXXX" data-testid="party-phone" />
        </Field>
        <Field label="GSTIN" error={gstErr} hint="For B2B bills">
          <Input value={f.gstin} onChange={(e) => {
            const g = e.target.value.toUpperCase().slice(0, 15);
            setF((s) => ({ ...s, gstin: g, pan: validateGstin(g) && !s.pan ? panFromGstin(g) : s.pan }));
          }} className="font-mono" data-testid="party-gstin" />
        </Field>
        <Field label="PAN" error={panErr} hint={company?.kyc_limit ? `Needed on bills of ${formatINR(company.kyc_limit, { decimals: false })} or more (or a GSTIN)` : 'Income-tax PAN'}>
          <Input value={f.pan} onChange={(e) => set('pan', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))} className="font-mono" placeholder="ABCDE1234F" data-testid="party-pan" />
        </Field>
        {!compact && (
          <>
            <Field label="State" hint={f.gstin && !gstErr ? 'From GSTIN' : 'Other state → IGST'}>
              <Select value={f.gstin && !gstErr ? f.gstin.slice(0, 2) : f.state_code} disabled={!!f.gstin && !gstErr} onChange={(e) => set('state_code', e.target.value)}>
                {Object.entries(STATES).map(([c, n]) => (
                  <option key={c} value={c}>{c} · {n}</option>
                ))}
              </Select>
            </Field>
            <Field label="City">
              <Input value={f.city} onChange={(e) => set('city', e.target.value)} data-testid="party-city" />
            </Field>
            <Field label="PIN code" hint="Needed for e-invoices and e-Way Bills">
              <Input inputMode="numeric" value={f.pincode} onChange={(e) => set('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} data-testid="party-pincode" />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Input value={f.address} onChange={(e) => set('address', e.target.value)} data-testid="party-address" />
            </Field>
          </>
        )}
        {f.kind === 'customer' && (
          <>
            <Field label="Price level" hint="Rates auto-apply on bills">
              <Select value={f.price_tier} onChange={(e) => set('price_tier', e.target.value as PriceTier)} data-testid="party-tier">
                {PRICE_TIERS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Credit (udhaar) limit" hint="0 = no limit">
              <MoneyInput value={f.credit_limit} onChange={(v) => set('credit_limit', v)} />
            </Field>
          </>
        )}
        {!initial?.id && !compact && (
          <Field label={f.kind === 'customer' ? 'Old dues (they owe you)' : 'Old dues (you owe them)'} hint="Opening balance">
            <MoneyInput value={f.opening_balance} onChange={(v) => set('opening_balance', v)} />
          </Field>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-2">
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.name.trim() || !!gstErr || !!panErr} data-testid="party-save">
          {initial?.id ? 'Save changes' : f.kind === 'customer' ? 'Add customer' : 'Add supplier'}
        </Button>
      </div>
    </form>
  );
}
