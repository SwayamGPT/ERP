import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { db } from '../db/client';
import { useCan } from '../lib/perm';
import { Button, ConfirmDialog, toast } from './ui';

/** After an import: keep it, or put everything back exactly as it was. Cloud sync waits meanwhile. */
export function ImportReview() {
  const owner = useCan()('settings.edit');
  const st = useQuery({ queryKey: ['import.review'], queryFn: () => db.importStatus(), staleTime: 0, enabled: owner, networkMode: 'always' });
  const [undoOpen, setUndoOpen] = useState(false);
  const s = st.data;
  if (!s) return null;
  const keep = async () => {
    try {
      await db.importKeep();
      toast.success('Import kept', 'Cloud sync carries on.');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="no-print flex flex-wrap items-center gap-3 border-b border-primary/30 bg-primary-soft px-4 py-2 text-sm" data-testid="import-review">
      <ClipboardCheck className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1">
        <b>Checking an import</b> started {new Date(s.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. Cloud sync is paused until you keep it.
        {s.changesSince > 0 && <span className="text-warn"> {s.changesSince} other changes (bills, payments…) were made since — Undo would remove them too.</span>}
      </span>
      <Button size="sm" variant="primary" icon={<CheckCircle2 className="h-4 w-4" />} onClick={() => void keep()} data-testid="import-keep">Keep</Button>
      <Button size="sm" variant="outline" icon={<Undo2 className="h-4 w-4" />} onClick={() => setUndoOpen(true)} data-testid="import-undo">Undo</Button>
      <ConfirmDialog open={undoOpen} onOpenChange={setUndoOpen} title="Undo the import?" danger confirmLabel="Undo import"
        body={<>Hisaab goes back exactly to how it was before you started importing{s.changesSince > 0 ? <>, and the <b>{s.changesSince}</b> changes made since are removed too</> : ''}. You will need to unlock again.</>}
        onConfirm={async () => {
          await db.importUndo();
          toast.success('Import undone', 'Everything is as it was before.');
        }} />
    </div>
  );
}

