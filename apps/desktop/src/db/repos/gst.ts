import { buildEinvoice, einvFromDoc, einvoiceProblems, irnFor, parseGstr2b, reconcile2b, sha256Hex, uqcFor, type BookDoc, type EinvDoc, type IrnResult } from '@hisaab/core';
import type { Company } from '../types';
import { AppError, audit, guard, localNow, type Ctx } from './base';
import { mustCompany } from './company';

/* ───────── e-Invoice ───────── */

function einvDoc(ctx: Ctx, invoiceId: number): { doc: EinvDoc; company: Company; inv: { id: number; number: string; kind: string; status: string; irn: string | null; date: string } } {
  const company = mustCompany(ctx);
  const inv = ctx.db.get<{ id: number; kind: string; number: string; date: string; status: string; party_id: number; place_of_supply: string; inter_state: number; total: number; other_charges: number; round_off: number; irn: string | null }>(
    'SELECT id, kind, number, date, status, party_id, place_of_supply, inter_state, total, other_charges, round_off, irn FROM invoices WHERE id = ?',
    [invoiceId],
  );
  if (!inv) throw new AppError('Bill not found.');
  if (inv.kind !== 'sale' && inv.kind !== 'sale_return') throw new AppError('e-Invoices are for sales bills and credit notes.');
  const p = ctx.db.get<{ name: string; gstin: string | null; address: string | null; city: string | null; pincode: string | null; state_code: string | null; phone: string | null }>(
    'SELECT name, gstin, address, city, pincode, state_code, phone FROM parties WHERE id = ?',
    [inv.party_id],
  )!;
  const lines = ctx.db.query<{ name: string; hsn: string | null; qty: number; factor: number; rate: number; gross: number; discount: number; taxable: number; gst_rate: number; cess_rate: number; cgst: number; sgst: number; igst: number; cess: number; total: number; base_unit: string; tax_inclusive: number }>(
    'SELECT l.*, it.base_unit FROM invoice_lines l JOIN items it ON it.id = l.item_id WHERE l.invoice_id = ? ORDER BY l.id',
    [invoiceId],
  );
  const doc = einvFromDoc(
    {
      type: inv.kind as 'sale', number: inv.number, date: inv.date, partyGstin: p.gstin, partyName: p.name, placeOfSupply: inv.place_of_supply, interState: !!inv.inter_state, total: inv.total,
      lines: lines.map((l) => {
        const qty = Math.round(l.qty * l.factor * 1000) / 1000;
        // IRP wants the price before tax and discount; for tax-inclusive bills derive it from the taxable value.
        const gross = l.tax_inclusive ? l.taxable + l.discount : l.gross;
        return { hsn: (l.hsn ?? '').replace(/\D/g, ''), description: l.name, uqc: uqcFor(l.base_unit), qty, gstRate: l.gst_rate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, cess: l.cess, unitPrice: qty ? Math.round(gross / qty) : gross, gross, discount: l.discount, cessRate: l.cess_rate, total: l.total };
      }),
    },
    { gstin: company.gstin ?? '', legalName: company.legal_name || company.name, tradeName: company.name, address: company.address ?? '', place: company.city ?? '', pincode: company.pincode ?? '', stateCode: company.state_code, phone: company.phone, email: company.email },
    { gstin: p.gstin ?? '', legalName: p.name, address: p.address ?? '', place: p.city ?? '', pincode: p.pincode ?? '', stateCode: p.state_code ?? inv.place_of_supply, phone: p.phone },
    { otherCharges: inv.other_charges, roundOff: inv.round_off },
  );
  return { doc, company, inv };
}

/** The e-invoice JSON for one bill, with anything that would make the IRP reject it. */
export function einvoiceJson(ctx: Ctx, invoiceId: number) {
  guard(ctx, 'gst.view');
  const { doc, inv } = einvDoc(ctx, invoiceId);
  return { number: inv.number, problems: einvoiceProblems(doc), json: buildEinvoice(doc) };
}

/** Every B2B sale / credit note of a month that still needs an IRN: one JSON array for bulk upload on the portal. */
export function einvoiceBulk(ctx: Ctx, period: string) {
  guard(ctx, 'gst.view');
  const ids = ctx.db.query<{ id: number }>(
    `SELECT i.id FROM invoices i JOIN parties p ON p.id = i.party_id WHERE i.kind IN ('sale','sale_return') AND i.status = 'final' AND i.irn IS NULL
       AND p.gstin IS NOT NULL AND p.gstin <> '' AND substr(i.date, 1, 7) = ? ORDER BY i.date, i.id`,
    [period],
  );
  const ok: unknown[] = [];
  const skipped: Array<{ number: string; problems: string[] }> = [];
  for (const { id } of ids) {
    const { doc, inv } = einvDoc(ctx, id);
    const problems = einvoiceProblems(doc);
    if (problems.length) skipped.push({ number: inv.number, problems });
    else ok.push(buildEinvoice(doc));
  }
  return { json: ok, count: ok.length, skipped };
}

