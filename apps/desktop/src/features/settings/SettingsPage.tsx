import { panFromGstin, ROLE_LABELS, STATES, validateEnterprise, type Role } from '@hisaab/core';
import { Building2, Database, Download, FileBadge, HeartPulse, Landmark, Plus, Settings, ShieldCheck, Store, Trash2, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, Dialog, Field, Input, Loading, PageHeader, Segmented, Select, Switch, Tabs, toast } from '../../components/ui';
import { db } from '../../db/client';
import type { Company } from '../../db/types';
import { BUSINESS_TYPES } from '../../db/templates';
import type { BusinessType } from '../../db/repos/company';
import { PrintSetup } from './PrintSetup';
import { Hardware } from './Hardware';
import { CloudSettings } from '../cloud/CloudSettings';
import { SalesSettings } from './SalesSettings';
import { downloadBlob } from '../../lib/download';
import { fmtDate, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useUi } from '../../lib/store';
import { useAction, useApi } from '../../lib/useApi';

type Tab = 'business' | 'print' | 'billing' | 'sales' | 'users' | 'cloud' | 'backup';

export function SettingsPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'business';
  const company = useApi('app.status').data?.company;
  if (!company) return <Loading />;
  const tabs = [
    { value: 'business' as const, label: 'Business', show: canDo('settings.edit') },
    { value: 'print' as const, label: 'Print setup', show: canDo('settings.edit') },
    { value: 'billing' as const, label: 'Billing rules', show: canDo('settings.edit') },
    { value: 'sales' as const, label: 'Loyalty, coupons & prices', show: canDo('settings.edit') },
    { value: 'users' as const, label: 'Users & PINs', show: canDo('users.manage') },
    { value: 'cloud' as const, label: 'Cloud & devices', show: canDo('backup.manage') },
    { value: 'backup' as const, label: 'Backup & data', show: canDo('backup.manage') },
  ].filter((t) => t.show);
  return (
    <div className="animate-slide-up">
      <PageHeader icon={<Settings className="h-5 w-5" />} title="Settings" />
      <div className="mb-5"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} /></div>
      {tab === 'print' && (
        <>
          <PrintSetup company={company} />
          <div className="mt-5 max-w-3xl"><Hardware /></div>
        </>
      )}
      <div className="max-w-3xl">
        {tab === 'business' && <Business c={company} />}
        {tab === 'billing' && <Billing c={company} />}
        {tab === 'users' && <UsersTab />}
        {tab === 'sales' && <SalesSettings c={company} />}
        {tab === 'cloud' && <CloudSettings />}
        {tab === 'backup' && <Backup />}
      </div>
    </div>
  );
}

function useForm(c: Company) {
  const [f, setF] = useState<Partial<Company>>(c);
  useEffect(() => setF(c), [c]);
  const save = useAction('company.save', { success: 'Settings saved' });
  return { f, set: <K extends keyof Company>(k: K, v: Company[K]) => setF((s) => ({ ...s, [k]: v })), save };
}

