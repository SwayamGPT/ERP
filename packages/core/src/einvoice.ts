import { sha256Hex } from './sha256';
import { gstDate, type GstDoc } from './gstr';
import { toRupees } from './money';

/**
 * e-Invoice (IRN) — the NIC / IRP schema version 1.1 ("INV-01"). The same JSON is used two ways:
 * uploaded in bulk on the e-invoice portal (no API needed), or sent through a GST Suvidha Provider.
 * Amounts are rupees with 2 decimals; dates dd/mm/yyyy.
 */

export interface EinvParty {
  gstin: string;
  legalName: string;
  tradeName?: string;
  address: string;
  place: string;
  pincode: string;
  stateCode: string;
  phone?: string | null;
  email?: string | null;
}

export interface EinvLine {
  description: string;
  hsn: string;
  qty: number;
  uqc: string;
  unitPrice: number; // paise, excl. tax
  gross: number; // paise, qty × unit price
  discount: number; // paise
  taxable: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  cessRate: number;
  total: number;
}

export interface EinvDoc {
  type: 'INV' | 'CRN' | 'DBN';
  number: string;
  date: string; // yyyy-mm-dd
  seller: EinvParty;
  buyer: EinvParty;
  placeOfSupply: string;
  interState: boolean;
  lines: EinvLine[];
  otherCharges: number;
  roundOff: number;
  total: number;
}

const r = (p: number) => toRupees(p);

/** Problems that would make the IRP reject the invoice, in plain words. */
export function einvoiceProblems(d: EinvDoc): string[] {
  const out: string[] = [];
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(d.seller.gstin)) out.push('Your GSTIN is missing or invalid.');
  if (!/^[0-9]{2}[A-Z0-9]{13}$/.test(d.buyer.gstin)) out.push('e-Invoices are for registered (B2B) customers: the customer GSTIN is missing.');
  if (!/^[A-Za-z0-9/-]{1,16}$/.test(d.number)) out.push(`Bill number “${d.number}” must be at most 16 letters, digits, / or -.`);
  if (!/^\d{6}$/.test(d.seller.pincode)) out.push('Your shop PIN code is missing.');
  if (!/^\d{6}$/.test(d.buyer.pincode)) out.push("The customer's PIN code is missing.");
  if (!d.buyer.address.trim()) out.push("The customer's address is missing.");
  d.lines.forEach((l, i) => {
    if (!/^\d{4,8}$/.test(l.hsn)) out.push(`Line ${i + 1} (${l.description}): HSN code must be 4–8 digits.`);
  });
  return out;
}

export function buildEinvoice(d: EinvDoc) {
  const sum = (k: keyof EinvLine) => d.lines.reduce((a, l) => a + (l[k] as number), 0);
  const party = (p: EinvParty, pos?: string) => ({
    Gstin: p.gstin,
    LglNm: p.legalName.slice(0, 100),
    ...(p.tradeName ? { TrdNm: p.tradeName.slice(0, 100) } : {}),
    ...(pos ? { Pos: pos } : {}),
    Addr1: p.address.slice(0, 100),
    Loc: p.place.slice(0, 50),
    Pin: Number(p.pincode),
    Stcd: p.stateCode,
    ...(p.phone ? { Ph: p.phone.replace(/\D/g, '').slice(-10) } : {}),
    ...(p.email ? { Em: p.email } : {}),
  });
  return {
    Version: '1.1',
    TranDtls: { TaxSch: 'GST', SupTyp: 'B2B', RegRev: 'N', IgstOnIntra: 'N' },
    DocDtls: { Typ: d.type, No: d.number, Dt: gstDate(d.date).replace(/-/g, '/') },
    SellerDtls: party(d.seller),
    BuyerDtls: party(d.buyer, d.placeOfSupply),
    ItemList: d.lines.map((l, i) => ({
      SlNo: String(i + 1),
      PrdDesc: l.description.slice(0, 300),
      IsServc: 'N',
      HsnCd: l.hsn,
      Qty: Math.round(l.qty * 1000) / 1000,
      Unit: l.uqc,
      UnitPrice: Math.round(l.unitPrice) / 100,
      TotAmt: r(l.gross),
      Discount: r(l.discount),
      AssAmt: r(l.taxable),
      GstRt: l.gstRate,
      IgstAmt: r(l.igst),
      CgstAmt: r(l.cgst),
      SgstAmt: r(l.sgst),
      CesRt: l.cessRate,
      CesAmt: r(l.cess),
      TotItemVal: r(l.total),
    })),
    ValDtls: {
      AssVal: r(sum('taxable')),
      CgstVal: r(sum('cgst')),
      SgstVal: r(sum('sgst')),
      IgstVal: r(sum('igst')),
      CesVal: r(sum('cess')),
      OthChrg: r(d.otherCharges),
      RndOffAmt: r(d.roundOff),
      TotInvVal: r(d.total),
    },
  };
}

