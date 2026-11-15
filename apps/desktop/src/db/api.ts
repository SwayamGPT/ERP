import type { SqlJsAdapter } from './adapter';
import { guard, type Ctx } from './repos/base';
import { conflicts as syncConflicts } from './sync/engine';
import { statusLine } from './sync/loop';
import * as company from './repos/company';
import * as invoices from './repos/invoices';
import * as items from './repos/items';
import * as parties from './repos/parties';
import * as reports from './repos/reports';
import * as expenses from './repos/expenses';
import * as staff from './repos/staff';
import * as money from './repos/money';
import type { DraftInvoice } from './types';
import { searchHsn } from '@hisaab/core';

/**
 * The full local API. Every method runs inside the DB worker with the worker-held session,
 * so permissions can't be bypassed from the UI thread. Keys ending in a read verb are queries;
 * everything else is a mutation and triggers a snapshot + cache invalidation.
 */
export const api = {
  // session & company
  'app.status': (ctx: Ctx) => {
    const c = company.getCompany(ctx);
    return { company: c, session: ctx.session, users: c ? company.listUsersForLogin(ctx) : [], me: c ? staff.myEmployee(ctx) : null, pendingRequests: c ? staff.pendingRequestCount(ctx) : 0, sync: statusLine(ctx.db as SqlJsAdapter), ...ctx.meta };
  },
  'sync.status': (ctx: Ctx) => statusLine(ctx.db as SqlJsAdapter),
  'sync.conflicts': (ctx: Ctx) => (guard(ctx, 'settings.edit'), syncConflicts(ctx.db as SqlJsAdapter)),
  'sync.clearConflicts': (ctx: Ctx) => (guard(ctx, 'settings.edit'), ctx.db.exec('UPDATE _sync_conflicts SET seen = 1'), true),
  'company.setup': (ctx: Ctx, a: company.SetupInput) => company.setupCompany(ctx, a),
  'company.save': (ctx: Ctx, a: Parameters<typeof company.saveCompany>[1]) => company.saveCompany(ctx, a),
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
    return { totals: b.totals, interState: b.interState, party: b.party, lines: b.lines.map((l) => ({ ...l.tax, gstRate: l.item.gst_rate, cessRate: l.item.cess_rate, hsn: l.item.hsn, taxInclusive: l.taxInclusive, freeQty: l.freeQty, discountPct: l.discountPct, scheme: l.schemeLabel })) };
  },
  'invoices.create': (ctx: Ctx, a: DraftInvoice) => invoices.createInvoice(ctx, a),
  'invoices.get': (ctx: Ctx, a: { id: number }) => invoices.getInvoice(ctx, a.id),
  'invoices.list': (ctx: Ctx, a: Parameters<typeof invoices.listInvoices>[1]) => invoices.listInvoices(ctx, a),
  'invoices.return': (ctx: Ctx, a: Parameters<typeof invoices.createReturn>[1]) => invoices.createReturn(ctx, a),
  'invoices.cancel': (ctx: Ctx, a: { id: number; reason: string }) => invoices.cancelInvoice(ctx, a.id, a.reason),

  // money
  'payments.receive': (ctx: Ctx, a: Parameters<typeof invoices.receivePayment>[1]) => invoices.receivePayment(ctx, a),
  'payments.cancel': (ctx: Ctx, a: { id: number }) => invoices.cancelPayment(ctx, a.id),
  'payments.list': (ctx: Ctx, a: Parameters<typeof invoices.listPayments>[1]) => invoices.listPayments(ctx, a),

  // expenses
  'expenses.sync': (ctx: Ctx) => expenses.syncRecurring(ctx),
  'expenses.overview': (ctx: Ctx, a: { month?: string }) => money.expenseOverview(ctx, a?.month),
  'expenses.list': (ctx: Ctx, a: Parameters<typeof expenses.listExpenses>[1]) => expenses.listExpenses(ctx, a),
  'expenses.get': (ctx: Ctx, a: { id: number }) => expenses.getExpense(ctx, a.id),
  'expenses.create': (ctx: Ctx, a: expenses.ExpenseInput) => expenses.createExpense(ctx, a),
  'expenses.pay': (ctx: Ctx, a: Parameters<typeof expenses.payExpense>[1]) => expenses.payExpense(ctx, a),
  'expenses.cancel': (ctx: Ctx, a: { id: number; reason: string }) => expenses.cancelExpense(ctx, a),
  'expenses.cancelPayment': (ctx: Ctx, a: { paymentId: number }) => expenses.cancelExpensePayment(ctx, a.paymentId),
  'expenses.categories': (ctx: Ctx, a: { month?: string }) => expenses.listCategories(ctx, a?.month),
  'expenses.saveCategory': (ctx: Ctx, a: Parameters<typeof expenses.saveCategory>[1]) => expenses.saveCategory(ctx, a),
  'expenses.payees': (ctx: Ctx) => expenses.payees(ctx),
  'expenses.recurring': (ctx: Ctx) => expenses.listRecurring(ctx),
  'expenses.saveRecurring': (ctx: Ctx, a: Parameters<typeof expenses.saveRecurring>[1]) => expenses.saveRecurring(ctx, a),

  // staff & salary
  'staff.list': (ctx: Ctx, a: { includeInactive?: boolean }) => staff.listEmployees(ctx, a ?? {}),
  'staff.get': (ctx: Ctx, a: { id: number }) => staff.getEmployee(ctx, a.id),
  'staff.save': (ctx: Ctx, a: Parameters<typeof staff.saveEmployee>[1]) => staff.saveEmployee(ctx, a),
  'staff.salaryPreview': (ctx: Ctx, a: { period: string }) => staff.salaryPreview(ctx, a.period),
  'staff.runSalary': (ctx: Ctx, a: Parameters<typeof staff.runSalary>[1]) => staff.runSalary(ctx, a),
  'staff.paySalary': (ctx: Ctx, a: Parameters<typeof staff.paySalary>[1]) => staff.paySalary(ctx, a),
  'staff.advance': (ctx: Ctx, a: Parameters<typeof staff.staffAdvance>[1]) => staff.staffAdvance(ctx, a),
  'staff.request': (ctx: Ctx, a: { amount: number; reason?: string }) => staff.requestAdvance(ctx, a),
  'staff.withdrawRequest': (ctx: Ctx, a: { id: number }) => staff.withdrawRequest(ctx, a.id),
  'staff.myPay': (ctx: Ctx) => staff.myPay(ctx),
  'staff.requests': (ctx: Ctx, a: { status?: staff.StaffRequest['status'] | 'all' }) => staff.listRequests(ctx, a ?? {}),
  'staff.decide': (ctx: Ctx, a: Parameters<typeof staff.decideRequest>[1]) => staff.decideRequest(ctx, a),
  'staff.bonus': (ctx: Ctx, a: Parameters<typeof staff.giveBonus>[1]) => staff.giveBonus(ctx, a),
  'staff.billers': (ctx: Ctx) => staff.billers(ctx),
  'reports.salesByStaff': (ctx: Ctx, a: { from: string; to: string }) => reports.salesByStaff(ctx, a),

  // money movements
  'money.move': (ctx: Ctx, a: Parameters<typeof money.recordMove>[1]) => money.recordMove(ctx, a),
  'money.cashCheck': (ctx: Ctx, a: { counted: number; note?: string }) => money.cashCheck(ctx, a),
  'money.cancelMove': (ctx: Ctx, a: { id: number }) => money.cancelMove(ctx, a.id),
  'money.moves': (ctx: Ctx, a: Parameters<typeof money.listMoves>[1]) => money.listMoves(ctx, a),
  'money.log': (ctx: Ctx, a: Parameters<typeof money.moneyLog>[1]) => money.moneyLog(ctx, a),
  'reports.cashflow': (ctx: Ctx, a: { from: string; to: string }) => money.cashFlow(ctx, a),
  'reports.pnl': (ctx: Ctx, a: { from: string; to: string }) => money.profitAndLoss(ctx, a),

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
