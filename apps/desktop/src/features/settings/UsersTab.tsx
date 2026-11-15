import { can, NOT_GRANTABLE, PERMISSION_GROUPS, ROLE_LABELS, roleCan, type Permission, type Role } from '@hisaab/core';
import { Plus, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card, ConfirmDialog, Dialog, Field, Input } from '../../components/ui';
import { cn } from '../../lib/cn';
import { useUi } from '../../lib/store';
import { useAction, useApi } from '../../lib/useApi';

type Edit = { id?: number; name: string; role: Role; pin: string; grant: string[]; revoke: string[] };

/** Settings → Users & PINs: people, their role, what the owner allowed or took away, and removing them. */
export function UsersTab() {
  const list = useApi('users.list');
  const me = useUi((s) => s.session);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [del, setDel] = useState<{ id: number; name: string } | null>(null);
  const save = useAction('users.save', { success: 'User saved', onSuccess: () => setEdit(null) });
  const remove = useAction('users.delete', { success: 'User removed', onSuccess: () => setDel(null) });
  return (
    <Card title={<span className="flex items-center gap-2"><Users className="h-4 w-4" /> Users</span>} action={<Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', role: 'cashier', pin: '', grant: [], revoke: [] })}>Add user</Button>} padded={false}>
      <table className="table-base" data-testid="users-table">
        <thead><tr><th>Name</th><th>Role</th><th>Can do</th><th /></tr></thead>
        <tbody>
          {list.data?.map((u) => {
            const changes = u.grant.length + u.revoke.length;
            return (
              <tr key={u.id}>
                <td className="font-medium">{u.name} {u.id === me?.userId && <Badge tone="primary">you</Badge>}</td>
                <td className="capitalize">{u.role}</td>
                <td className="text-xs text-muted">
                  {ROLE_LABELS[u.role].description}
                  {changes > 0 && <span className="ml-1 font-medium text-primary">· {u.grant.length ? `+${u.grant.length}` : ''}{u.grant.length && u.revoke.length ? ' / ' : ''}{u.revoke.length ? `−${u.revoke.length}` : ''} changed</span>}
                </td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEdit({ id: u.id, name: u.name, role: u.role, pin: '', grant: u.grant, revoke: u.revoke })} data-testid="user-edit">Edit</Button>
                  {u.id !== me?.userId && <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setDel({ id: u.id, name: u.name })} aria-label={`Delete ${u.name}`} data-testid="user-delete" />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {edit && <UserDialog edit={edit} setEdit={setEdit} saving={save.isPending} onSave={() => save.mutate(edit)} />}
      <ConfirmDialog
        open={!!del}
        onOpenChange={(v) => !v && setDel(null)}
        title={`Delete ${del?.name}?`}
        body="They can no longer sign in, on this computer or a phone. Bills and payments they made keep their name."
        confirmLabel="Delete user"
        danger
        onConfirm={() => {
          if (del) remove.mutate({ id: del.id });
        }}
      />
    </Card>
  );
}

function UserDialog({ edit, setEdit, saving, onSave }: { edit: Edit; setEdit: (e: Edit) => void; saving: boolean; onSave: () => void }) {
  const has = (p: Permission) => can(edit.role, p, edit);
  const toggle = (p: Permission, on: boolean) => {
    const base = roleCan(edit.role, p);
    const grant = edit.grant.filter((x) => x !== p);
    const revoke = edit.revoke.filter((x) => x !== p);
    if (on && !base) grant.push(p);
    if (!on && base) revoke.push(p);
    setEdit({ ...edit, grant, revoke });
  };
  const changed = edit.grant.length + edit.revoke.length;
  return (
    <Dialog open onOpenChange={(v) => !v && setEdit(null as never)} title={edit.id ? 'Edit user' : 'Add user'} size="lg"
      footer={<><Button variant="ghost" onClick={() => setEdit(null as never)}>Cancel</Button><Button variant="primary" loading={saving} onClick={onSave}>Save</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label={edit.id ? 'New 4-digit PIN (leave empty to keep)' : '4-digit PIN'}><Input type="password" inputMode="numeric" maxLength={4} value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })} /></Field>
        </div>
        <Field label="Role">
          <div className="grid gap-2 sm:grid-cols-2">
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <label key={r} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${edit.role === r ? 'border-primary bg-primary-soft/50' : 'border-border'}`}>
                <input type="radio" checked={edit.role === r} onChange={() => setEdit({ ...edit, role: r, grant: [], revoke: [] })} className="mt-1 accent-[rgb(var(--primary))]" />
                <span><span className="block text-sm font-medium">{ROLE_LABELS[r].label}</span><span className="text-xs text-muted">{ROLE_LABELS[r].description}</span></span>
              </label>
            ))}
          </div>
        </Field>
        {edit.role === 'owner' ? (
          <p className="flex items-center gap-2 rounded-lg bg-surface-2 p-3 text-sm text-muted"><ShieldCheck className="h-4 w-4" /> An owner can do everything.</p>
        ) : (
          <div data-testid="user-perms">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">What {edit.name.trim() || 'they'} can do</p>
              {changed > 0 && <button type="button" className="text-xs text-primary hover:underline" onClick={() => setEdit({ ...edit, grant: [], revoke: [] })}>Reset to the {edit.role} role</button>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {PERMISSION_GROUPS.map((g) => (
                <div key={g.group}>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.group}</p>
                  <ul className="space-y-1">
                    {g.perms.filter((p) => !NOT_GRANTABLE.includes(p.perm)).map((p) => {
                      const on = has(p.perm);
                      const differs = on !== roleCan(edit.role, p.perm);
                      return (
                        <li key={p.perm}>
                          <label className={cn('flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm', differs && 'bg-primary-soft/60')}>
                            <input type="checkbox" checked={on} onChange={(e) => toggle(p.perm, e.target.checked)} className="mt-0.5 accent-[rgb(var(--primary))]" data-testid={`perm-${p.perm}`} />
                            <span>{p.label}{p.hint && <span className="block text-[11px] text-muted">{p.hint}</span>}</span>
                            {differs && <span className="ml-auto text-[10px] font-medium text-primary">{on ? 'allowed' : 'removed'}</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted">Highlighted ones differ from the {edit.role} role. Changes apply the next time they sign in.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}
