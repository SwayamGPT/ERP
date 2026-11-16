/**
 * TallyPrime / Tally.ERP 9 import XML ("Import Data" envelopes), so a shop's Chartered Accountant
 * can pull a month of Hisaab into the Tally company they already file GST from.
 *
 * Two files: masters (units, stock groups, stock items, ledgers with opening balances) and
 * vouchers (Sales / Purchase with item lines, Credit / Debit Notes, Receipts, Payments, Contra,
 * Journals). Import masters first. Amounts here are in paise with + = debit; this module turns
 * them into Tally's convention (debit amounts negative, ISDEEMEDPOSITIVE Yes).
 */

export type TallyVoucherType = 'Sales' | 'Purchase' | 'Credit Note' | 'Debit Note' | 'Receipt' | 'Payment' | 'Contra' | 'Journal';

export interface TallyLedger {
  name: string;
  /** A Tally group: Sundry Debtors, Sales Accounts, Duties & Taxes, Bank Accounts… */
  parent: string;
  /** Opening balance in paise, + = debit. */
  opening?: number;
  gstin?: string | null;
  state?: string | null;
  address?: string | null;
  phone?: string | null;
  /** For GST ledgers under Duties & Taxes. */
  dutyHead?: 'CGST' | 'SGST/UTGST' | 'IGST' | 'Cess';
  billWise?: boolean;
}

export interface TallyUnit {
  name: string;
  decimals: number;
}

export interface TallyStockItem {
  name: string;
  group?: string | null;
  unit: string;
  hsn?: string | null;
  gstRate?: number | null;
}

export interface TallyEntry {
  ledger: string;
  /** paise, + = debit */
  amount: number;
  party?: boolean;
  bill?: { name: string; type: 'New Ref' | 'Agst Ref' | 'On Account' };
}

export interface TallyInventory {
  item: string;
  unit: string;
  /** Quantity that moves (billed + free), in the item's base unit. */
  qty: number;
  billedQty: number;
  /** paise, + = debit (stock coming in: purchases, sales returns) */
  amount: number;
  /** The sales / purchase ledger this line's value goes to. */
  ledger: string;
}

export interface TallyVoucher {
  type: TallyVoucherType;
  /** Stable id so re-importing the same voucher alters it instead of duplicating. */
  remoteId: string;
  number: string;
  /** yyyy-mm-dd */
  date: string;
  reference?: string | null;
  narration?: string | null;
  party?: string | null;
  partyGstin?: string | null;
  placeOfSupply?: string | null;
  entries: TallyEntry[];
  inventory?: TallyInventory[];
}

