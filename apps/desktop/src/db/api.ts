import type { Ctx } from './repos/base';
import * as company from './repos/company';
import * as invoices from './repos/invoices';
import * as items from './repos/items';
import * as parties from './repos/parties';
import * as reports from './repos/reports';
import { loadSample } from './seeds';
import type { Template } from './templates';
import type { DraftInvoice } from './types';
import { searchHsn } from '@hisaab/core';

/**
 * The full local API. Every method runs inside the DB worker with the worker-held session,
 * so permissions can't be bypassed from the UI thread. Keys ending in a read verb are queries;
 * everything else is a mutation and triggers a snapshot + cache invalidation.
 */
export const api = {
  // session & company
  'app.status': (ctx: Ctx) => ({ company: company.getCompany(ctx), session: ctx.session, users: company.getCompany(ctx) ? company.listUsersForLogin(ctx) : [] }),
  'company.setup': (ctx: Ctx, a: company.SetupInput & { loadSample?: boolean }) => {
    const s = company.setupCompany(ctx, a);
    if (a.loadSample) loadSample(ctx, a.template);
    return s;
  },
  'company.save': (ctx: Ctx, a: Parameters<typeof company.saveCompany>[1]) => company.saveCompany(ctx, a),
  'sample.load': (ctx: Ctx, a: { template: Template }) => (company.getCompany(ctx) ? (loadSample(ctx, a.template), true) : false),
  'auth.login': (ctx: Ctx, a: { userId: number; pin: string }) => company.login(ctx, a.userId, a.pin),
  'auth.lock': (ctx: Ctx) => (company.lock(ctx), true),
  'users.list': (ctx: Ctx) => company.listUsers(ctx),
  'users.save': (ctx: Ctx, a: Parameters<typeof company.saveUser>[1]) => company.saveUser(ctx, a),
  'audit.list': (ctx: Ctx) => company.auditLog(ctx),

  // items
  'items.list': (ctx: Ctx, a: Parameters<typeof items.listItems>[1]) => items.listItems(ctx, a),
  'items.get': (ctx: Ctx, a: { id: number }) => items.getItem(ctx, a.id),
  'items.search': (ctx: Ctx, a: { q: string }) => items.searchForBilling(ctx, a.q),
  'items.save': (ctx: Ctx, a: items.ItemInput) => items.saveItem(ctx, a),
  'items.adjust': (ctx: Ctx, a: Parameters<typeof items.adjustStock>[1]) => items.adjustStock(ctx, a),
  'items.categories': (ctx: Ctx) => items.categories(ctx),
  'items.nextPlu': (ctx: Ctx) => items.nextPlu(ctx),
  'items.batches': (ctx: Ctx, a: { itemId: number }) => invoices.batchesFor(ctx, a.itemId),
  'hsn.search': (_ctx: Ctx, a: { q: string }) => searchHsn(a.q),

  // parties
  'parties.list': (ctx: Ctx, a: Parameters<typeof parties.listParties>[1]) => parties.listParties(ctx, a),
  'parties.get': (ctx: Ctx, a: { id: number }) => parties.getParty(ctx, a.id),
  'parties.save': (ctx: Ctx, a: parties.PartyInput) => parties.saveParty(ctx, a),
  'parties.ledger': (ctx: Ctx, a: { id: number; from?: string; to?: string }) => parties.partyLedger(ctx, a.id, a),

  // invoices
  'invoices.preview': (ctx: Ctx, a: DraftInvoice) => {
    const b = invoices.previewInvoice(ctx, a);
    return { totals: b.totals, interState: b.interState, party: b.party, lines: b.lines.map((l) => ({ ...l.tax, freeQty: l.freeQty, discountPct: l.discountPct, scheme: l.schemeLabel })) };
  },
  'invoices.create': (ctx: Ctx, a: DraftInvoice) => invoices.createInvoice(ctx, a),
  'invoices.get': (ctx: Ctx, a: { id: number }) => invoices.getInvoice(ctx, a.id),
  'invoices.list': (ctx: Ctx, a: Parameters<typeof invoices.listInvoices>[1]) => invoices.listInvoices(ctx, a),
  'invoices.return': (ctx: Ctx, a: Parameters<typeof invoices.createReturn>[1]) => invoices.createReturn(ctx, a),
  'invoices.cancel': (ctx: Ctx, a: { id: number; reason: string }) => invoices.cancelInvoice(ctx, a.id, a.reason),
  'held.list': (ctx: Ctx) => invoices.listHeld(ctx),
  'held.hold': (ctx: Ctx, a: { label: string; cart: unknown; total: number }) => invoices.holdBill(ctx, a),
  'held.take': (ctx: Ctx, a: { id: number }) => invoices.takeHeld(ctx, a.id),

  // money
  'payments.receive': (ctx: Ctx, a: Parameters<typeof invoices.receivePayment>[1]) => invoices.receivePayment(ctx, a),
  'payments.expense': (ctx: Ctx, a: Parameters<typeof invoices.recordExpense>[1]) => invoices.recordExpense(ctx, a),
  'payments.cancel': (ctx: Ctx, a: { id: number }) => invoices.cancelPayment(ctx, a.id),
  'payments.list': (ctx: Ctx, a: Parameters<typeof invoices.listPayments>[1]) => invoices.listPayments(ctx, a),

  // reports
  'reports.dashboard': (ctx: Ctx) => reports.dashboard(ctx),
  'reports.register': (ctx: Ctx, a: Parameters<typeof reports.salesRegister>[1]) => reports.salesRegister(ctx, a),
  'reports.itemProfit': (ctx: Ctx, a: { from: string; to: string }) => reports.itemProfit(ctx, a),
  'reports.billProfit': (ctx: Ctx, a: { from: string; to: string }) => reports.billProfit(ctx, a),
  'reports.stock': (ctx: Ctx) => reports.stockSummary(ctx),
  'reports.expiry': (ctx: Ctx, a: { days?: number }) => reports.expiryReport(ctx, a),
  'reports.daybook': (ctx: Ctx, a: { date: string }) => reports.dayBook(ctx, a.date),
  'reports.cashbook': (ctx: Ctx, a: Parameters<typeof reports.cashBook>[1]) => reports.cashBook(ctx, a),
  'reports.outstanding': (ctx: Ctx, a: { kind: 'customer' | 'supplier' }) => reports.outstanding(ctx, a.kind),
  'reports.health': (ctx: Ctx) => reports.ledgerHealth(ctx),
  'gst.summary': (ctx: Ctx, a: { period: string }) => reports.gstSummary(ctx, a.period),
  'gst.eway': (ctx: Ctx, a: Parameters<typeof reports.ewayBill>[1]) => reports.ewayBill(ctx, a),
};

export type Api = typeof api;
export type Method = keyof Api;
export type ArgsOf<M extends Method> = Parameters<Api[M]> extends [Ctx, infer A] ? A : void;
export type ResultOf<M extends Method> = ReturnType<Api[M]>;

export { isMutation } from './methods';