/** Attach IRNs from the portal's response file (or a provider) to the matching bills. */
export function applyIrns(ctx: Ctx, input: { results: IrnResult[]; test?: boolean }) {
  guard(ctx, 'gst.view');
  const company = mustCompany(ctx);
  let applied = 0;
  const unknown: string[] = [];
  ctx.db.transaction(() => {
    for (const r of input.results) {
      const inv = ctx.db.get<{ id: number; number: string; date: string; kind: string }>(
        "SELECT id, number, date, kind FROM invoices WHERE kind IN ('sale','sale_return') AND status = 'final' AND number = ?",
        [r.docNo],
      ) ?? ctx.db.query<{ id: number; number: string; date: string; kind: string }>("SELECT id, number, date, kind FROM invoices WHERE kind IN ('sale','sale_return') AND status = 'final' AND irn IS NULL").find(
        (i) => irnFor(company.gstin ?? '', i.kind === 'sale' ? 'INV' : 'CRN', i.number, i.date) === r.irn,
      );
      if (!inv) {
        unknown.push(r.docNo || r.irn.slice(0, 12));
        continue;
      }
      ctx.db.exec('UPDATE invoices SET irn = ?, irn_ack_no = ?, irn_ack_date = ?, irn_qr = ?, irn_test = ?, irn_cancelled = 0, ewb_no = COALESCE(?, ewb_no) WHERE id = ?', [
        r.irn, r.ackNo, r.ackDate, r.signedQr, input.test ? 1 : 0, r.ewbNo ?? null, inv.id,
      ]);
      audit(ctx, 'einvoice.irn', 'invoice', inv.id, { irn: r.irn, test: !!input.test });
      applied++;
    }
  });
  return { applied, unknown };
}

/**
 * Test mode: a stand-in for the IRP so the whole flow (IRN, acknowledgement, signed QR on the bill)
 * can be tried before connecting a GST Suvidha Provider. Bills are clearly marked as test.
 */
export function generateTestIrn(ctx: Ctx, invoiceId: number) {
  guard(ctx, 'gst.view');
  const { doc, company, inv } = einvDoc(ctx, invoiceId);
  if (company.einvoice_mode !== 'test') throw new AppError('Turn on e-invoice test mode in Settings → Business first.');
  if (inv.irn) throw new AppError('This bill already has an IRN.');
  const problems = einvoiceProblems(doc);
  if (problems.length) throw new AppError(problems.join(' '));
  const irn = irnFor(doc.seller.gstin, doc.type, doc.number, doc.date);
  const ackNo = String(BigInt(`0x${sha256Hex(irn).slice(0, 12)}`)).slice(0, 15).padStart(15, '1');
  const payload = { TEST: 'NOT A VALID e-INVOICE', SellerGstin: doc.seller.gstin, BuyerGstin: doc.buyer.gstin, DocNo: doc.number, DocTyp: doc.type, DocDt: doc.date, TotInvVal: doc.total / 100, ItemCnt: doc.lines.length, Irn: irn };
  const signedQr = `TEST.${btoa(JSON.stringify(payload))}.TEST`;
  return applyIrns(ctx, { results: [{ docNo: doc.number, irn, ackNo, ackDate: localNow(), signedQr }], test: true });
}

/** The IRP allows cancelling within 24 hours (cancel on the portal too when not in test mode). */
export function cancelIrn(ctx: Ctx, input: { id: number; reason: string }) {
  guard(ctx, 'sale.cancel');
  const inv = ctx.db.get<{ irn: string | null; irn_ack_date: string | null; irn_test: number }>('SELECT irn, irn_ack_date, irn_test FROM invoices WHERE id = ?', [input.id]);
  if (!inv?.irn) throw new AppError('This bill has no IRN.');
  if (!input.reason?.trim()) throw new AppError('Give the reason for cancelling the IRN.');
  if (!inv.irn_test && inv.irn_ack_date && Date.now() - Date.parse(inv.irn_ack_date.replace(' ', 'T')) > 24 * 3600 * 1000) {
    throw new AppError('An IRN can only be cancelled within 24 hours. Issue a credit note instead.');
  }
  ctx.db.exec('UPDATE invoices SET irn_cancelled = 1 WHERE id = ?', [input.id]);
  audit(ctx, 'einvoice.cancel', 'invoice', input.id, { reason: input.reason });
  return true;
}

