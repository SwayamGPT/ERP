import { gstinCheckChar, makeEan13, toPaise, type Scheme } from '@hisaab/core';
import { addDays, audit, type Ctx } from '../../src/db/repos/base';
import { mustCompany } from '../../src/db/repos/company';
import { createInvoice, previewInvoice, receivePayment, recordExpense } from '../../src/db/repos/invoices';
import { saveItem, type ItemInput } from '../../src/db/repos/items';
import { saveParty } from '../../src/db/repos/parties';

export type Template = 'kirana' | 'supermarket' | 'wholesaler';

const gstin = (state: string, pan: string) => {
  const first = `${state}${pan}1Z`;
  return first + gstinCheckChar(first);
};

type SeedItem = [
  name: string,
  category: string,
  hsn: string,
  gst: number,
  unit: string,
  mrp: number,
  retail: number,
  cost: number,
  extra?: Partial<{ wholesale: number; super: number; loose: boolean; reorder: number; units: Array<[string, number, number?]>; scheme: Scheme; expiryDays: number; track: boolean; code: string; brand: string; stock: number }>,
];

const COMMON: SeedItem[] = [
  ['Sona Masoori Rice (Loose)', 'Grains & Rice', '1006', 5, 'Kg', 0, 58, 49, { loose: true, reorder: 25, wholesale: 54, code: 'RICE', stock: 120 }],
  ['Basmati Rice Premium 5kg', 'Grains & Rice', '1006', 5, 'Pcs', 720, 685, 590, { reorder: 6, wholesale: 650, stock: 24 }],
  ['Chakki Fresh Atta 10kg', 'Flour & Atta', '1101', 5, 'Pcs', 495, 470, 418, { reorder: 8, wholesale: 455, stock: 30, expiryDays: 70, track: true }],
  ['Sugar (Loose)', 'Sugar & Salt', '1701', 5, 'Kg', 0, 46, 40.5, { loose: true, reorder: 30, wholesale: 44, code: 'SUG', stock: 150 }],
  ['Toor Dal (Loose)', 'Pulses & Dal', '0713', 5, 'Kg', 0, 165, 142, { loose: true, reorder: 15, wholesale: 158, code: 'TOOR', stock: 60 }],
  ['Moong Dal 1kg', 'Pulses & Dal', '0713', 5, 'Pcs', 150, 142, 121, { reorder: 10, stock: 40 }],
  ['Chana Dal 1kg', 'Pulses & Dal', '0713', 5, 'Pcs', 110, 104, 88, { reorder: 10, stock: 36 }],
  ['Iodised Salt 1kg', 'Sugar & Salt', '2501', 0, 'Pcs', 28, 28, 22, { reorder: 20, stock: 80, units: [['Bag (25)', 25, 650]] }],
  ['Refined Sunflower Oil 1L', 'Oils & Ghee', '1512', 5, 'Pcs', 165, 155, 136, { reorder: 12, wholesale: 148, stock: 48, units: [['Box (12)', 12, 1790]] }],
  ['Kachi Ghani Mustard Oil 1L', 'Oils & Ghee', '1514', 5, 'Pcs', 185, 176, 154, { reorder: 10, stock: 36 }],
  ['Pure Desi Ghee 500ml', 'Oils & Ghee', '0405', 5, 'Pcs', 345, 330, 288, { reorder: 6, stock: 20, expiryDays: 140, track: true }],
  ['Toned Milk 500ml', 'Dairy', '0401', 0, 'Pcs', 28, 28, 25.5, { reorder: 30, stock: 60, expiryDays: 2, track: true }],
  ['Fresh Paneer 200g', 'Dairy', '04061000', 0, 'Pcs', 95, 90, 74, { reorder: 8, stock: 16, expiryDays: 5, track: true }],
  ['Salted Butter 100g', 'Dairy', '0405', 5, 'Pcs', 62, 60, 52, { reorder: 10, stock: 30, expiryDays: 60, track: true }],
  ['Masala Chai Tea 500g', 'Tea & Coffee', '0902', 5, 'Pcs', 290, 275, 232, { reorder: 6, stock: 24 }],
  ['Instant Coffee 100g', 'Tea & Coffee', '2101', 5, 'Pcs', 340, 325, 278, { reorder: 5, stock: 15 }],
  ['Glucose Biscuits 250g', 'Biscuits & Snacks', '1905', 5, 'Pcs', 30, 30, 25.2, { reorder: 24, stock: 96, units: [['Box (24)', 24]], scheme: { type: 'bxgy', buy: 12, free: 1 }, expiryDays: 120, track: true }],
  ['Cream Biscuits 120g', 'Biscuits & Snacks', '1905', 5, 'Pcs', 35, 35, 29, { reorder: 24, stock: 72, expiryDays: 18, track: true }],
  ['Aloo Bhujia 400g', 'Biscuits & Snacks', '2106', 5, 'Pcs', 110, 105, 86, { reorder: 10, stock: 30, expiryDays: 25, track: true }],
  ['Instant Noodles 70g', 'Biscuits & Snacks', '1902', 5, 'Pcs', 15, 15, 12.4, { reorder: 48, stock: 144, units: [['Box (48)', 48, 660]], expiryDays: 200, track: true }],
  ['Tomato Ketchup 1kg', 'Sauces & Spreads', '2103', 5, 'Pcs', 155, 145, 118, { reorder: 6, stock: 18 }],
  ['Mixed Fruit Jam 500g', 'Sauces & Spreads', '2007', 5, 'Pcs', 185, 175, 142, { reorder: 5, stock: 3 }],
  ['Turmeric Powder 200g', 'Spices', '0910', 5, 'Pcs', 72, 68, 54, { reorder: 10, stock: 28 }],
  ['Red Chilli Powder 200g', 'Spices', '0904', 5, 'Pcs', 92, 88, 70, { reorder: 10, stock: 26 }],
  ['Garam Masala 100g', 'Spices', '0910', 5, 'Pcs', 85, 82, 64, { reorder: 8, stock: 22 }],
  ['Jeera (Cumin) 100g', 'Spices', '0909', 5, 'Pcs', 70, 66, 52, { reorder: 8, stock: 4 }],
  ['Bathing Soap 100g (Pack of 4)', 'Personal Care', '3401', 5, 'Pcs', 160, 150, 122, { reorder: 10, stock: 40 }],
  ['Herbal Toothpaste 150g', 'Personal Care', '3306', 5, 'Pcs', 120, 112, 92, { reorder: 10, stock: 30 }],
  ['Coconut Hair Oil 200ml', 'Personal Care', '3305', 5, 'Pcs', 110, 104, 84, { reorder: 8, stock: 24 }],
  ['Detergent Powder 1kg', 'Home Care', '3402', 18, 'Pcs', 135, 128, 104, { reorder: 12, stock: 36, scheme: { type: 'slab', slabs: [{ minQty: 6, discountPct: 3 }] } }],
  ['Dishwash Bar 300g', 'Home Care', '3402', 18, 'Pcs', 35, 33, 26, { reorder: 20, stock: 60 }],
  ['Cola 750ml', 'Beverages', '2202', 40, 'Pcs', 45, 45, 36.5, { reorder: 12, stock: 48, units: [['Crate (24)', 24, 1020]] }],
  ['Packaged Drinking Water 1L', 'Beverages', '2201', 5, 'Pcs', 20, 20, 13, { reorder: 24, stock: 96, units: [['Box (12)', 12, 200]] }],
  ['Eggs (Tray of 30)', 'Dairy', '0407', 0, 'Pcs', 210, 198, 172, { reorder: 4, stock: 12 }],
];