function Business({ c }: { c: Company }) {
  const { f, set, save } = useForm(c);
  const e = validateEnterprise({
    name: f.name, businessType: f.template, gstin: f.gstin ?? '', fssai: f.fssai ?? '', fssaiExpiry: f.fssai_expiry, phone: f.phone ?? '', email: f.email ?? '',
    address: f.address ?? '', city: f.city ?? '', pincode: f.pincode ?? '', stateCode: f.state_code, bankIfsc: f.bank_ifsc, bankAccount: f.bank_account,
  });
  const valid = Object.keys(e).length === 0;
  const txt = (k: keyof Company) => (f[k] as string | null) ?? '';
  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Store className="h-4 w-4" /> Business & contact</span>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Shop / business name *" error={e.name} className="sm:col-span-2"><Input value={txt('name')} onChange={(x) => set('name', x.target.value)} /></Field>
          <Field label="Type of business *" error={e.businessType}>
            <Select value={f.template ?? ''} onChange={(x) => set('template', x.target.value)}>
              {(Object.keys(BUSINESS_TYPES) as BusinessType[]).map((t) => <option key={t} value={t}>{BUSINESS_TYPES[t].label}</option>)}
            </Select>
          </Field>
          <Field label="Tagline on bills"><Input value={txt('tagline')} onChange={(x) => set('tagline', x.target.value || null)} /></Field>
          <Field label="Contact number *" error={e.phone}><Input value={txt('phone')} onChange={(x) => set('phone', x.target.value)} inputMode="tel" /></Field>
          <Field label="Email *" error={e.email}><Input type="email" value={txt('email')} onChange={(x) => set('email', x.target.value.trim())} data-testid="set-email" /></Field>
          <Field label="Address *" error={e.address} className="sm:col-span-2"><Input value={txt('address')} onChange={(x) => set('address', x.target.value)} /></Field>
          <Field label="City *" error={e.city}><Input value={txt('city')} onChange={(x) => set('city', x.target.value)} /></Field>
          <Field label="PIN code *" error={e.pincode}><Input value={txt('pincode')} onChange={(x) => set('pincode', x.target.value.replace(/\D/g, '').slice(0, 6))} /></Field>
        </div>
      </Card>
      <Card title={<span className="flex items-center gap-2"><FileBadge className="h-4 w-4" /> GST & licences</span>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="GSTIN *" error={e.gstin} hint={!e.gstin && f.gstin ? `${STATES[f.gstin.slice(0, 2)]} · PAN ${panFromGstin(f.gstin)}` : undefined}>
            <Input className="font-mono" value={txt('gstin')} onChange={(x) => set('gstin', x.target.value.toUpperCase().slice(0, 15))} />
          </Field>
          <Field label="Legal name"><Input value={txt('legal_name')} onChange={(x) => set('legal_name', x.target.value || null)} /></Field>
          <Field label="FSSAI licence no. *" error={e.fssai}><Input className="font-mono" value={txt('fssai')} onChange={(x) => set('fssai', x.target.value.replace(/\D/g, '').slice(0, 14))} data-testid="set-fssai" /></Field>
          <Field label="FSSAI valid until" error={e.fssaiExpiry}><Input type="date" value={txt('fssai_expiry')} onChange={(x) => set('fssai_expiry', x.target.value || null)} /></Field>
        </div>
      </Card>
      <Card title={<span className="flex items-center gap-2"><Landmark className="h-4 w-4" /> Payments</span>}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="UPI ID" hint="QR with the exact amount on screen and bills"><Input value={txt('upi_id')} onChange={(x) => set('upi_id', x.target.value.trim() || null)} placeholder="shop@okhdfcbank" data-testid="set-upi" /></Field>
          <Field label="Bank name"><Input value={txt('bank_name')} onChange={(x) => set('bank_name', x.target.value || null)} /></Field>
          <Field label="Account number" error={e.bankAccount}><Input value={txt('bank_account')} onChange={(x) => set('bank_account', x.target.value.replace(/\D/g, '') || null)} /></Field>
          <Field label="IFSC" error={e.bankIfsc}><Input className="font-mono" value={txt('bank_ifsc')} onChange={(x) => set('bank_ifsc', x.target.value.toUpperCase() || null)} /></Field>
          <Field label="Branch" className="sm:col-span-2"><Input value={txt('bank_branch')} onChange={(x) => set('bank_branch', x.target.value || null)} /></Field>
        </div>
      </Card>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate(f)} data-testid="set-save">Save details</Button></div>
    </div>
  );
}

function Billing({ c }: { c: Company }) {
  const { f, set, save } = useForm(c);
  return (
    <div className="space-y-4">
      <Card title="Numbering & rules">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Invoice prefix"><Input value={f.invoice_prefix ?? ''} onChange={(e) => set('invoice_prefix', e.target.value)} /></Field>
          <Field label="Next invoice no." hint="Change only at the start of a financial year"><Input inputMode="numeric" value={f.next_invoice_no ?? 1} onChange={(e) => set('next_invoice_no', Number(e.target.value) || 1)} /></Field>
          <Field label="Credit note prefix"><Input value={f.return_prefix ?? ''} onChange={(e) => set('return_prefix', e.target.value)} /></Field>
        </div>
        <div className="mt-5 space-y-4">
          <Switch checked={!!f.round_off} onChange={(v) => set('round_off', v ? 1 : 0)} label="Round bills to the nearest rupee" hint="Shown as a separate Round off line" />
          <Switch checked={f.billing_staff_mode === 'optional'} onChange={(v) => set('billing_staff_mode', v ? 'optional' : 'off')} label="Ask who served the customer" hint="Adds an optional “Served by” on the billing screen — for sales-by-staff reports and incentives." />
          <Switch checked={!!f.allow_negative_stock} onChange={(v) => set('allow_negative_stock', v ? 1 : 0)} label="Allow billing when stock shows zero" hint="Recommended — counters shouldn't stop because stock wasn't entered" />
          <Field label="Weighing-scale barcode contains">
            <Segmented value={f.weight_barcode_mode ?? 'weight'} onChange={(v) => set('weight_barcode_mode', v)} options={[{ value: 'weight', label: 'Weight in grams' }, { value: 'price', label: 'Price in paise' }]} />
          </Field>
        </div>
      </Card>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(f)} data-testid="billing-save">Save</Button></div>
    </div>
  );
}

