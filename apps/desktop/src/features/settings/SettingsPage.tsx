import { ROLE_LABELS, STATES, validateGstin, type Role } from '@hisaab/core';
import { Database, Download, HeartPulse, Plus, Printer, Settings, ShieldCheck, Store, Trash2, Upload, Users } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, ConfirmDialog, Dialog, Field, Input, Loading, PageHeader, Segmented, Select, Switch, Tabs, toast } from '../../components/ui';
import { db } from '../../db/client';
import type { Company } from '../../db/types';
import { TEMPLATES, type Template } from '../../db/templates';
import { downloadBlob } from '../../lib/download';
import { fmtDate, today } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useUi } from '../../lib/store';
import { useAction, useApi } from '../../lib/useApi';

type Tab = 'business' | 'billing' | 'users' | 'backup' | 'audit';

export function SettingsPage() {
  const canDo = useCan();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'business';
  const company = useApi('app.status').data?.company;
  if (!company) return <Loading />;
  const tabs = [
    { value: 'business' as const, label: 'Business', show: canDo('settings.edit') },
    { value: 'billing' as const, label: 'Billing & printing', show: canDo('settings.edit') },
    { value: 'users' as const, label: 'Users & PINs', show: canDo('users.manage') },
    { value: 'backup' as const, label: 'Backup & data', show: canDo('backup.manage') },
    { value: 'audit' as const, label: 'Activity log', show: canDo('users.manage') },
  ].filter((t) => t.show);
  return (
    <div className="animate-slide-up">
      <PageHeader icon={<Settings className="h-5 w-5" />} title="Settings" />
      <div className="mb-5"><Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={tabs} /></div>
      <div className="max-w-3xl">
        {tab === 'business' && <Business c={company} />}
        {tab === 'billing' && <Billing c={company} />}
        {tab === 'users' && <UsersTab />}
        {tab === 'backup' && <Backup />}
        {tab === 'audit' && <Audit />}
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
  const gErr = f.gstin && !validateGstin(f.gstin) ? 'GSTIN looks wrong' : null;
  return (
    <Card title={<span className="flex items-center gap-2"><Store className="h-4 w-4" /> Business details</span>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Shop name" className="sm:col-span-2"><Input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Legal name (if different)"><Input value={f.legal_name ?? ''} onChange={(e) => set('legal_name', e.target.value)} /></Field>
        <Field label="GSTIN" error={gErr}><Input className="font-mono" value={f.gstin ?? ''} onChange={(e) => set('gstin', e.target.value.toUpperCase().slice(0, 15) || null)} /></Field>
        <Field label="State"><Select value={f.gstin && !gErr ? f.gstin.slice(0, 2) : f.state_code} disabled={!!f.gstin && !gErr} onChange={(e) => set('state_code', e.target.value)}>{Object.entries(STATES).map(([k, n]) => <option key={k} value={k}>{k} · {n}</option>)}</Select></Field>
        <Field label="UPI ID" hint="For the payment QR on bills"><Input value={f.upi_id ?? ''} onChange={(e) => set('upi_id', e.target.value.trim() || null)} placeholder="shop@okhdfcbank" data-testid="set-upi" /></Field>
        <Field label="Mobile"><Input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Email"><Input value={f.email ?? ''} onChange={(e) => set('email', e.target.value)} /></Field>
        <Field label="Address" className="sm:col-span-2"><Input value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="City"><Input value={f.city ?? ''} onChange={(e) => set('city', e.target.value)} /></Field>
        <Field label="PIN code"><Input value={f.pincode ?? ''} onChange={(e) => set('pincode', e.target.value)} /></Field>
      </div>
      <div className="mt-5 flex justify-end"><Button variant="primary" loading={save.isPending} disabled={!!gErr} onClick={() => save.mutate(f)} data-testid="set-save">Save</Button></div>
    </Card>
  );
}

function Billing({ c }: { c: Company }) {
  const { f, set, save } = useForm(c);
  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Printer className="h-4 w-4" /> Printing</span>}>
        <div className="space-y-4">
          <Field label="Default print format">
            <Segmented value={f.print_format ?? 'thermal80'} onChange={(v) => set('print_format', v)} options={[{ value: 'thermal80', label: '3-inch thermal (80mm)' }, { value: 'thermal58', label: '2-inch thermal (58mm)' }, { value: 'a4', label: 'A4 tax invoice' }]} />
          </Field>
          <Field label="Footer message"><Input value={f.print_footer ?? ''} onChange={(e) => set('print_footer', e.target.value)} /></Field>
        </div>
      </Card>
      <Card title="Numbering & rules">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Invoice prefix"><Input value={f.invoice_prefix ?? ''} onChange={(e) => set('invoice_prefix', e.target.value)} /></Field>
          <Field label="Next invoice no." hint="Change only at the start of a financial year"><Input inputMode="numeric" value={f.next_invoice_no ?? 1} onChange={(e) => set('next_invoice_no', Number(e.target.value) || 1)} /></Field>
          <Field label="Credit note prefix"><Input value={f.return_prefix ?? ''} onChange={(e) => set('return_prefix', e.target.value)} /></Field>
        </div>
        <div className="mt-5 space-y-4">
          <Switch checked={!!f.round_off} onChange={(v) => set('round_off', v ? 1 : 0)} label="Round bills to the nearest rupee" hint="Shown as a separate Round off line" />
          <Switch checked={!!f.allow_negative_stock} onChange={(v) => set('allow_negative_stock', v ? 1 : 0)} label="Allow billing when stock shows zero" hint="Recommended — counters shouldn't stop because stock wasn't entered" />
          <Field label="Weighing-scale barcode contains">
            <Segmented value={f.weight_barcode_mode ?? 'weight'} onChange={(v) => set('weight_barcode_mode', v)} options={[{ value: 'weight', label: 'Weight in grams' }, { value: 'price', label: 'Price in paise' }]} />
          </Field>
        </div>
      </Card>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(f)}>Save</Button></div>
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
  const [sample, setSample] = useState<Template>('kirana');
  const loadSample = useAction('sample.load', { success: 'Sample data added' });
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
        <p className="mb-4 text-sm text-muted">All your data lives on this computer and saves automatically after every bill. Download a backup file every day or week — automatic cloud backup comes with sync in the next release.</p>
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
      <Card title="Sample data & reset">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={sample} onChange={(e) => setSample(e.target.value as Template)} className="w-56">{(Object.keys(TEMPLATES) as Template[]).map((t) => <option key={t} value={t}>{TEMPLATES[t].label}</option>)}</Select>
          <Button variant="outline" loading={loadSample.isPending} onClick={() => loadSample.mutate({ template: sample })}>Add sample items & bills</Button>
          <span className="flex-1" />
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setWipe(true)}>Erase everything</Button>
        </div>
      </Card>
      <ConfirmDialog open={!!restoreFile} onOpenChange={(v) => !v && setRestoreFile(null)} title="Restore this backup?" body={`Everything on this computer will be replaced with “${restoreFile?.name}”. Take a backup first if unsure.`} danger confirmLabel="Restore" onConfirm={async () => { await db.importBytes(await restoreFile!.arrayBuffer()); useUi.getState().setSession(null); toast.success('Backup restored. Unlock with your PIN.'); }} />
      <ConfirmDialog open={wipe} onOpenChange={setWipe} title="Erase all data?" body="Every bill, item and customer on this computer will be deleted. This cannot be undone." danger confirmLabel="Erase everything" onConfirm={async () => { await db.reset(); useUi.getState().setSession(null); }} />
    </div>
  );
}

function Audit() {
  const q = useApi('audit.list');
  return (
    <Card padded={false} title="Recent activity">
      <div className="max-h-[60vh] overflow-y-auto">
        <table className="table-base">
          <tbody>
            {(q.data as Array<{ id: number; at: string; user_name: string | null; action: string; details: string | null }> | undefined)?.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-xs text-muted">{a.at}</td>
                <td className="text-sm">{a.user_name ?? 'System'}</td>
                <td className="font-mono text-xs">{a.action}</td>
                <td className="max-w-[320px] truncate text-xs text-faint">{a.details}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