const SUPERMARKET_EXTRA: SeedItem[] = [
  ['Corn Flakes 475g', 'Breakfast', '1904', 5, 'Pcs', 210, 199, 162, { reorder: 6, stock: 18 }],
  ['Rolled Oats 1kg', 'Breakfast', '1104', 5, 'Pcs', 199, 185, 148, { reorder: 6, stock: 20 }],
  ['Dark Chocolate 100g', 'Chocolates', '1806', 5, 'Pcs', 120, 115, 88, { reorder: 10, stock: 30, expiryDays: 150, track: true }],
  ['Vanilla Ice Cream 700ml', 'Frozen', '2105', 5, 'Pcs', 260, 245, 192, { reorder: 6, stock: 14, expiryDays: 80, track: true }],
  ['Orange Juice 1L', 'Beverages', '2009', 5, 'Pcs', 140, 132, 104, { reorder: 8, stock: 24, expiryDays: 45, track: true }],
  ['Face Cream 50g', 'Personal Care', '3304', 18, 'Pcs', 250, 235, 180, { reorder: 4, stock: 12 }],
  ['Tissue Roll (Pack of 4)', 'Home Care', '4818', 5, 'Pcs', 180, 168, 128, { reorder: 6, stock: 20 }],
  ['Almonds 250g', 'Dry Fruits', '0802', 5, 'Pcs', 320, 299, 245, { reorder: 6, stock: 18 }],
  ['Cashew W320 250g', 'Dry Fruits', '0801', 5, 'Pcs', 340, 319, 262, { reorder: 6, stock: 16 }],
  ['Bananas (Loose)', 'Fruits & Veg', '0803', 0, 'Kg', 0, 60, 42, { loose: true, reorder: 10, stock: 30, code: 'BAN' }],
  ['Onion (Loose)', 'Fruits & Veg', '0703', 0, 'Kg', 0, 38, 28, { loose: true, reorder: 25, stock: 80, code: 'ONI' }],
  ['Potato (Loose)', 'Fruits & Veg', '0701', 0, 'Kg', 0, 32, 22, { loose: true, reorder: 25, stock: 90, code: 'POT' }],
  ['AA Batteries (Pack of 4)', 'General', '8506', 18, 'Pcs', 120, 110, 82, { reorder: 6, stock: 18 }],
];

