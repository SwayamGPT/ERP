import { CloudUpload, HardDriveDownload, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Field, Input, Segmented, Switch, toast } from '../components/ui';
import { decryptBackup } from '../cloud/backupCrypto';
import { db } from '../db/client';
import { fmtDate } from '../lib/format';
import { useApi } from '../lib/useApi';
import { downloadBackup, ensureFolder, EVERY, listBackups, type DriveFile } from './gdrive';
import { clientId, driveEmail, forgetToken, getToken, setClientId } from './google';
import { backupToDrive, drivePrefs, saveDrivePrefs, type DrivePrefs } from './schedule';

/** Settings → Backup & data → automatic backup to Google Drive. */
export function GoogleDriveCard() {
  const s = useApi('app.status').data;
  const id = s?.enterpriseId ?? '';
  const shop = s?.company?.name ?? 'hisaab';
  const [p, setP] = useState<DrivePrefs>(() => drivePrefs(id));
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<DriveFile[] | null>(null);
  const [restore, setRestore] = useState<DriveFile | null>(null);
  const [cid, setCid] = useState(clientId());
  const update = (patch: Partial<DrivePrefs>) => setP(saveDrivePrefs(id, patch));

  const connect = async () => {
    setBusy(true);
    try {
      const t = await getToken(true);
      update({ email: await driveEmail(t), enabled: true, lastError: null });
      toast.success('Google Drive connected', 'Backups will run automatically while Hisaab is open.');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const now = async () => {
    setBusy(true);
    try {
      const f = await backupToDrive(id, shop, true);
      setP(drivePrefs(id));
      toast.success('Backed up to Google Drive', f.name);
    } catch (e) {
      setP(drivePrefs(id));
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const showFiles = async () => {
    try {
      const t = await getToken(true);
      setFiles(await listBackups(fetch, t, await ensureFolder(fetch, t)));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Card title={<span className="flex items-center gap-2"><CloudUpload className="h-4 w-4" /> Automatic backup to Google Drive</span>}>
      {!clientId() ? (
        <div className="space-y-2 text-sm">
          <p className="text-muted">Google Drive backup needs this copy of Hisaab to be registered with Google (an OAuth client ID). Whoever installs Hisaab for you enters it once:</p>
          <div className="flex gap-2">
            <Input placeholder="xxxxxxxx.apps.googleusercontent.com" value={cid} onChange={(e) => setCid(e.target.value)} data-testid="gdrive-client" />
            <Button variant="outline" disabled={!cid.trim()} onClick={() => (setClientId(cid), setP({ ...p }))}>Save</Button>
          </div>
        </div>
      ) : !p.email ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">Keep copies of all your data in your own Google Drive, in a “Hisaab Backups” folder. Hisaab can only see the files it puts there.</p>
          <Button variant="primary" loading={busy} onClick={connect} data-testid="gdrive-connect">Connect Google Drive</Button>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span>Connected as <b>{p.email}</b></span>
            {p.lastError ? <Badge tone="bad">{p.lastError}</Badge> : p.lastAt ? <Badge tone="good">Last backup {fmtDate(new Date(p.lastAt).toISOString().slice(0, 10))} {new Date(p.lastAt).toTimeString().slice(0, 5)}</Badge> : <Badge>No backup yet</Badge>}
            <button className="text-xs text-muted hover:text-ink" onClick={() => (forgetToken(), update({ email: null, enabled: false }))}>Disconnect</button>
          </div>
          <Switch checked={p.enabled} onChange={(enabled) => update({ enabled })} label="Back up automatically" hint="Runs in the background while Hisaab is open on this computer (as the owner)." />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="How often">
              <Segmented size="sm" value={p.every} onChange={(every) => update({ every })} options={Object.entries(EVERY).map(([value, v]) => ({ value: value as DrivePrefs['every'], label: v.label }))} />
            </Field>
            <Field label="Copies to keep" hint="Older backups are deleted from Drive">
              <Input type="number" min={1} max={200} value={p.keep} onChange={(e) => update({ keep: Math.max(1, Math.min(200, Number(e.target.value) || 1)) })} data-testid="gdrive-keep" />
            </Field>
            <Field label="Lock backups with a passphrase (optional)" hint="Recommended. Without it, anyone with your Drive can open the file. Don't lose it — it can't be recovered." className="sm:col-span-2">
              <Input type="password" value={p.passphrase} onChange={(e) => update({ passphrase: e.target.value })} placeholder="Leave empty for unlocked backups" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={now} data-testid="gdrive-now">Back up now</Button>
            <Button variant="outline" icon={<HardDriveDownload className="h-4 w-4" />} onClick={showFiles}>Backups in Drive</Button>
          </div>
          {files && (
            <ul className="max-h-56 divide-y divide-border overflow-auto rounded-lg border border-border">
              {files.map((f) => (
                <li key={f.id} className="flex items-center justify-between px-3 py-1.5">
                  <span>{f.name} <span className="text-xs text-muted">{f.size ? `· ${(Number(f.size) / 1048576).toFixed(1)} MB` : ''}</span></span>
                  <Button size="sm" variant="ghost" onClick={() => setRestore(f)}>Restore…</Button>
                </li>
              ))}
              {!files.length && <li className="px-3 py-2 text-faint">No backups yet.</li>}
            </ul>
          )}
        </div>
      )}
      {restore && <RestoreDrive file={restore} passphrase={p.passphrase} onClose={() => setRestore(null)} />}
    </Card>
  );
}

function RestoreDrive({ file, passphrase, onClose }: { file: DriveFile; passphrase: string; onClose: () => void }) {
  const encrypted = file.name.endsWith('.enc');
  const [pass, setPass] = useState(passphrase);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const t = await getToken(true);
      const raw = await downloadBackup(fetch, t, file.id);
      const plain = encrypted ? await decryptBackup(raw, pass) : raw;
      await db.importBytes(plain.buffer.slice(plain.byteOffset, plain.byteOffset + plain.byteLength) as ArrayBuffer, true);
      toast.success('Backup restored', 'It opened as a separate business. Unlock it with your PIN.');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Restore from Google Drive" description={`${file.name} opens as a separate business; nothing here is overwritten.`} size="sm"
      footer={<Button variant="primary" loading={busy} onClick={go}>Restore</Button>}>
      {encrypted ? <Field label="Backup passphrase"><Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} /></Field> : <p className="text-sm text-muted">This backup is not locked with a passphrase.</p>}
    </Dialog>
  );
}