/**
 * The Invoice Reference Number: SHA-256 of seller GSTIN + financial year + document type + number,
 * as the IRP computes it. Used to match portal responses and by the test provider.
 */
export function irnFor(sellerGstin: string, docType: string, number: string, isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  return sha256Hex(`${sellerGstin}${fy}${docType}${number}`);
}

/** What the e-invoice portal's bulk download (or a GSP) returns per document, in the shapes we accept. */
export interface IrnResult {
  docNo: string;
  irn: string;
  ackNo: string;
  ackDate: string;
  signedQr: string;
  ewbNo?: string | null;
}

/** Read the IRP's response JSON (bulk-upload result file, or a GSP response) into results. */
export function parseIrpResponse(json: unknown): IrnResult[] {
  const list = Array.isArray(json) ? json : (json as { data?: unknown; results?: unknown })?.data ?? (json as { results?: unknown })?.results ?? [json];
  const out: IrnResult[] = [];
  for (const raw of Array.isArray(list) ? list : [list]) {
    const x = (raw as { Data?: unknown; data?: unknown }).Data ?? (raw as { data?: unknown }).data ?? raw;
    const o = (typeof x === 'string' ? JSON.parse(x) : x) as Record<string, unknown>;
    const irn = (o.Irn ?? o.irn) as string | undefined;
    const qr = (o.SignedQRCode ?? o.signedQRCode ?? o.SignedQrCode) as string | undefined;
    const docNo = (o.DocNo ?? o.docNo ?? (o.DocDtls as { No?: string })?.No) as string | undefined;
    if (!irn || !qr) continue;
    out.push({ docNo: docNo ?? '', irn, ackNo: String(o.AckNo ?? o.ackNo ?? ''), ackDate: String(o.AckDt ?? o.ackDt ?? ''), signedQr: qr, ewbNo: (o.EwbNo ?? o.ewbNo ?? null) as string | null });
  }
  return out;
}

/** Map a GstDoc (from the books) and parties to the e-invoice input. */
type DocLine = GstDoc['lines'][number] & { unitPrice?: number; gross?: number; discount?: number; cessRate?: number; total?: number };
export function einvFromDoc(doc: Omit<GstDoc, 'lines'> & { lines: DocLine[] }, seller: EinvParty, buyer: EinvParty, extra: { otherCharges?: number; roundOff?: number } = {}): EinvDoc {
  return {
    type: doc.type === 'sale_return' ? 'CRN' : 'INV',
    number: doc.number,
    date: doc.date,
    seller,
    buyer,
    placeOfSupply: doc.placeOfSupply,
    interState: doc.interState,
    otherCharges: extra.otherCharges ?? 0,
    roundOff: extra.roundOff ?? 0,
    total: doc.total,
    lines: doc.lines.map((l) => {
      const tax = l.cgst + l.sgst + l.igst + l.cess;
      return {
        description: l.description, hsn: l.hsn, qty: l.qty, uqc: l.uqc, gstRate: l.gstRate, taxable: l.taxable, cgst: l.cgst, sgst: l.sgst, igst: l.igst, cess: l.cess,
        unitPrice: l.unitPrice ?? (l.qty ? Math.round(l.taxable / l.qty) : l.taxable), gross: l.gross ?? l.taxable, discount: l.discount ?? 0, cessRate: l.cessRate ?? 0, total: l.total ?? l.taxable + tax,
      };
    }),
  };
}