/** Record the e-Way Bill number generated on the portal (from the JSON Hisaab prepared). */
export function setEwayBill(ctx: Ctx, input: { id: number; ewbNo: string; ewbDate?: string; validUpto?: string | null }) {
  guard(ctx, 'gst.view');
  const no = input.ewbNo.replace(/\s/g, '');
  if (!/^\d{12}$/.test(no)) throw new AppError('An e-Way Bill number has 12 digits.');
  ctx.db.exec('UPDATE invoices SET ewb_no = ?, ewb_date = ?, ewb_valid_upto = ? WHERE id = ?', [no, input.ewbDate ?? ctx.today(), input.validUpto ?? null, input.id]);
  audit(ctx, 'ewaybill.set', 'invoice', input.id, { ewbNo: no });
  return true;
}

/* ───────── GSTR-2B ───────── */

export function importGstr2b(ctx: Ctx, input: { json: unknown }) {
  guard(ctx, 'gst.view');
  const company = mustCompany(ctx);
  const p = parseGstr2b(input.json);
  if (!p.period) throw new AppError('The file has no return period.');
  if (company.gstin && p.gstin && p.gstin !== company.gstin) throw new AppError(`This GSTR-2B is for ${p.gstin}, not your GSTIN ${company.gstin}.`);
  ctx.db.transaction(() => {
    ctx.db.exec('DELETE FROM gstr2b_rows WHERE period = ?', [p.period]);
    const now = localNow();
    for (const r of p.rows) {
      ctx.db.exec('INSERT INTO gstr2b_rows (period, kind, ctin, supplier, doc_no, doc_date, value, taxable, igst, cgst, sgst, cess, itc_available, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        p.period, r.kind, r.ctin, r.supplier, r.docNo, r.date, r.value, r.taxable, r.igst, r.cgst, r.sgst, r.cess, r.itcAvailable ? 1 : 0, now,
      ]);
    }
    audit(ctx, 'gstr2b.import', 'gstr2b', undefined, { period: p.period, rows: p.rows.length });
  });
  return { period: p.period, rows: p.rows.length };
}

/** Reconcile a month's GSTR-2B with purchase bills and expense GST bills. */
export function gstr2bRecon(ctx: Ctx, period: string) {
  guard(ctx, 'gst.view');
  const rows = ctx.db.query<{ kind: 'inv' | 'cn' | 'dn'; ctin: string; supplier: string; doc_no: string; doc_date: string; value: number; taxable: number; igst: number; cgst: number; sgst: number; cess: number; itc_available: number }>(
    'SELECT * FROM gstr2b_rows WHERE period = ? ORDER BY doc_date, id',
    [period],
  );
  const from = ctx.db.get<{ d: string }>("SELECT date(?, '-2 months') AS d", [`${period}-01`])!.d;
  const to = `${period}-31`;
  const books: BookDoc[] = [
    ...ctx.db.query<BookDoc>(
      `SELECT 'purchase' AS source, id, party_gstin AS gstin, COALESCE(supplier_bill_no, number) AS docNo, date, total AS value, cgst + sgst + igst + cess AS tax
       FROM invoices WHERE kind = 'purchase' AND status = 'final' AND no_bill = 0 AND party_gstin IS NOT NULL AND party_gstin <> '' AND date BETWEEN ? AND ?`,
      [from, to],
    ),
    ...ctx.db.query<BookDoc>(
      `SELECT 'expense' AS source, id, payee_gstin AS gstin, COALESCE(bill_no, '') AS docNo, date, amount AS value, cgst + sgst + igst AS tax
       FROM expenses WHERE itc = 1 AND status <> 'cancelled' AND payee_gstin IS NOT NULL AND date BETWEEN ? AND ?`,
      [from, to],
    ),
  ];
  const recon = reconcile2b(
    rows.map((r) => ({ kind: r.kind, ctin: r.ctin, supplier: r.supplier, docNo: r.doc_no, date: r.doc_date, value: r.value, taxable: r.taxable, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: r.cess, itcAvailable: !!r.itc_available })),
    books,
  ).filter((x) => x.status !== 'missing_in_2b' || x.book!.date >= `${period}-01`);
  const tax = (r: (typeof recon)[number]) => (r.twoB ? r.twoB.igst + r.twoB.cgst + r.twoB.sgst + r.twoB.cess : 0);
  const sum = (s: string) => recon.filter((r) => r.status === s);
  return {
    period,
    imported: rows.length > 0,
    rows: recon,
    summary: {
      itcIn2b: recon.reduce((a, r) => a + tax(r), 0),
      matched: sum('matched').length,
      mismatch: sum('mismatch').length,
      missingInBooks: sum('missing_in_books').length,
      missingIn2b: sum('missing_in_2b').length,
      atRisk: sum('missing_in_2b').reduce((a, r) => a + r.book!.tax, 0),
    },
  };
}
