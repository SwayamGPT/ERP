import { FileJson, QrCode, ShieldCheck, Truck, X } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, Field, Input, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Company, Invoice } from '../../db/types';
import { downloadJson } from '../../lib/download';
import { fmtDate } from '../../lib/format';
import { useCan } from '../../lib/perm';
import { useAction } from '../../lib/useApi';

export function SignedQr({ data, size = 140 }: { data: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    void QRCode.toDataURL(data, { margin: 1, width: size * 2, errorCorrectionLevel: 'L' }).then(setSrc);
  }, [data, size]);
  return src ? <img src={src} width={size} height={size} alt="e-Invoice QR" data-testid="irn-qr" /> : null;
}

/** e-Invoice (IRN + signed QR) and e-Way Bill number for a B2B bill. */
export function EinvoicePanel({ inv, company }: { inv: Invoice; company: Company }) {
  const canDo = useCan();
  const [ewb, setEwb] = useState(false);
  const [cancel, setCancel] = useState(false);
  const test = useAction('einvoice.test', { success: 'Test IRN generated' });
  if (!(inv.kind === 'sale' || inv.kind === 'sale_return') || !inv.party_gstin || !canDo('gst.view')) return null;
  const json = async () => {
    try {
      const r = await call('einvoice.json', { id: inv.id });
      if (r.problems.length) return toast.error(new Error(r.problems.join(' ')));
      downloadJson([r.json], `einvoice-${inv.number}.json`);
      toast.success('e-Invoice JSON downloaded', 'Upload it on einvoice1.gst.gov.in → Bulk Upload, then import the result file from GST → e-Invoice.');
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card space-y-3 p-4 text-sm" data-testid="einvoice-panel">
      <p className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4 text-primary" /> e-Invoice {inv.irn_test ? <Badge tone="warn">TEST — not valid</Badge> : null} {inv.irn_cancelled ? <Badge tone="bad">IRN cancelled</Badge> : null}</p>
      {inv.irn ? (
        <>
          <div className="break-all font-mono text-[11px] text-muted" data-testid="irn">IRN {inv.irn}</div>
          <div className="text-xs">Ack {inv.irn_ack_no} · {inv.irn_ack_date}</div>
          {inv.irn_qr && <SignedQr data={inv.irn_qr} />}
          {!inv.irn_cancelled && canDo('sale.cancel') && <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setCancel(true)}>Cancel IRN</Button>}
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {company.einvoice_mode === 'test' && <Button size="sm" variant="primary" icon={<QrCode className="h-3.5 w-3.5" />} loading={test.isPending} onClick={() => test.mutate({ id: inv.id })} data-testid="irn-test">Generate test IRN</Button>}
          <Button size="sm" variant="outline" icon={<FileJson className="h-3.5 w-3.5" />} onClick={json} data-testid="einvoice-json">e-Invoice JSON</Button>
        </div>
      )}
      <div className="border-t border-border pt-3">
        {inv.ewb_no ? (
          <p className="flex items-center gap-2"><Truck className="h-4 w-4" /> e-Way Bill <b className="font-mono" data-testid="ewb-no">{inv.ewb_no}</b> <span className="text-xs text-muted">{inv.ewb_date && fmtDate(inv.ewb_date)}{inv.ewb_valid_upto ? ` · valid till ${fmtDate(inv.ewb_valid_upto)}` : ''}</span></p>
        ) : (
          <Button size="sm" variant="ghost" icon={<Truck className="h-3.5 w-3.5" />} onClick={() => setEwb(true)} data-testid="ewb-record">Record e-Way Bill no.</Button>
        )}
      </div>
      {ewb && <EwbDialog id={inv.id} onClose={() => setEwb(false)} />}
      {cancel && <CancelIrnDialog id={inv.id} onClose={() => setCancel(false)} />}
    </div>
  );
}

function EwbDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [no, setNo] = useState('');
  const [upto, setUpto] = useState('');
  const save = useAction('ewaybill.set', { success: 'e-Way Bill number saved', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="e-Way Bill number" description="After generating it on ewaybillgst.gov.in (from the e-Way Bill JSON), note the number here so it prints on the bill." size="sm"
      footer={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate({ id, ewbNo: no, validUpto: upto || null })} data-testid="ewb-save">Save</Button>}>
      <div className="space-y-3">
        <Field label="e-Way Bill no. (12 digits)"><Input inputMode="numeric" value={no} onChange={(e) => setNo(e.target.value)} data-testid="ewb-input" /></Field>
        <Field label="Valid till"><Input type="date" value={upto} onChange={(e) => setUpto(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

function CancelIrnDialog({ id, onClose }: { id: number; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const cancel = useAction('einvoice.cancel', { success: 'IRN marked cancelled', onSuccess: onClose });
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} title="Cancel IRN" description="Allowed within 24 hours of generation. Cancel it on the e-invoice portal too, then cancel or correct the bill." size="sm"
      footer={<Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate({ id, reason })}>Cancel IRN</Button>}>
      <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong GSTIN, duplicate" /></Field>
    </Dialog>
  );
}