const WHOLESALE: SeedItem[] = [
  ['Sugar M-30 (50kg Bag)', 'Sugar & Salt', '1701', 5, 'Kg', 0, 44, 40.2, { wholesale: 42.5, super: 41.5, units: [['Bag (50kg)', 50, 2125]], reorder: 500, stock: 2500, code: 'SUG50' }],
  ['Sona Masoori Rice (25kg Bag)', 'Grains & Rice', '1006', 5, 'Kg', 0, 56, 48, { wholesale: 52, super: 50.5, units: [['Bag (25kg)', 25, 1300]], reorder: 250, stock: 1500, code: 'RICE25' }],
  ['Chakki Fresh Atta 10kg', 'Flour & Atta', '1101', 5, 'Pcs', 495, 470, 412, { wholesale: 445, super: 432, units: [['Bale (5)', 5]], reorder: 40, stock: 200, expiryDays: 75, track: true }],
  ['Refined Sunflower Oil 1L', 'Oils & Ghee', '1512', 5, 'Pcs', 165, 155, 132, { wholesale: 144, super: 139, units: [['Box (12)', 12]], reorder: 120, stock: 600 }],
  ['Glucose Biscuits 250g', 'Biscuits & Snacks', '1905', 5, 'Pcs', 30, 30, 24.6, { wholesale: 26.5, super: 25.6, units: [['Box (24)', 24], ['Carton (96)', 96]], scheme: { type: 'bxgy', buy: 10, free: 1 }, reorder: 480, stock: 2880, expiryDays: 110, track: true }],
  ['Instant Noodles 70g', 'Biscuits & Snacks', '1902', 5, 'Pcs', 15, 15, 12.1, { wholesale: 13.2, super: 12.7, units: [['Box (48)', 48], ['Carton (192)', 192]], reorder: 960, stock: 3840, expiryDays: 21, track: true }],
  ['Detergent Powder 1kg', 'Home Care', '3402', 18, 'Pcs', 135, 128, 101, { wholesale: 112, super: 107, units: [['Bag (20)', 20]], scheme: { type: 'slab', slabs: [{ minQty: 20, discountPct: 2 }, { minQty: 100, discountPct: 4 }] }, reorder: 100, stock: 400 }],
  ['Bathing Soap 100g', 'Personal Care', '3401', 5, 'Pcs', 40, 38, 29.5, { wholesale: 32, super: 31, units: [['Box (48)', 48], ['Carton (144)', 144]], reorder: 288, stock: 1440 }],
  ['Herbal Toothpaste 150g', 'Personal Care', '3306', 5, 'Pcs', 120, 112, 89, { wholesale: 98, super: 94, units: [['Box (36)', 36]], reorder: 72, stock: 360 }],
  ['Cola 750ml', 'Beverages', '2202', 40, 'Pcs', 45, 45, 35, { wholesale: 38, super: 36.5, units: [['Crate (24)', 24]], reorder: 240, stock: 960 }],
  ['Packaged Drinking Water 1L', 'Beverages', '2201', 5, 'Pcs', 20, 20, 12, { wholesale: 14.5, super: 13.5, units: [['Box (12)', 12]], reorder: 240, stock: 1200 }],
  ['Tea Dust 1kg', 'Tea & Coffee', '0902', 5, 'Pcs', 520, 490, 405, { wholesale: 438, super: 425, units: [['Carton (20)', 20]], reorder: 40, stock: 160 }],
];

