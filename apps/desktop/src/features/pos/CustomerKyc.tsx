import { formatINR, isPan, panFromGstin, validateGstin } from '@hisaab/core';
import { IdCard } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, Field, Input, toast } from '../../components/ui';
import { call } from '../../db/client';
import type { Party } from '../../db/types';

/**
 * Bills at or above the owner's limit (₹50,000 by default) need the buyer's name and PAN or GSTIN.
 * Fill them in here without leaving the bill: a "Cash" bill gets a new customer, a picked customer
 * gets the missing details. Then the bill saves.
 */
export function CustomerKycDialog({ party, limit, onClose, onDone }: { party: Party | null; limit: number; onClose: () => void; onDone: (p: Party) => void }) {
  const known = party && !party.is_walkin ? party : null;
  const [name, setName] = useState(known?.name ?? '');
  const [phone, setPhone] = useState(known?.phone ?? '');
  const [pan, setPan] = useState(known?.pan ?? '');
  const [gstin, setGstin] = useState(known?.gstin ?? '');
  const [busy, setBusy] = useState(false);
  const panErr = pan && !isPan(pan) ? 'PAN is 10 characters, like ABCDE1234F' : null;
  const gstErr = gstin && !validateGstin(gstin) ? 'GSTIN looks wrong' : null;
  const ok = name.trim() && !panErr && !gstErr && (pan || gstin);
  const save = async () => {
    setBusy(true);
    try {
      // Keep everything else the customer record has (address, credit limit…).
      const id = await call('parties.save', {
        ...(known ?? {}),
        id: known?.id,
        kind: 'customer',
        name: name.trim(),
        phone: phone.trim() || null,
        pan: pan || (gstin ? panFromGstin(gstin) : null),
        gstin: gstin || null,
      } as never);
      onDone(await call('parties.get', { id: id as number }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()} size="sm" title={<span className="flex items-center gap-2"><IdCard className="h-4 w-4" /> Customer details needed</span>}
      description={`Bills of ${formatINR(limit, { decimals: false })} or more need the customer's name and their PAN or GSTIN.`}
      footer={<><Button variant="ghost" onClick={onClose}>Back to the bill</Button><Button variant="primary" loading={busy} disabled={!ok} onClick={() => void save()} data-testid="kyc-save">Save and bill</Button></>}>
      <div className="space-y-3" data-testid="kyc-dialog">
        <Field label="Customer name *"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="kyc-name" /></Field>
        <Field label="Mobile"><Input value={phone} inputMode="tel" onChange={(e) => setPhone(e.target.value.replace(/[^\d+ ]/g, ''))} data-testid="kyc-phone" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="PAN" error={panErr}><Input value={pan} className="font-mono" placeholder="ABCDE1234F" onChange={(e) => setPan(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10))} data-testid="kyc-pan" /></Field>
          <Field label="or GSTIN" error={gstErr}><Input value={gstin} className="font-mono" onChange={(e) => setGstin(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15))} data-testid="kyc-gstin" /></Field>
        </div>
      </div>
    </Dialog>
  );
}