export const xmlEscape = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Tally amount text: paise with + = debit → rupees with debit negative. */
export const tallyAmount = (paise: number) => {
  const v = -paise;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

const tallyDate = (d: string) => d.replace(/-/g, '');
const qtyText = (q: number, unit: string) => ` ${+q.toFixed(3)} ${unit}`;
const t = (tag: string, v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? '' : `<${tag}>${xmlEscape(String(v))}</${tag}>`);
const yes = (b: boolean) => (b ? 'Yes' : 'No');

function envelope(report: 'All Masters' | 'Vouchers', messages: string[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>',
    '<BODY><IMPORTDATA>',
    `<REQUESTDESC><REPORTNAME>${report}</REPORTNAME></REQUESTDESC>`,
    '<REQUESTDATA>',
    ...messages.map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`),
    '</REQUESTDATA>',
    '</IMPORTDATA></BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n');
}

const named = (tag: string, name: string, body: string) => `<${tag} NAME="${xmlEscape(name)}" ACTION="Create"><NAME.LIST><NAME>${xmlEscape(name)}</NAME></NAME.LIST>${body}</${tag}>`;

export function tallyMastersXml(m: { units: TallyUnit[]; groups: string[]; items: TallyStockItem[]; ledgers: TallyLedger[] }): string {
  const msgs: string[] = [];
  for (const u of m.units) msgs.push(`<UNIT NAME="${xmlEscape(u.name)}" ACTION="Create"><NAME>${xmlEscape(u.name)}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT><DECIMALPLACES>${u.decimals}</DECIMALPLACES></UNIT>`);
  for (const g of m.groups) msgs.push(named('STOCKGROUP', g, '<PARENT/><ISADDABLE>Yes</ISADDABLE>'));
  for (const it of m.items) {
    const gst =
      it.gstRate === null || it.gstRate === undefined
        ? ''
        : `<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><CALCULATIONTYPE>On Value</CALCULATIONTYPE>${t('HSNCODE', it.hsn)}<TAXABILITY>${it.gstRate > 0 ? 'Taxable' : 'Exempt'}</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>&#4; Any</STATENAME>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${it.gstRate / 2}</GSTRATE></RATEDETAILS.LIST>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${it.gstRate / 2}</GSTRATE></RATEDETAILS.LIST>` +
          `<RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${it.gstRate}</GSTRATE></RATEDETAILS.LIST>` +
          `</STATEWISEDETAILS.LIST></GSTDETAILS.LIST>`;
    msgs.push(named('STOCKITEM', it.name, `<PARENT>${xmlEscape(it.group ?? '')}</PARENT><BASEUNITS>${xmlEscape(it.unit)}</BASEUNITS>${gst}`));
  }
  for (const l of m.ledgers) {
    let body = `<PARENT>${xmlEscape(l.parent)}</PARENT><ISBILLWISEON>${yes(!!l.billWise)}</ISBILLWISEON>`;
    if (l.opening) body += `<OPENINGBALANCE>${tallyAmount(l.opening)}</OPENINGBALANCE>`;
    if (l.dutyHead) body += `<TAXTYPE>GST</TAXTYPE><GSTDUTYHEAD>${xmlEscape(l.dutyHead)}</GSTDUTYHEAD>`;
    if (l.address) body += `<ADDRESS.LIST TYPE="String"><ADDRESS>${xmlEscape(l.address)}</ADDRESS></ADDRESS.LIST>`;
    if (l.state) body += `${t('LEDSTATENAME', l.state)}<COUNTRYOFRESIDENCE>India</COUNTRYOFRESIDENCE>`;
    if (l.gstin) body += `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>${t('PARTYGSTIN', l.gstin)}`;
    else if (l.parent === 'Sundry Debtors' || l.parent === 'Sundry Creditors') body += '<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>';
    if (l.phone) body += t('LEDGERPHONE', l.phone);
    msgs.push(named('LEDGER', l.name, body));
  }
  return envelope('All Masters', msgs);
}

/** Debits equal credits (inventory values included). Returns the difference in paise. */
export function voucherImbalance(v: TallyVoucher): number {
  return v.entries.reduce((s, e) => s + e.amount, 0) + (v.inventory ?? []).reduce((s, i) => s + i.amount, 0);
}

function entryXml(e: TallyEntry, listTag: string) {
  const bill = e.bill ? `<BILLALLOCATIONS.LIST><NAME>${xmlEscape(e.bill.name)}</NAME><BILLTYPE>${e.bill.type}</BILLTYPE><AMOUNT>${tallyAmount(e.amount)}</AMOUNT></BILLALLOCATIONS.LIST>` : '';
  return `<${listTag}><LEDGERNAME>${xmlEscape(e.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${yes(e.amount > 0)}</ISDEEMEDPOSITIVE><ISPARTYLEDGER>${yes(!!e.party)}</ISPARTYLEDGER><AMOUNT>${tallyAmount(e.amount)}</AMOUNT>${bill}</${listTag}>`;
}

function inventoryXml(i: TallyInventory) {
  const rate = i.billedQty ? Math.abs(i.amount) / 100 / i.billedQty : 0;
  return (
    `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${xmlEscape(i.item)}</STOCKITEMNAME><ISDEEMEDPOSITIVE>${yes(i.amount > 0)}</ISDEEMEDPOSITIVE>` +
    `<RATE>${+rate.toFixed(4)}/${xmlEscape(i.unit)}</RATE><AMOUNT>${tallyAmount(i.amount)}</AMOUNT>` +
    `<ACTUALQTY>${qtyText(i.qty, i.unit)}</ACTUALQTY><BILLEDQTY>${qtyText(i.billedQty, i.unit)}</BILLEDQTY>` +
    `<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>${xmlEscape(i.ledger)}</LEDGERNAME><ISDEEMEDPOSITIVE>${yes(i.amount > 0)}</ISDEEMEDPOSITIVE><AMOUNT>${tallyAmount(i.amount)}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>` +
    `</ALLINVENTORYENTRIES.LIST>`
  );
}

export function tallyVouchersXml(vouchers: TallyVoucher[]): string {
  const msgs = vouchers.map((v) => {
    const inv = !!v.inventory?.length;
    const head =
      `<DATE>${tallyDate(v.date)}</DATE><EFFECTIVEDATE>${tallyDate(v.date)}</EFFECTIVEDATE><VOUCHERTYPENAME>${v.type}</VOUCHERTYPENAME>` +
      t('VOUCHERNUMBER', v.number) + t('REFERENCE', v.reference) + t('PARTYLEDGERNAME', v.party) + t('PARTYGSTIN', v.partyGstin) +
      t('PLACEOFSUPPLY', v.placeOfSupply) + t('NARRATION', v.narration) +
      (inv ? '<ISINVOICE>Yes</ISINVOICE><PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>' : '<ISINVOICE>No</ISINVOICE><PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>');
    // Party first: Tally shows the first ledger line as the voucher's "Party A/c".
    const entries = [...v.entries].sort((a, b) => Number(!!b.party) - Number(!!a.party));
    const body = inv ? entries.map((e) => entryXml(e, 'LEDGERENTRIES.LIST')).join('') + v.inventory!.map(inventoryXml).join('') : entries.map((e) => entryXml(e, 'ALLLEDGERENTRIES.LIST')).join('');
    return `<VOUCHER REMOTEID="${xmlEscape(v.remoteId)}" VCHTYPE="${v.type}" ACTION="Create" OBJVIEW="${inv ? 'Invoice Voucher View' : 'Accounting Voucher View'}">${head}${body}</VOUCHER>`;
  });
  return envelope('Vouchers', msgs);
}

/** Make names unique the way Tally needs (one namespace per master type, case-insensitive). */
export class TallyNames {
  private used = new Map<string, number>();
  constructor(reserved: string[] = []) {
    for (const r of reserved) this.used.set(r.toLowerCase(), 1);
  }
  /** `name`, or `name (hint)`, or `name (hint) 2`… whichever is free. Tally allows 1–99 characters. */
  take(name: string, hint?: string | null): string {
    const base = name.replace(/\s+/g, ' ').trim().slice(0, 90) || 'Unnamed';
    const tries = [base, ...(hint ? [`${base} (${hint})`] : [])];
    for (const c of tries) if (!this.used.has(c.toLowerCase())) return this.claim(c);
    for (let n = 2; ; n++) {
      const c = `${tries[tries.length - 1]} ${n}`;
      if (!this.used.has(c.toLowerCase())) return this.claim(c);
    }
  }
  private claim(n: string) {
    this.used.set(n.toLowerCase(), 1);
    return n;
  }
}
