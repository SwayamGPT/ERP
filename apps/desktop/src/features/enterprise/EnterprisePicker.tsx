import { Building2, ChevronRight, Plus, Upload } from 'lucide-react';
import { useRef } from 'react';
import { Logo } from '../../components/Logo';
import { Button, toast } from '../../components/ui';
import { db } from '../../db/client';
import type { EnterpriseEntry } from '../../db/types';
import { relative } from '../../lib/format';

/** Shown when several enterprises exist and none is open. */
export function EnterprisePicker({ enterprises }: { enterprises: EnterpriseEntry[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const open = (id: string) => db.openEnterprise(id).catch(toast.error);
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden bg-bg p-6">
      <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative w-full max-w-xl">
        <div className="mb-6 flex flex-col items-center text-center">
          <Logo className="mb-3 h-12 w-12" />
          <h1 className="text-xl font-semibold tracking-tight">Choose an enterprise</h1>
          <p className="text-sm text-muted">Each business keeps its own items, bills, GST and staff.</p>
        </div>
        <div className="card divide-y divide-border overflow-hidden" data-testid="enterprise-list">
          {enterprises.map((e, i) => (
            <button key={e.id} autoFocus={i === 0} onClick={() => open(e.id)} className="flex w-full items-center gap-4 px-5 py-4 text-left transition hover:bg-surface-2 focus:bg-primary-soft/50 focus:outline-none">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary-soft text-lg font-semibold text-primary">{e.name.slice(0, 1).toUpperCase()}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold">{e.name}</span>
                <span className="block truncate text-xs text-muted">
                  {e.gstin && <span className="font-mono">{e.gstin}</span>}
                  {e.city && ` · ${e.city}`}
                  {e.openedAt && ` · opened ${relative(e.openedAt).toLowerCase()}`}
                </span>
              </span>
              <ChevronRight className="h-4 w-4 text-faint" />
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => db.createEnterprise().catch(toast.error)} data-testid="enterprise-new">
            Create new enterprise
          </Button>
          <Button variant="ghost" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
            Add from backup
          </Button>
        </div>
        <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-faint">
          <Building2 className="h-3.5 w-3.5" /> {enterprises.length} enterprises on this computer
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".hisaab,.sqlite,.db"
          className="hidden"
          onChange={async (ev) => {
            const f = ev.target.files?.[0];
            if (!f) return;
            try {
              await db.importBytes(await f.arrayBuffer(), true);
              toast.success('Enterprise added from backup');
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      </div>
    </div>
  );
}