function UsersTab() {
  const list = useApi('users.list');
  const me = useUi((s) => s.session);
  const [edit, setEdit] = useState<null | { id?: number; name: string; role: Role; pin: string; active: boolean }>(null);
  const save = useAction('users.save', { success: 'User saved', onSuccess: () => setEdit(null) });
  return (
    <Card title={<span className="flex items-center gap-2"><Users className="h-4 w-4" /> Users</span>} action={<Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', role: 'cashier', pin: '', active: true })}>Add user</Button>} padded={false}>
      <table className="table-base">
        <thead><tr><th>Name</th><th>Role</th><th>Can do</th><th /></tr></thead>
        <tbody>
          {list.data?.map((u) => (
            <tr key={u.id}>
              <td className="font-medium">{u.name} {u.id === me?.userId && <Badge tone="primary">you</Badge>} {!u.active && <Badge>inactive</Badge>}</td>
              <td className="capitalize">{u.role}</td>
              <td className="text-xs text-muted">{ROLE_LABELS[u.role].description}</td>
              <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit({ id: u.id, name: u.name, role: u.role, pin: '', active: !!u.active })}>Edit</Button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Dialog open onOpenChange={(v) => !v && setEdit(null)} title={edit.id ? 'Edit user' : 'Add user'} footer={<><Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(edit)}>Save</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Role">
              <div className="grid gap-2">
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <label key={r} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${edit.role === r ? 'border-primary bg-primary-soft/50' : 'border-border'}`}>
                    <input type="radio" checked={edit.role === r} onChange={() => setEdit({ ...edit, role: r })} className="mt-1 accent-[rgb(var(--primary))]" />
                    <span><span className="block text-sm font-medium">{ROLE_LABELS[r].label}</span><span className="text-xs text-muted">{ROLE_LABELS[r].description}</span></span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label={edit.id ? 'New PIN (leave empty to keep)' : 'PIN (4–6 digits)'}><Input type="password" inputMode="numeric" value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} /></Field>
            {edit.id && <Switch checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Active" />}
          </div>
        </Dialog>
      )}
    </Card>
  );
}

function Backup() {
  const fileRef = useRef<HTMLInputElement>(null);
  const health = useApi('reports.health');
  const company = useApi('app.status').data?.company;
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [wipe, setWipe] = useState(false);
  const last = (() => { try { return localStorage.getItem('hisaab.lastBackup'); } catch { return null; } })();

  const backup = async () => {
    try {
      const bytes = await db.exportBytes();
      downloadBlob(bytes, `${(company?.name ?? 'hisaab').replace(/[^\w]+/g, '-')}-${today()}.hisaab`);
      try { localStorage.setItem('hisaab.lastBackup', today()); } catch { /* ignore */ }
      toast.success('Backup downloaded', 'Keep it on a pen drive or Google Drive.');
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Database className="h-4 w-4" /> Backup</span>}>
        <p className="mb-4 text-sm text-muted">All your data lives on this computer and saves automatically after every bill. Download a backup file every week, or turn on encrypted cloud backup under Cloud & devices.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Download className="h-4 w-4" />} onClick={backup} data-testid="backup">Download backup</Button>
          <Button variant="outline" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>Restore from file</Button>
        </div>
        <p className="mt-3 text-xs text-faint">{last ? `Last backup: ${fmtDate(last)}` : 'No backup taken yet.'}</p>
        <input ref={fileRef} type="file" accept=".hisaab,.sqlite,.db" className="hidden" onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)} />
      </Card>
      <Card title={<span className="flex items-center gap-2"><HeartPulse className="h-4 w-4" /> Books health</span>}>
        {health.data && (
          <div className="flex items-center gap-3 text-sm">
            {health.data.balanced ? <ShieldCheck className="h-5 w-5 text-good" /> : <Trash2 className="h-5 w-5 text-bad" />}
            <span>{health.data.balanced ? 'All vouchers balance to the paisa.' : `${health.data.unbalanced.length} voucher(s) do not balance.`} {health.data.negativeStockItems > 0 && <Badge tone="warn" className="ml-2">{health.data.negativeStockItems} items with negative stock</Badge>}</span>
          </div>
        )}
      </Card>
      <Card title={<span className="flex items-center gap-2"><Building2 className="h-4 w-4" /> This enterprise</span>}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-muted">Deleting removes <b className="text-ink">{company?.name}</b> and all its bills, items and customers from this computer. Other enterprises are not affected.</p>
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setWipe(true)}>Delete enterprise</Button>
        </div>
      </Card>
      <ConfirmDialog open={!!restoreFile} onOpenChange={(v) => !v && setRestoreFile(null)} title="Restore this backup?" body={`${company?.name} will be replaced with “${restoreFile?.name}”. Other enterprises are not touched. Take a backup first if unsure.`} danger confirmLabel="Restore" onConfirm={async () => { await db.importBytes(await restoreFile!.arrayBuffer(), false); useUi.getState().setSession(null); toast.success('Backup restored. Unlock with your PIN.'); }} />
      <ConfirmDialog open={wipe} onOpenChange={setWipe} title={`Delete ${company?.name}?`} body="Every bill, item and customer of this enterprise will be deleted from this computer. Download a backup first — this cannot be undone." danger confirmLabel="Delete enterprise" onConfirm={async () => { await db.deleteEnterprise(); useUi.getState().setSession(null); }} />
    </div>
  );
}
