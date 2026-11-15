import { Camera, Check, FileText, Trash2, Wallet, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge, Button, Card, EmptyState, Loading, Stat, toast } from '../../components/ui';
import { call } from '../../db/client';
import { fmtDate, inr } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction, useApi } from '../../lib/useApi';

/** Owner: expenses above the approval limit, waiting for a yes / no. */
export function Approvals({ onOpen }: { onOpen: (id: number) => void }) {
  const list = useApi('expenses.approvals');
  const owner = useCan()('users.manage');
  const decide = useAction('expenses.approve', { success: (e) => (e.status === 'cancelled' ? 'Rejected' : `Approved${e.status === 'paid' ? ' and paid' : ''}`) });
  if (!list.data) return <Loading />;
  if (!list.data.length) return <EmptyState icon={<Check className="h-6 w-6" />} title="Nothing waiting for approval" />;
  return (
    <Card padded={false}>
      <table className="table-base">
        <thead><tr><th>Date</th><th>Expense</th><th>Added by</th><th className="text-right">Amount</th><th /></tr></thead>
        <tbody>
          {list.data.map((e) => (
            <tr key={e.id} data-testid="approval-row">
              <td>{fmtDate(e.date)}</td>
              <td><button className="hover:underline" onClick={() => onOpen(e.id)}>{e.category}{e.payee ? ` · ${e.payee}` : ''}</button></td>
              <td>{(e as { created_by_name?: string }).created_by_name ?? '—'}</td>
              <td className="text-right tnum font-medium">{inr(e.amount)}</td>
              <td className="whitespace-nowrap text-right">
                {owner ? (
                  <>
                    <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide.mutate({ id: e.id, approve: false })}>Reject</Button>
                    <Button size="sm" variant="outline" onClick={() => decide.mutate({ id: e.id, approve: true })} data-testid="approve">Approve</Button>
                    <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: e.id, approve: true, payNow: { mode: 'cash' } })} data-testid="approve-pay">Approve & pay cash</Button>
                  </>
                ) : <Badge tone="warn">waiting for owner</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** The counter's petty-cash box: float, spent since the last top-up, what's left. */
export function PettyCash({ onOpen }: { onOpen: (id: number) => void }) {
  const q = useApi('expenses.petty');
  const canTopUp = useCan()('money.move');
  const topUp = useAction('expenses.pettyTopUp', { success: (amt) => `Topped up ${inr(amt)} — the box is back to its float` });
  if (!q.data) return <Loading />;
  const p = q.data;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Float" value={inr(p.float)} icon={<Wallet className="h-4 w-4" />} />
        <Stat label={p.since ? `Spent since ${fmtDate(p.since.slice(0, 10))}` : 'Spent'} value={inr(p.spent)} />
        <Stat label="Should be in the box" value={<span data-testid="petty-inbox">{inr(p.inBox)}</span>} tone={p.inBox < p.float * 0.2 ? 'warn' : 'good'} />
      </div>
      <Card padded={false} title="Paid from petty cash" action={canTopUp && p.spent > 0 && <Button size="sm" variant="primary" onClick={() => topUp.mutate(undefined as never)} data-testid="petty-topup">Top up {inr(p.spent)}</Button>}>
        <table className="table-base text-sm">
          <thead><tr><th>Date</th><th>Expense</th><th className="text-right">Amount</th></tr></thead>
          <tbody>
            {p.items.map((x) => <tr key={x.id} className="cursor-pointer hover:bg-surface-2" onClick={() => onOpen(x.id)}><td>{fmtDate(x.date)}</td><td>{x.category}{x.payee ? ` · ${x.payee}` : ''}</td><td className="text-right tnum">{inr(x.amount)}</td></tr>)}
            {!p.items.length && <tr><td colSpan={3} className="text-faint">Nothing paid from the box since the last top-up.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/** Shrink a photo on the device (max 1600 px, JPEG) so bills sync quickly. */
async function shrink(file: File): Promise<{ data: string; mime: string }> {
  if (file.type === 'application/pdf') {
    const buf = new Uint8Array(await file.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(s), mime: file.type };
  }
  const img = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * k);
  canvas.height = Math.round(img.height * k);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', 0.72);
  return { data: url.slice(url.indexOf(',') + 1), mime: 'image/jpeg' };
}

/** Bill photos / PDFs on an expense. */
export function Attachments({ expenseId, canEdit }: { expenseId: number; canEdit: boolean }) {
  const list = useApi('attachments.list', { entity: 'expense', entityId: expenseId });
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async (f: File) => {
    setBusy(true);
    try {
      const { data, mime } = await shrink(f);
      await call('attachments.add', { entity: 'expense', entityId: expenseId, name: f.name, mime, data });
      toast.success('Bill attached');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      if (file.current) file.current.value = '';
    }
  };
  const del = useAction('attachments.delete');
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">Bill photo</span>
        {canEdit && <Button size="sm" variant="outline" icon={<Camera className="h-3.5 w-3.5" />} loading={busy} onClick={() => file.current?.click()} data-testid="attach-bill">Attach</Button>}
        <input ref={file} type="file" accept="image/*,application/pdf" capture="environment" className="hidden" data-testid="attach-file" onChange={(e) => e.target.files?.[0] && add(e.target.files[0])} />
      </div>
      <div className="flex flex-wrap gap-2">
        {(list.data ?? []).map((a) => (
          <div key={a.id} className="group relative">
            <a href={`data:${a.mime};base64,${a.data}`} target="_blank" rel="noreferrer" download={a.name}>
              {a.mime.startsWith('image/') ? <img src={`data:${a.mime};base64,${a.data}`} alt={a.name} className="h-24 w-24 rounded-lg border border-border object-cover" data-testid="attachment" /> : <span className="flex h-24 w-24 flex-col items-center justify-center rounded-lg border border-border text-xs text-muted"><FileText className="h-6 w-6" />{a.name}</span>}
            </a>
            {canEdit && <button className="absolute right-1 top-1 hidden rounded bg-surface p-1 shadow group-hover:block" title="Remove" onClick={() => del.mutate({ id: a.id })}><Trash2 className="h-3 w-3 text-bad" /></button>}
          </div>
        ))}
        {!list.data?.length && <p className="text-xs text-faint">No photo. Attach the bill for your records and your CA.</p>}
      </div>
    </div>
  );
}
