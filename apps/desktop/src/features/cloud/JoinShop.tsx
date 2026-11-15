import { CloudDownload, Link2 } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Field, Input, Segmented, Select, toast } from '../../components/ui';
import { cloud, DEFAULT_SERVER, toConnectInfo, type CloudBackup } from '../../cloud/api';
import { db, queryClient } from '../../db/client';
import { fmtDate } from '../../lib/format';
import { RestoreDialog, SignIn } from './CloudSettings';
import { cloudLocal, type CloudAccount } from './local';

/** Onboarding: make this computer (or phone) another device of an existing shop, or restore a cloud backup. */
export function JoinShop({ open, onOpenChange, phone = false }: { open: boolean; onOpenChange: (v: boolean) => void; phone?: boolean }) {
  const [mode, setMode] = useState<'pair' | 'restore'>('pair');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Join an existing shop" size="md">
      <div className="mb-4">
        <Segmented
          value={mode}
          onChange={setMode}
          size="sm"
          options={[
            { value: 'pair', label: <span className="flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5" /> Pairing code</span> },
            { value: 'restore', label: <span className="flex items-center gap-1.5"><CloudDownload className="h-3.5 w-3.5" /> Cloud backup</span> },
          ]}
        />
      </div>
      {mode === 'pair' ? <Pair phone={phone} onDone={() => onOpenChange(false)} /> : <Restore />}
    </Dialog>
  );
}

function Pair({ phone, onDone }: { phone: boolean; onDone: () => void }) {
  const [server, setServer] = useState(cloudLocal.account()?.server ?? DEFAULT_SERVER);
  const [code, setCode] = useState('');
  const [name, setName] = useState(phone ? 'Phone' : 'Counter 2');
  const [busy, setBusy] = useState(false);
  const join = async () => {
    // Accept the text in the pairing QR code too: "HISAAB-PAIR <server> <code>".
    const qr = /^HISAAB-PAIR\s+(\S+)\s+(\d{6})$/.exec(code.trim());
    const srv = qr ? qr[1] : server;
    const c = qr ? qr[2] : code.replace(/\D/g, '');
    if (c.length !== 6) return toast.error(new Error('Enter the 6-digit code shown on the main computer.'));
    setBusy(true);
    try {
      const creds = await cloud.pair(srv, c, name.trim() || 'Counter', phone ? 'phone' : 'counter');
      await db.connectCloud(toConnectInfo(srv, creds), true);
      await queryClient.invalidateQueries();
      toast.success(`Joined ${creds.shopName}`, 'Everything has been downloaded. Unlock with your PIN.');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="space-y-3" onSubmit={(e) => (e.preventDefault(), void join())}>
      <p className="text-sm text-muted">On the main computer open <b className="text-ink">Settings → Cloud → Add a device</b> and type the code it shows.</p>
      <Field label="Pairing code">
        <Input className="input-lg font-mono tracking-[0.3em]" inputMode="numeric" autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" data-testid="join-code" />
      </Field>
      <Field label="Name for this device">
        <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="join-name" />
      </Field>
      <Field label="Cloud server">
        <Input value={server} onChange={(e) => setServer(e.target.value)} data-testid="join-server" />
      </Field>
      <Button type="submit" variant="primary" loading={busy} className="w-full" data-testid="join-go">
        Join shop
      </Button>
    </form>
  );
}

function Restore() {
  const [account, setAccount] = useState<CloudAccount | null>(cloudLocal.account());
  const [server] = useState(account?.server ?? DEFAULT_SERVER);
  const [shops, setShops] = useState<Array<{ id: string; name: string }> | null>(null);
  const [shop, setShop] = useState('');
  const [list, setList] = useState<CloudBackup[] | null>(null);
  const [pick, setPick] = useState<CloudBackup | null>(null);
  const loadShops = async (a: CloudAccount) => {
    try {
      const r = await cloud.shops(a.server, a.token);
      setShops(r.shops);
      if (r.shops[0]) await loadBackups(a, r.shops[0].id);
    } catch (e) {
      toast.error(e);
    }
  };
  const loadBackups = async (a: CloudAccount, id: string) => {
    setShop(id);
    setList((await cloud.backups(a.server, a.token, id)).backups);
  };
  if (!account) return <SignIn server={server} onDone={(a) => (setAccount(a), void loadShops(a))} />;
  if (!shops) {
    void loadShops(account);
    return <p className="text-sm text-muted">Loading your shops…</p>;
  }
  return (
    <div className="space-y-3">
      <Field label="Shop">
        <Select value={shop} onChange={(e) => void loadBackups(account, e.target.value)}>
          {shops.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
      </Field>
      {!list?.length ? (
        <p className="text-sm text-faint">No cloud backups for this shop.</p>
      ) : (
        <ul className="max-h-64 divide-y divide-border overflow-auto text-sm">
          {list.map((b) => (
            <li key={b.id} className="flex items-center gap-3 py-2">
              <span className="flex-1">{fmtDate(b.createdAt)} {b.createdAt.slice(11, 16)} <span className="text-xs text-muted">· {b.note}</span></span>
              <Button size="sm" variant="outline" onClick={() => setPick(b)}>Restore</Button>
            </li>
          ))}
        </ul>
      )}
      <RestoreDialog backup={pick} onClose={() => setPick(null)} fetchBytes={(id) => cloud.downloadBackup(account.server, account.token, id, shop)} />
    </div>
  );
}
