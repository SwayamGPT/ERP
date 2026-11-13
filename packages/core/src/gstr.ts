import { type Paise, toRupees } from './money';

/**
 * GST return builders. Shapes follow the GSTN offline-tool JSON schema
 * (GSTR-1 including the 2025 split HSN table, GSTR-3B) and the NIC e-Way Bill bulk JSON.
 * All inputs are integer paise; outputs are rupees with 2 decimals as GSTN expects.
 */

export type GstDocType = 'sale' | 'sale_return' | 'purchase' | 'purchase_return';

export interface GstLine {
  hsn: string;
  description: string;
  uqc: string; // Unit Quantity Code, e.g. NOS, KGS, LTR, BOX
  qty: number;
  gstRate: number;
  taxable: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
}

export interface GstDoc {
  type: GstDocType;
  number: string;
  date: string; // ISO yyyy-mm-dd
  partyGstin: string | null;
  partyName: string;
  placeOfSupply: string; // 2-digit state code
  interState: boolean;
  total: Paise; // invoice value incl. tax and round-off
  cancelled?: boolean;
  lines: GstLine[];
}

const r = toRupees;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function gstDate(iso: string): string {
  return `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
}

/** "2026-10" → "102026" */
export function returnPeriod(yyyyMm: string): string {
  return `${yyyyMm.slice(5, 7)}${yyyyMm.slice(0, 4)}`;
}

interface TaxAcc {
  taxable: Paise;
  igst: Paise;
  cgst: Paise;
  sgst: Paise;
  cess: Paise;
}
const zero = (): TaxAcc => ({ taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 });
function add(acc: TaxAcc, l: TaxAcc, sign = 1) {
  acc.taxable += sign * l.taxable;
  acc.igst += sign * l.igst;
  acc.cgst += sign * l.cgst;
  acc.sgst += sign * l.sgst;
  acc.cess += sign * l.cess;
}

/** Group a document's lines by GST rate into GSTN `itms`. */
function itemsByRate(doc: GstDoc) {
  const m = new Map<number, TaxAcc>();
  for (const l of doc.lines) {
    const a = m.get(l.gstRate) ?? zero();
    add(a, l);
    m.set(l.gstRate, a);
  }
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rt, a], i) => ({
      num: i + 1,
      itm_det: { txval: r(a.taxable), rt, iamt: r(a.igst), camt: r(a.cgst), samt: r(a.sgst), csamt: r(a.cess) },
    }));
}

/** B2CL threshold: inter-state invoices to unregistered persons above ₹1,00,000 (from 1 Aug 2024). */
export const B2CL_LIMIT: Paise = 100000_00;

export function buildGstr1(opts: { gstin: string; period: string; docs: GstDoc[] }) {
  const sales = opts.docs.filter((d) => !d.cancelled && (d.type === 'sale' || d.type === 'sale_return'));

  const b2bMap = new Map<string, unknown[]>();
  const b2clMap = new Map<string, unknown[]>();
  const b2csMap = new Map<string, TaxAcc & { sply_ty: string; pos: string; rt: number }>();
  const cdnrMap = new Map<string, unknown[]>();
  const hsnB2b = new Map<string, TaxAcc & { hsn: string; desc: string; uqc: string; qty: number; rt: number }>();
  const hsnB2c = new Map<string, TaxAcc & { hsn: string; desc: string; uqc: string; qty: number; rt: number }>();

  for (const d of sales) {
    const registered = !!d.partyGstin;
    const isReturn = d.type === 'sale_return';
    const sign = isReturn ? -1 : 1;

    if (registered && !isReturn) {
      const list = b2bMap.get(d.partyGstin!) ?? [];
      list.push({
        inum: d.number,
        idt: gstDate(d.date),
        val: r(d.total),
        pos: d.placeOfSupply,
        rchrg: 'N',
        inv_typ: 'R',
        itms: itemsByRate(d),
      });
      b2bMap.set(d.partyGstin!, list);
    } else if (registered && isReturn) {
      const list = cdnrMap.get(d.partyGstin!) ?? [];
      list.push({
        ntty: 'C',
        nt_num: d.number,
        nt_dt: gstDate(d.date),
        val: r(d.total),
        pos: d.placeOfSupply,
        rchrg: 'N',
        inv_typ: 'R',
        itms: itemsByRate(d),
      });
      cdnrMap.set(d.partyGstin!, list);
    } else if (!isReturn && d.interState && d.total > B2CL_LIMIT) {
      const list = b2clMap.get(d.placeOfSupply) ?? [];
      list.push({ inum: d.number, idt: gstDate(d.date), val: r(d.total), itms: itemsByRate(d) });
      b2clMap.set(d.placeOfSupply, list);
    } else {
      // B2C small — aggregated by supply type, POS and rate; unregistered returns are netted here.
      for (const l of d.lines) {
        const sply_ty = d.interState ? 'INTER' : 'INTRA';
        const key = `${sply_ty}|${d.placeOfSupply}|${l.gstRate}`;
        const a = b2csMap.get(key) ?? { ...zero(), sply_ty, pos: d.placeOfSupply, rt: l.gstRate };
        add(a, l, sign);
        b2csMap.set(key, a);
      }
    }

    const hsnMap = registered ? hsnB2b : hsnB2c;
    for (const l of d.lines) {
      const key = `${l.hsn}|${l.gstRate}|${l.uqc}`;
      const a = hsnMap.get(key) ?? { ...zero(), hsn: l.hsn, desc: l.description, uqc: l.uqc, qty: 0, rt: l.gstRate };
      add(a, l, sign);
      a.qty = round2(a.qty + sign * l.qty);
      hsnMap.set(key, a);
    }
  }

  const hsnRows = (m: typeof hsnB2b) =>
    [...m.values()].map((a, i) => ({
      num: i + 1,
      hsn_sc: a.hsn,
      desc: a.desc.slice(0, 30),
      uqc: a.uqc,
      qty: a.qty,
      rt: a.rt,
      txval: r(a.taxable),
      iamt: r(a.igst),
      camt: r(a.cgst),
      samt: r(a.sgst),
      csamt: r(a.cess),
    }));

  // Document series summary (Table 13)
  const docSeries = (types: GstDocType[], docNum: number) => {
    const docs = opts.docs.filter((d) => types.includes(d.type)).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
    if (!docs.length) return null;
    const cancel = docs.filter((d) => d.cancelled).length;
    return {
      doc_num: docNum,
      docs: [{ num: 1, from: docs[0].number, to: docs[docs.length - 1].number, totnum: docs.length, cancel, net_issue: docs.length - cancel }],
    };
  };

  const out: Record<string, unknown> = {
    gstin: opts.gstin,
    fp: returnPeriod(opts.period),
    version: 'GST3.2.1',
    hash: 'hash',
  };
  if (b2bMap.size) out.b2b = [...b2bMap.entries()].map(([ctin, inv]) => ({ ctin, inv }));
  if (b2clMap.size) out.b2cl = [...b2clMap.entries()].map(([pos, inv]) => ({ pos, inv }));
  if (b2csMap.size)
    out.b2cs = [...b2csMap.values()].map((a) => ({
      sply_ty: a.sply_ty,
      pos: a.pos,
      typ: 'OE',
      rt: a.rt,
      txval: r(a.taxable),
      iamt: r(a.igst),
      camt: r(a.cgst),
      samt: r(a.sgst),
      csamt: r(a.cess),
    }));
  if (cdnrMap.size) out.cdnr = [...cdnrMap.entries()].map(([ctin, nt]) => ({ ctin, nt }));
  if (hsnB2b.size || hsnB2c.size) out.hsn = { hsn_b2b: hsnRows(hsnB2b), hsn_b2c: hsnRows(hsnB2c) };
  const docDet = [docSeries(['sale'], 1), docSeries(['sale_return'], 5)].filter(Boolean);
  if (docDet.length) out.doc_issue = { doc_det: docDet };
  return out;
}

export function buildGstr3b(opts: { gstin: string; period: string; docs: GstDoc[] }) {
  const live = opts.docs.filter((d) => !d.cancelled);
  const osup = zero();
  const nil = zero();
  const itc = zero();
  const unreg = new Map<string, TaxAcc>();

  for (const d of live) {
    const sign = d.type === 'sale_return' || d.type === 'purchase_return' ? -1 : 1;
    if (d.type === 'sale' || d.type === 'sale_return') {
      for (const l of d.lines) {
        if (l.gstRate === 0) add(nil, l, sign);
        else add(osup, l, sign);
        if (d.interState && !d.partyGstin && l.gstRate > 0) {
          const a = unreg.get(d.placeOfSupply) ?? zero();
          add(a, l, sign);
          unreg.set(d.placeOfSupply, a);
        }
      }
    } else {
      for (const l of d.lines) add(itc, l, sign);
    }
  }

  const t = (a: TaxAcc) => ({ txval: r(a.taxable), iamt: r(a.igst), camt: r(a.cgst), samt: r(a.sgst), csamt: r(a.cess) });
  const tax = (a: TaxAcc) => ({ iamt: r(a.igst), camt: r(a.cgst), samt: r(a.sgst), csamt: r(a.cess) });
  const none = { iamt: 0, camt: 0, samt: 0, csamt: 0 };

  return {
    gstin: opts.gstin,
    ret_period: returnPeriod(opts.period),
    sup_details: {
      osup_det: t(osup),
      osup_zero: { txval: 0, iamt: 0, csamt: 0 },
      osup_nil_exmp: { txval: r(nil.taxable) },
      isup_rev: { txval: 0, ...none },
      osup_nongst: { txval: 0 },
    },
    inter_sup: {
      unreg_details: [...unreg.entries()].map(([pos, a]) => ({ pos, txval: r(a.taxable), iamt: r(a.igst) })),
      comp_details: [],
      uin_details: [],
    },
    itc_elg: {
      itc_avl: [
        { ty: 'IMPG', ...none },
        { ty: 'IMPS', ...none },
        { ty: 'ISRC', ...none },
        { ty: 'ISD', ...none },
        { ty: 'OTH', ...tax(itc) },
      ],
      itc_rev: [
        { ty: 'RUL', ...none },
        { ty: 'OTH', ...none },
      ],
      itc_net: tax(itc),
      itc_inelg: [
        { ty: 'RUL', ...none },
        { ty: 'OTH', ...none },
      ],
    },
  };
}

/** Net tax payable after ITC, by head (paise). Negative means carry-forward credit. */
export function netTaxPayable(docs: GstDoc[]) {
  const out = zero();
  const itc = zero();
  for (const d of docs) {
    if (d.cancelled) continue;
    const sign = d.type === 'sale_return' || d.type === 'purchase_return' ? -1 : 1;
    for (const l of d.lines) add(d.type === 'sale' || d.type === 'sale_return' ? out : itc, l, sign);
  }
  return {
    output: out,
    itc,
    payable: { igst: out.igst - itc.igst, cgst: out.cgst - itc.cgst, sgst: out.sgst - itc.sgst, cess: out.cess - itc.cess },
  };
}

/* ───────────────────────────── e-Way Bill ───────────────────────────── */

/** e-Way Bill is mandatory for movement of goods above ₹50,000 consignment value. */
export const EWAY_LIMIT: Paise = 50000_00;

export interface EwayParty {
  gstin: string | null;
  name: string;
  address: string;
  place: string;
  pincode: string;
  stateCode: string;
}

export interface EwayTransport {
  mode: 1 | 2 | 3 | 4; // Road, Rail, Air, Ship
  distanceKm: number;
  vehicleNo?: string;
  transporterId?: string;
  transporterName?: string;
}

export function buildEwayBill(opts: { doc: GstDoc; from: EwayParty; to: EwayParty; transport: EwayTransport }) {
  const { doc, from, to, transport } = opts;
  const acc = zero();
  for (const l of doc.lines) add(acc, l);
  const item = (l: GstLine, i: number) => ({
    itemNo: i + 1,
    productName: l.description.slice(0, 100),
    productDesc: l.description.slice(0, 100),
    hsnCode: Number(l.hsn),
    quantity: l.qty,
    qtyUnit: l.uqc,
    taxableAmount: r(l.taxable),
    sgstRate: doc.interState ? 0 : l.gstRate / 2,
    cgstRate: doc.interState ? 0 : l.gstRate / 2,
    igstRate: doc.interState ? l.gstRate : 0,
    cessRate: 0,
    cessNonAdvol: 0,
  });
  return {
    version: '1.0.0621',
    billLists: [
      {
        userGstin: from.gstin,
        supplyType: 'O',
        subSupplyType: 1,
        subSupplyDesc: '',
        docType: 'INV',
        docNo: doc.number,
        docDate: gstDate(doc.date).replace(/-/g, '/'),
        fromGstin: from.gstin ?? 'URP',
        fromTrdName: from.name,
        fromAddr1: from.address,
        fromAddr2: '',
        fromPlace: from.place,
        fromPincode: Number(from.pincode) || 0,
        fromStateCode: Number(from.stateCode),
        actFromStateCode: Number(from.stateCode),
        toGstin: to.gstin ?? 'URP',
        toTrdName: to.name,
        toAddr1: to.address,
        toAddr2: '',
        toPlace: to.place,
        toPincode: Number(to.pincode) || 0,
        toStateCode: Number(to.stateCode),
        actToStateCode: Number(to.stateCode),
        transactionType: 1,
        totalValue: r(acc.taxable),
        cgstValue: r(acc.cgst),
        sgstValue: r(acc.sgst),
        igstValue: r(acc.igst),
        cessValue: r(acc.cess),
        cessNonAdvolValue: 0,
        otherValue: round2(r(doc.total) - r(acc.taxable + acc.cgst + acc.sgst + acc.igst + acc.cess)),
        totInvValue: r(doc.total),
        transMode: transport.mode,
        transDistance: transport.distanceKm,
        transporterName: transport.transporterName ?? '',
        transporterId: transport.transporterId ?? '',
        transDocNo: '',
        transDocDate: '',
        vehicleNo: (transport.vehicleNo ?? '').replace(/\s/g, '').toUpperCase(),
        vehicleType: 'R',
        itemList: doc.lines.map(item),
      },
    ],
  };
}
