import { AppError, audit, guard, localNow, requireSession, type Ctx } from './base';

/** Photos / PDFs of bills attached to expenses (and later other records). Shrunk on the device before saving. */
const MAX_BASE64 = 1_500_000; // ≈ 1.1 MB file

const PERM = { expense: 'expense.view', invoice: 'purchase.view' } as const;

export function addAttachment(ctx: Ctx, input: { entity: keyof typeof PERM; entityId: number; name: string; mime: string; data: string }) {
  guard(ctx, PERM[input.entity] ?? 'settings.edit');
  if (!/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(input.mime)) throw new AppError('Attach a photo (JPG/PNG) or a PDF.');
  if (input.data.length > MAX_BASE64) throw new AppError('That file is too large. Take a smaller photo (under 1 MB).');
  const s = requireSession(ctx);
  const id = ctx.db.exec('INSERT INTO attachments (entity, entity_id, name, mime, data, created_by, created_at) VALUES (?,?,?,?,?,?,?)', [
    input.entity, input.entityId, input.name.slice(0, 120), input.mime, input.data, s.userId, localNow(),
  ]).lastId;
  audit(ctx, 'attachment.add', input.entity, input.entityId, { name: input.name });
  return id;
}

export function listAttachments(ctx: Ctx, input: { entity: keyof typeof PERM; entityId: number }) {
  guard(ctx, PERM[input.entity] ?? 'settings.edit');
  return ctx.db.query<{ id: number; name: string; mime: string; data: string; created_at: string }>(
    'SELECT id, name, mime, data, created_at FROM attachments WHERE entity = ? AND entity_id = ? ORDER BY id',
    [input.entity, input.entityId],
  );
}

export function deleteAttachment(ctx: Ctx, id: number) {
  const a = ctx.db.get<{ entity: keyof typeof PERM; entity_id: number }>('SELECT entity, entity_id FROM attachments WHERE id = ?', [id]);
  if (!a) throw new AppError('Attachment not found.');
  guard(ctx, PERM[a.entity] ?? 'settings.edit');
  ctx.db.exec('DELETE FROM attachments WHERE id = ?', [id]);
  audit(ctx, 'attachment.delete', a.entity, a.entity_id);
  return true;
}
