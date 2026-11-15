import QRCode from 'qrcode';
import { AlertTriangle, Cloud, CloudUpload, KeyRound, Laptop, Plus, RefreshCw, Smartphone, Trash2, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Dialog, Field, Input, Loading, Segmented, toast } from '../../components/ui';
import { cloud, DEFAULT_SERVER, toConnectInfo, type CloudBackup, type CloudDevice } from '../../cloud/api';
import { decryptBackup, passphraseProblem } from '../../cloud/backupCrypto';
import { call, db } from '../../db/client';
import { fmtDate } from '../../lib/format';
import { useAction, useApi } from '../../lib/useApi';
import { backupToCloud } from './backup';
import { cloudLocal } from './local';

/** Settings → Cloud: connect this enterprise, add devices, encrypted backups. Owner only. */
export function CloudSettings() {
  const status = useApi('app.status').data;
  if (!status?.company) return <Loading />;
  return status.sync?.connected ? <Connected enterpriseId={status.enterpriseId!} /> : <Connect companyName={status.company.name} />;
}

/* ───────── not connected yet ───────── */

function Connect({ companyName }: { companyName: string }) {
  const [account, setAccount] = useState(cloudLocal.account());
  const [server, setServer] = useState(account?.server ?? DEFAULT_SERVER);
  const [deviceName, setDeviceName] = useState('Main counter');
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    if (!account) return;
    setBusy(true);
    try {
      const shop = await cloud.createShop(account.server, account.token, companyName);
      const creds = await cloud.addDevice(account.server, account.token, shop.id, deviceName.trim() || 'Main counter');
      await db.connectCloud(toConnectInfo(account.server, creds));
      toast.success('Connected to the cloud', 'Your data is uploading. Add your other counters and phones from here.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4" /> Cloud sync & backup</span>}>
        <p className="mb-4 text-sm text-muted">
          Connect <b className="text-ink">{companyName}</b> to use several counters and phones together. Every device keeps working offline and
          catches up when the internet is back. Backups are locked with your own passphrase before they leave this computer.
        </p>
        <Field label="Cloud server" hint="Leave as it is unless your accountant or IT person gave you another address.">
          <Input value={server} onChange={(e) => setServer(e.target.value)} disabled={!!account} data-testid="cloud-server" />
        </Field>
      </Card>
      {account ? (
        <Card title="Connect this enterprise">
          <p className="mb-3 text-sm">
            Signed in as <b>{account.email}</b>{' '}
            <button className="ml-2 text-xs text-primary hover:underline" onClick={() => (cloudLocal.setAccount(null), setAccount(null))}>
              Sign out
            </button>
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Name for this computer" className="w-64">
              <Input value={deviceName} onChange={(e) => setDeviceName(e.target.value)} data-testid="cloud-device-name" />
            </Field>
            <Button variant="primary" icon={<CloudUpload className="h-4 w-4" />} loading={busy} onClick={connect} data-testid="cloud-connect">
              Connect &amp; upload
            </Button>
          </div>
        </Card>
      ) : (
        <SignIn server={server} onDone={setAccount} />
      )}
    </div>
  );
}

export function SignIn({ server, onDone }: { server: string; onDone: (a: { server: string; token: string; email: string }) => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = mode === 'signup' ? await cloud.signup(server, email, password) : await cloud.login(server, email, password);
      const a = { server, token: r.token, email: r.email };
      cloudLocal.setAccount(a);
      onDone(a);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Owner's cloud account">
      <div className="mb-3">
        <Segmented value={mode} onChange={setMode} options={[{ value: 'signup', label: 'Create account' }, { value: 'login', label: 'Sign in' }]} size="sm" />
      </div>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), void go())}>
        <Field label="Email">
          <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="cloud-email" />
        </Field>
        <Field label="Password" hint={mode === 'signup' ? 'At least 8 characters.' : undefined}>
          <Input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="cloud-password" />
        </Field>
        <div className="sm:col-span-2">
          <Button type="submit" variant="primary" loading={busy} data-testid="cloud-signin">
            {mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/* ───────── connected ───────── */

function Connected({ enterpriseId }: { enterpriseId: string }) {
  const sync = useApi('app.status').data?.sync;
  const creds = useApi('sync.credentials').data;
  const [syncing, setSyncing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  if (!sync?.connected || !creds) return <Loading />;
  const syncNow = async () => {
    setSyncing(true);
    try {
      await db.syncNow();
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card
        title={<span className="flex items-center gap-2"><Cloud className="h-4 w-4" /> Cloud sync</span>}
        action={<Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={syncing} onClick={syncNow} data-testid="cloud-sync-now">Sync now</Button>}
      >
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row k="This computer" v={<>{sync.deviceName} {sync.deviceCode ? <Badge className="ml-1">Bill series {sync.deviceCode}</Badge> : <Badge className="ml-1">Main series</Badge>}</>} />
          <Row k="Server" v={<span className="break-all">{sync.serverUrl}</span>} />
          <Row k="Last synced" v={sync.lastPullAt ? fmtDate(sync.lastPullAt) + ' ' + sync.lastPullAt.slice(11, 16) + ' UTC' : 'Not yet'} />
          <Row k="Waiting to send" v={<span data-testid="cloud-pending">{sync.pending}</span>} />
        </dl>
        {sync.lastError && (
          <p className="mt-3 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
            <AlertTriangle className="h-4 w-4" /> {sync.lastError}
          </p>
        )}
        <div className="mt-4 border-t border-border pt-3">
          <Button size="sm" variant="ghost" icon={<Unplug className="h-3.5 w-3.5" />} onClick={() => setConfirmOff(true)}>
            Disconnect this computer
          </Button>
        </div>
      </Card>
      <Devices server={creds.serverUrl} token={creds.deviceToken} />
      <Conflicts />
      <Backups enterpriseId={enterpriseId} server={creds.serverUrl} token={creds.deviceToken} />
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        danger
        title="Disconnect from the cloud?"
        body="This computer keeps all its data but stops syncing. Changes not yet sent are not uploaded. You can connect it again later as a new shop."
        confirmLabel="Disconnect"
        onConfirm={async () => {
          await db.disconnectCloud();
          toast.success('Disconnected');
        }}
      />
    </div>
  );
}

const Row = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="flex justify-between gap-3 border-b border-border/60 py-1.5 sm:block sm:border-0 sm:py-0">
    <dt className="text-muted">{k}</dt>
    <dd className="font-medium">{v}</dd>
  </div>
);

function Devices({ server, token }: { server: string; token: string }) {
  const [list, setList] = useState<CloudDevice[] | null>(null);
  const [pair, setPair] = useState<{ code: string; expiresAt: string; qr: string } | null>(null);
  const [remove, setRemove] = useState<CloudDevice | null>(null);
  const load = () => cloud.devices(server, token).then((r) => setList(r.devices), () => setList([]));
  useEffect(() => void load(), [server, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const addDevice = async () => {
    try {
      const r = await cloud.pairingCode(server, token);
      const qr = await QRCode.toDataURL(`HISAAB-PAIR ${server} ${r.code}`, { margin: 1, width: 360 });
      setPair({ ...r, qr });
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><Laptop className="h-4 w-4" /> Devices</span>}
      action={<Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={addDevice} data-testid="cloud-add-device">Add a device</Button>}
    >
      {!list ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-border">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2 text-sm">
              {d.kind === 'phone' ? <Smartphone className="h-4 w-4 text-muted" /> : <Laptop className="h-4 w-4 text-muted" />}
              <span className="flex-1">
                <b>{d.name}</b> {d.thisDevice && <Badge tone="good" className="ml-1">This computer</Badge>}
                <span className="block text-xs text-muted">{d.lastSeenAt ? `Last seen ${fmtDate(d.lastSeenAt)}` : 'Not connected yet'}</span>
              </span>
              {!d.thisDevice && (
                <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setRemove(d)}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Dialog open={!!pair} onOpenChange={(v) => !v && (setPair(null), void load())} title="Add a counter or phone" size="sm">
        {pair && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-muted">On the new device, open Hisaab and choose <b className="text-ink">Join an existing shop</b>. Enter this code:</p>
            <p className="font-mono text-4xl font-semibold tracking-[0.3em]" data-testid="pairing-code">{pair.code}</p>
            <img src={pair.qr} alt="Pairing QR code" className="mx-auto h-44 w-44" />
            <p className="text-xs text-faint">Works once, for 15 minutes. Server: {server}</p>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(v) => !v && setRemove(null)}
        danger
        title={`Remove ${remove?.name}?`}
        body="It stops syncing immediately. Its data stays on that device. To use it again, pair it with a new code."
        confirmLabel="Remove device"
        onConfirm={async () => {
          await cloud.removeDevice(server, token, remove!.id);
          setRemove(null);
          await load();
        }}
      />
    </Card>
  );
}

function Conflicts() {
  const list = useApi('sync.conflicts').data ?? [];
  const clear = useAction('sync.clearConflicts');
  const open = list.filter((c) => !c.seen);
  if (!open.length) return null;
  return (
    <Card
      title={<span className="flex items-center gap-2 text-warn"><AlertTriangle className="h-4 w-4" /> Needs a look ({open.length})</span>}
      action={<Button size="sm" variant="ghost" onClick={() => clear.mutate(undefined as never)}>Mark all as seen</Button>}
    >
      <ul className="space-y-1.5 text-sm">
        {open.map((c) => (
          <li key={c.id}>· {c.message}</li>
        ))}
      </ul>
    </Card>
  );
}

function Backups({ enterpriseId, server, token }: { enterpriseId: string; server: string; token: string }) {
  const [hasPass, setHasPass] = useState(!!cloudLocal.passphrase(enterpriseId));
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');
  const [list, setList] = useState<CloudBackup[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [restore, setRestore] = useState<CloudBackup | null>(null);
  const load = () => cloud.backups(server, token).then((r) => setList(r.backups), () => setList([]));
  useEffect(() => void load(), [server, token]); // eslint-disable-line react-hooks/exhaustive-deps

  const savePass = () => {
    const problem = passphraseProblem(p1) ?? (p1 !== p2 ? 'The two passphrases do not match.' : null);
    if (problem) return toast.error(new Error(problem));
    cloudLocal.setPassphrase(enterpriseId, p1);
    setHasPass(true);
    setP1('');
    setP2('');
    toast.success('Backup passphrase saved', 'Write it down. Without it a cloud backup cannot be opened — not even by us.');
  };
  const backupNow = async () => {
    setBusy(true);
    try {
      await backupToCloud(enterpriseId, 'Manual backup');
      toast.success('Backed up to the cloud');
      await load();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title={<span className="flex items-center gap-2"><KeyRound className="h-4 w-4" /> Encrypted cloud backup</span>}
      action={hasPass && <Button size="sm" variant="primary" icon={<CloudUpload className="h-3.5 w-3.5" />} loading={busy} onClick={backupNow} data-testid="cloud-backup-now">Back up now</Button>}
    >
      {!hasPass ? (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => (e.preventDefault(), savePass())}>
          <p className="text-sm text-muted sm:col-span-2">Choose a passphrase. Backups are locked with it on this computer, then uploaded once a day and whenever you click Back up now.</p>
          <Field label="Backup passphrase">
            <Input type="password" value={p1} onChange={(e) => setP1(e.target.value)} data-testid="cloud-pass1" />
          </Field>
          <Field label="Type it again">
            <Input type="password" value={p2} onChange={(e) => setP2(e.target.value)} data-testid="cloud-pass2" />
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="primary" data-testid="cloud-pass-save">Save passphrase</Button>
          </div>
        </form>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted">
            Automatic daily backup is on.{' '}
            <button className="text-primary hover:underline" onClick={() => (cloudLocal.setPassphrase(enterpriseId, null), setHasPass(false))}>Change passphrase</button>
          </p>
          {!list ? (
            <Loading />
          ) : list.length === 0 ? (
            <p className="text-sm text-faint">No cloud backups yet.</p>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="cloud-backups">
              {list.map((b) => (
                <li key={b.id} className="flex items-center gap-3 py-2">
                  <span className="flex-1">
                    {fmtDate(b.createdAt)} {b.createdAt.slice(11, 16)} · {(b.size / 1024 / 1024).toFixed(1)} MB
                    <span className="block text-xs text-muted">{b.note} {b.device && `· ${b.device}`}</span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setRestore(b)}>Restore…</Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <RestoreDialog backup={restore} onClose={() => setRestore(null)} fetchBytes={(id) => cloud.downloadBackup(server, token, id)} defaultPass={cloudLocal.passphrase(enterpriseId) ?? ''} />
    </Card>
  );
}

/** Download, decrypt and open a cloud backup as a separate enterprise on this computer. */
export function RestoreDialog({ backup, onClose, fetchBytes, defaultPass = '' }: { backup: CloudBackup | null; onClose: () => void; fetchBytes: (id: string) => Promise<Uint8Array>; defaultPass?: string }) {
  const [pass, setPass] = useState(defaultPass);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPass(defaultPass), [defaultPass, backup]);
  const go = async () => {
    if (!backup) return;
    setBusy(true);
    try {
      const plain = await decryptBackup(await fetchBytes(backup.id), pass);
      await db.importBytes(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer, true);
      await call('app.status');
      toast.success('Backup restored', 'It opened as a separate enterprise. Unlock it with your PIN.');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!backup}
      onOpenChange={(v) => !v && onClose()}
      title="Restore cloud backup"
      description={backup ? `From ${fmtDate(backup.createdAt)}. It opens as a separate enterprise; nothing here is overwritten.` : undefined}
      size="sm"
      footer={<Button variant="primary" loading={busy} onClick={go} data-testid="cloud-restore-go">Restore</Button>}
    >
      <Field label="Backup passphrase">
        <Input type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} data-testid="cloud-restore-pass" />
      </Field>
    </Dialog>
  );
}