class Rng {
  constructor(private s: number) {}
  next() {
    this.s = (this.s * 1664525 + 1013904223) % 4294967296;
    return this.s / 4294967296;
  }
  int(a: number, b: number) {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/**
 * TEST-ONLY fixture (never bundled into the app): loads a template's catalogue, parties and ~30 days of realistic history through the real posting engine. */
export function loadSample(ctx: Ctx, template: Template, opts: { history?: boolean } = {}) {
  const company = mustCompany(ctx);
  const st = company.state_code;
  const today = ctx.today();
  const start = addDays(today, -30);
  const at = (date: string): Ctx => ({ ...ctx, today: () => date });
  const rng = new Rng(42);

  ctx.db.transaction(() => {
    const catalogue = template === 'wholesaler' ? WHOLESALE : template === 'supermarket' ? [...COMMON, ...SUPERMARKET_EXTRA] : COMMON;
    let plu = 1;
    const itemIds: Array<{ id: number; seed: SeedItem }> = [];
    catalogue.forEach((s, idx) => {
      const [name, category, hsn, gst, unit, mrp, retail, cost, x = {}] = s;
      const input: ItemInput = {
        name,
        category,
        hsn,
        gst_rate: gst,
        base_unit: unit,
        mrp: toPaise(mrp),
        retail_price: toPaise(retail),
        wholesale_price: x.wholesale ? toPaise(x.wholesale) : null,
        super_price: x.super ? toPaise(x.super) : null,
        purchase_price: toPaise(cost),
        is_loose: !!x.loose,
        plu: x.loose ? String(plu++).padStart(5, '0') : null,
        short_code: x.code ?? null,
        barcode: x.loose ? null : makeEan13(`8907001${String(idx + 1).padStart(5, '0')}`),
        reorder_level: x.reorder ?? 0,
        track_batch: !!x.track,
        tax_inclusive: true,
        scheme: x.scheme ?? null,
        units: (x.units ?? []).map(([n, f, p]) => ({ name: n, factor: f, price: p ? toPaise(p) : null })),
      };
      itemIds.push({ id: saveItem(at(start), input), seed: s });
    });

    // Parties
    const supplierA = saveParty(at(start), { kind: 'supplier', name: 'Mahalaxmi Distributors', phone: '9822012345', gstin: gstin(st, 'AAKFM4821K'), city: company.city, address: 'Market Yard' });
    const otherState = st === '24' ? '27' : '24';
    const supplierB = saveParty(at(start), { kind: 'supplier', name: 'Om Sai FMCG Agencies', phone: '9898012345', gstin: gstin(otherState, 'AAGFO7734P'), city: otherState === '24' ? 'Ahmedabad' : 'Pune', address: 'GIDC Estate' });
    const customers =
      template === 'wholesaler'
        ? [
            saveParty(at(start), { kind: 'customer', name: 'Gupta Kirana Store', phone: '9876501234', gstin: gstin(st, 'BQZPG5512H'), price_tier: 'wholesale', credit_limit: toPaise(150000), credit_days: 15, city: company.city }),
            saveParty(at(start), { kind: 'customer', name: 'New Bharat Provision', phone: '9765401234', gstin: gstin(st, 'AHUPB3390M'), price_tier: 'wholesale', credit_limit: toPaise(100000), credit_days: 15 }),
            saveParty(at(start), { kind: 'customer', name: 'City Super Mart', phone: '9665301234', gstin: gstin(st, 'AAJCC2219Q'), price_tier: 'super', credit_limit: toPaise(400000), credit_days: 30 }),
            saveParty(at(start), { kind: 'customer', name: 'Shree Ganesh Traders', phone: '9555201234', price_tier: 'wholesale', credit_limit: toPaise(50000), credit_days: 7 }),
          ]
        : [
            saveParty(at(start), { kind: 'customer', name: 'Sharma Ji (A-12, Shanti Nagar)', phone: '9876543210', credit_limit: toPaise(5000), credit_days: 30, opening_balance: toPaise(850) }),
            saveParty(at(start), { kind: 'customer', name: 'Hotel Annapurna', phone: '9812345678', gstin: gstin(st, 'AAHFA6610D'), price_tier: 'wholesale', credit_limit: toPaise(40000), credit_days: 15 }),
            saveParty(at(start), { kind: 'customer', name: 'Meena Aunty', phone: '9900112233', credit_limit: toPaise(3000) }),
            saveParty(at(start), { kind: 'customer', name: 'Raj Tiffin Service', phone: '9988776655', price_tier: 'wholesale', credit_limit: toPaise(15000) }),
          ];

    // Users
    ctx.db.exec("INSERT INTO users (name, role, pin) VALUES ('Ravi (Counter 1)', 'cashier', '1111'), ('Priya', 'manager', '2222')");

    // Opening stock via two purchase bills (so cost & ITC are real), one inter-state for IGST.
    const purchaseLines = (part: number, filter: (i: number) => boolean) =>
      itemIds
        .filter((_, i) => filter(i))
        .map(({ id, seed }) => {
          const [, , , , , mrp, , cost, x = {}] = seed;
          const qty = Math.round((x.stock ?? 20) * part * (template === 'wholesaler' ? 1.5 : 3));
          return {
            itemId: id,
            unit: seed[4],
            factor: 1,
            qty,
            rate: toPaise(cost),
            taxInclusive: false,
            batchNo: x.track ? `B${String(rng.int(1000, 9999))}` : null,
            expiry: x.track && x.expiryDays ? addDays(today, x.expiryDays + (part < 1 ? 15 : 0)) : null,
            mrp: mrp ? toPaise(mrp) : null,
          };
        });
    const p1 = createInvoice(at(start), { kind: 'purchase', partyId: supplierA, lines: purchaseLines(1, (i) => i % 3 !== 2), supplierBillNo: 'MD/2201' });
    createInvoice(at(addDays(start, 1)), { kind: 'purchase', partyId: supplierB, lines: purchaseLines(1, (i) => i % 3 === 2), supplierBillNo: 'OS-7781' });
    // An already-expired small batch so the expiry alert has something to show.
    const perishable = itemIds.find((i) => i.seed[8]?.track);
    if (perishable) {
      createInvoice(at(addDays(start, 2)), {
        kind: 'purchase', partyId: supplierA, supplierBillNo: 'MD/2214',
        lines: [{ itemId: perishable.id, unit: perishable.seed[4], factor: 1, qty: 6, rate: toPaise(perishable.seed[7]), taxInclusive: false, batchNo: 'OLD-01', expiry: addDays(today, -3), mrp: perishable.seed[5] ? toPaise(perishable.seed[5]) : null }],
      });
    }
    const opening = { amount: toPaise(template === 'wholesaler' ? 4000000 : 400000) };
    ctx.db.exec(
      "INSERT INTO ledger_entries (voucher_type, voucher_id, date, account, debit, credit, narration) VALUES ('opening', 0, ?, 'BANK', ?, 0, 'Opening bank balance'), ('opening', 0, ?, 'CAPITAL', 0, ?, 'Opening bank balance')",
      [start, opening.amount, start, opening.amount],
    );

    receivePayment(at(addDays(start, 2)), { direction: 'out', partyId: supplierA, amount: p1.total, mode: 'bank', note: 'NEFT MD/2201' });

    if (opts.history === false) return;

    // 30 days of sales
    const sellable = itemIds.filter((i) => i.seed[0]);
    for (let d = 3; d <= 30; d++) {
      const date = addDays(start, d);
      const dctx = at(date);
      const dow = new Date(date).getUTCDay();
      const bills = template === 'wholesaler' ? rng.int(2, 5) : rng.int(7, 13) + (dow === 0 || dow === 6 ? 4 : 0);
      for (let b = 0; b < bills; b++) {
        const credit = rng.next() < (template === 'wholesaler' ? 0.85 : 0.12);
        const partyId = credit || template === 'wholesaler' ? rng.pick(customers) : null;
        const n = template === 'wholesaler' ? rng.int(3, 7) : rng.int(1, 6);
        const chosen = new Set<number>();
        const lines = [];
        for (let k = 0; k < n; k++) {
          const it = rng.pick(sellable);
          if (chosen.has(it.id)) continue;
          chosen.add(it.id);
          const [, , , , unit, , retail, , x = {}] = it.seed;
          const tier = template === 'wholesaler' ? x.wholesale ?? retail : retail;
          const big = x.units?.[0];
          const avail = ctx.db.get<{ q: number }>('SELECT COALESCE(SUM(qty), 0) AS q FROM batches WHERE item_id = ? AND qty > 0 AND (expiry IS NULL OR expiry >= ?)', [it.id, date])!.q;
          const line =
            template === 'wholesaler' && big && rng.next() < 0.7
              ? { itemId: it.id, unit: big[0], factor: big[1], qty: rng.int(1, 4), rate: big[2] ? toPaise(big[2]) : Math.round(toPaise(tier) * big[1]) }
              : { itemId: it.id, unit, factor: 1, qty: x.loose ? rng.pick([0.5, 1, 1, 2, 5, 0.25, 1.5]) : rng.int(1, template === 'wholesaler' ? 24 : 3), rate: toPaise(tier) };
          const scheme = x.scheme?.type === 'bxgy' ? Math.floor(line.qty / x.scheme.buy) * x.scheme.free : 0;
          if ((line.qty + scheme) * line.factor <= avail) lines.push(line);
        }
        if (!lines.length) continue;
        try {
          if (partyId) {
            createInvoice(dctx, { kind: 'sale', partyId, lines, overrideCreditLimit: true });
          } else {
            const pv = previewInvoice(dctx, { kind: 'sale', lines });
            createInvoice(dctx, { kind: 'sale', lines, payments: [{ mode: rng.next() < 0.55 ? 'upi' : 'cash', amount: pv.totals.payable }] });
          }
        } catch {
          /* skip sample bills that hit stock limits */
        }
      }
      if (d === 18) {
        createInvoice(dctx, { kind: 'purchase', partyId: supplierA, lines: purchaseLines(0.6, () => true), supplierBillNo: 'MD/2290' });
      }
      if (d % 6 === 0) {
        const c = rng.pick(customers);
        const bal = ctx.db.get<{ b: number }>("SELECT COALESCE(SUM(debit - credit),0) AS b FROM ledger_entries WHERE account='PARTY' AND party_id = ?", [c])!.b;
        if (bal > 10000) receivePayment(dctx, { direction: 'in', partyId: c, amount: Math.round(bal * 0.6 / 100) * 100, mode: rng.pick(['cash', 'upi', 'bank'] as const), note: 'Part payment' });
      }
      if (d % 7 === 1) recordExpense(dctx, { amount: toPaise(rng.pick([350, 600, 1200, 180])), mode: 'cash', category: rng.pick(['Tea & snacks', 'Electricity', 'Transport', 'Shop rent', 'Packaging']) });
    }
    audit(ctx, 'sample.load', 'company', 1, { template });
  });
}
