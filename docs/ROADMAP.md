# Hisaab — product roadmap & completion checklist

Hisaab is a billing, inventory, accounting and GST app for Indian kirana stores, supermarkets and
wholesalers. This file is the single checklist of what the finished product contains and which
release delivers each piece. Tick items as they ship.

| Release | Theme | Status |
|---|---|---|
| **R1** | Offline desktop MVP — counter billing, stock, khata, expenses & staff, GST returns | ✅ complete — every R1 item and quality gate ticked |
| **R2** | Cloud sync, owner & salesman mobile apps, native hardware | 🚧 in progress — cloud, phone app and shop features done; hardware & GST APIs next |
| **R3** | Full accounting, advanced compliance, multi-branch | planned |
| **R4** | Ecosystem — subscriptions, partner/CA portal, integrations | planned |

---

## 1. Billing & POS
- [x] R1 · Single omnibox: name, short code, barcode, unit barcode, EAN-13 weighing-scale (weight or price) codes
- [x] R1 · Keyboard-first flow (Enter: item → qty → next) with on-screen shortcut badges (F1–F10, Esc)
- [x] R1 · Multiple bills open at once as tabs (F2 new, F3 next, Alt+1…9, Alt+X), persisted per enterprise across restarts
- [x] R1 · GST breakup always shown while billing (per-line GST % and tax, rate-wise CGST/SGST/IGST table)
- [x] R1 · Cash (with change calculator), UPI, card, udhaar (credit) with part-payment by cash / UPI / card
- [x] R1 · Split payment on one bill: part cash, rest by UPI (QR for the remainder) or card
- [x] R1 · Dynamic UPI QR with the exact payable amount (screen + receipt)
- [x] R1 · Price tiers auto-applied per customer (MRP / Retail / Wholesale / Super-stockist)
- [x] R1 · Schemes: buy-X-get-Y free qty, quantity slab discounts; line and bill discounts (cashier cap 5%)
- [x] R1 · Multi-unit selling (piece / box / carton / bag, kg & g) with per-unit prices
- [x] R1 · Round-off to the rupee as an explicit, ledger-posted line
- [x] R1 · Print templates with live preview: classic receipt, big & clear receipt, GST tax invoice (A4), modern invoice (A4), half-page bill (A5)
- [x] R1 · Configurable tax on printed bills (full breakup / totals / none — B2B never below totals); HSN, savings, UPI QR, bank details, signature, terms toggles
- [x] R1 · WhatsApp bill sharing (wa.me deep link)
- [x] R1 · Sales returns (credit notes) — partial, refund or adjust in khata; bill cancellation with reversal
- [x] R1 · Credit-limit check with owner/manager override; walk-in bills must be paid in full
- [x] R2 · Native ESC/POS printing without the print dialog; auto-cut; UPI QR on the receipt (desktop app; network printers on port 9100 or any installed printer)
- [x] R2 · Cash-drawer kick (on cash bills, or from the Drawer button)
- [x] R2 · Weighing-scale input over serial/USB (Weigh / Alt+W fills the loose line; common continuous formats understood)
- [x] R2 · Customer-facing display (second window: items, total, UPI QR, thank-you with change)
- [x] R2 · Loyalty points & coupons (taxes recomputed on the discounted value; cancelling a bill gives them back)
- [x] R2 · Multiple counters billing at the same time, offline, through cloud sync
- [x] R2 · Sale orders → invoice (from the salesman app)
- [ ] R3 · Delivery challans, quotations / estimates, recurring invoices

## 2. Purchases
- [x] R1 · Keyboard grid entry: unit, qty, free qty, rate, discount, batch, expiry, MRP
- [x] R1 · Batches created per line; effective cost includes free goods; MRP / cost updated on item
- [x] R1 · Inter-state supplier → IGST input credit automatically
- [x] R1 · Purchase returns (debit notes), cancellation
- [x] R1 · Pay now (cash/bank/UPI) or on credit; supplier payments later
- [x] R2 · Purchase orders, received in parts by purchase bills (GRN); cancelling a receipt puts goods back on order
- [x] R2 · Import distributor bills from CSV / Excel (columns detected; items matched by barcode, name, similar name)
- [x] R2 · Reorder suggestions from sales velocity, lead time and reorder level; one click to POs per supplier
- [ ] R3 · Purchase-bill OCR (photo → entry)
- [x] R3 · GSTR-2B ITC matching against purchases (delivered early in R2)

## 3. Inventory
- [x] R1 · Base-unit stock with any number of bigger units; "3 Carton 1 Pcs" display
- [x] R1 · Batch & expiry tracking; FIFO by earliest expiry; expired batches are never auto-sold
- [x] R1 · Manual batch pick on the bill
- [x] R1 · Expiry alerts (expired / ≤30 / ≤90 days) and low-stock alerts (reorder level)
- [x] R1 · Stock adjustments with reasons (damage, count, own use, opening)
- [x] R1 · Opening stock on item creation
- [x] R1 · Barcode labels: A4 sheets, 50×25 / 38×25 rolls, TSPL file for label printers; internal EAN-13 generator
- [x] R1 · HSN search with GST 2.0 rates (0 / 5 / 18 / 40, plus special & legacy 0.25 / 3 / 12 / 28)
- [x] R1 · Negative-stock billing allowed (configurable) so the counter never stops
- [x] R2 · Multiple godowns & stock transfers (batches keep number/expiry/cost; billing draws from the default godown first)
- [x] R2 · Item variants (size / colour), each its own SKU, barcode, price and stock
- [x] R2 · Physical stock count from the phone app (count → stock corrected with a note)
- [x] R2 · Native TSPL / ZPL label printing
- [ ] R3 · Bill of materials & repacking (50 kg sack → 1 kg packs)
- [ ] R3 · Serial / IMEI tracking
- [ ] R3 · Dead-stock analysis

## 4. Parties & accounting
- [x] R1 · Customers & suppliers with GSTIN validation (check digit), state, price tier, credit limit
- [x] R1 · Opening balances
- [x] R1 · Khata / ledger statement with running balance, CSV export
- [x] R1 · Money in (receipts), money out (supplier payments), expenses by category
- [x] R1 · Cash book and bank/UPI book
- [x] R1 · True double-entry posting for every voucher; books-health check (Σ debit = Σ credit)
- [x] R1 · WhatsApp payment reminders
- [x] R1 · Oldest-first knock-off of payments against unpaid bills
- [x] R2 · Bank reconciliation (statement CSV/Excel import, auto-match, manual match), cheque register (deposit / clear / bounce)
- [x] R2 · Scheduled payment reminders (queued daily, one tap to send on WhatsApp). Fully automatic sending needs a WhatsApp Business API account
- [x] R2 · Customer price lists (billing and sale orders use them)
- [ ] R3 · Full chart of accounts; journal & contra vouchers behind "Advanced"
- [ ] R3 · Trial balance, P&L, balance sheet
- [ ] R3 · Financial-year close & carry-forward
- [ ] R3 · TDS / TCS
- [ ] R3 · Tally XML export

## 4b. Expenses, staff & cash flow
- [x] R1 · Expense categories (rent, utilities, staff, operations, finance, taxes…) with monthly budgets and over-budget warnings
- [x] R1 · Expenses paid now (cash / UPI / bank) or recorded as bills to pay with due dates; part payments; cancel with full reversal
- [x] R1 · GST expense bills with input tax credit flowing into GSTR-3B
- [x] R1 · Recurring expenses (weekly / monthly / quarterly / yearly) — bills created a week ahead; auto-debits marked paid on the due date
- [x] R1 · Staff records, monthly salary run (days worked, bonus, deductions), advances given/returned, advance adjusted from salary; salaries visible to the owner only
- [x] R1 · Cash ↔ bank transfers, owner withdrawals & capital, other income, cash-drawer count with denomination helper and short/excess booking
- [x] R1 · Money log: every cash/bank movement with who recorded it, when, and running balance (CSV)
- [x] R1 · Cash-flow statement (grouped inflows/outflows, expense breakdown, month by month) and Profit & loss (sales − FIFO cost − expenses + other income)
- [x] R1 · Plain-language activity log of every action, filterable by person, area and date
- [x] R1 · Staff ask for money from their own PIN login ("My pay"); owner approves (full or part, cash/UPI/bank) or declines with a note; dashboard alert and nav badge
- [x] R1 · Money given before payday in small amounts; adjusted at salary time as the owner decides
- [x] R1 · Festival bonuses (Diwali, Eid, Onam…) for everyone or one person — fixed or % of salary, paid now or added to next salary
- [x] R1 · Optional "Served by" staff on bills (Settings switch), remembered per counter; returns count against the original server; Sales-by-staff report; optional incentive % added in the salary run
- [x] R2 · Attach bill photos to expenses; WhatsApp salary slips
- [ ] R2 · Staff attendance from the mobile app
- [x] R2 · Expense approvals above a set amount; petty-cash float (imprest) with top-up
- [x] R2 · Godown rent: landlord, monthly rent and due day per godown; rent bills appear in Bills to pay (or auto-debit), in cash flow and P&L

## 5. GST & compliance
- [x] R1 · CGST + SGST vs IGST by place of supply; cess; tax-inclusive and exclusive prices
- [x] R1 · Paise-exact line rounding (invariant: taxable + taxes = line total)
- [x] R1 · GSTR-1 JSON: B2B, B2CL (> ₹1 lakh inter-state), B2CS, CDNR, HSN (B2B/B2C split), documents issued
- [x] R1 · GSTR-3B JSON: 3.1 outward, 3.2 inter-state unregistered, 4 ITC
- [x] R1 · Net tax payable summary; missing-HSN warnings
- [x] R1 · e-Way Bill bulk JSON (NIC format)
- [x] R2 · GSTR-2B import & reconciliation (matched / tax differs / not in books / not filed by supplier, credit at risk)
- [x] R2 · e-Invoice (IRN + signed QR): IRP schema 1.1 JSON with pre-checks, bulk upload file, import of the portal's result, IRN & QR printed on the bill, 24-hour cancel, test mode
- [ ] R2 · Direct API filing through a GST Suvidha Provider (IRN, e-Way Bill) — needs the owner's GSP account and API keys
- [x] R2 · e-Way Bill number recorded on the bill and printed (JSON for the portal since R1)
- [ ] R3 · GSTR-9 annual summary; composition scheme (CMP-08)
- [ ] R3 · Direct return filing through a GSP

## 6. Insights
- [x] R1 · Home dashboard: today's sales vs yesterday, money in/out, udhaar, payables, estimated profit
- [x] R1 · 30-day sales chart, top items, running-low and expiring lists, recent bills
- [x] R1 · Reports: sales & purchase registers, item profit (FIFO cost), bill profit, stock summary, expiry, day book, cash & bank book, outstanding — all CSV
- [x] R2 · Owner mobile dashboard
- [x] R2 · Daily WhatsApp summary from the phone app (sales, profit, cash, bank, dues, low stock)
- [x] R2 · Salesman performance (orders, billed value, cancellations, collections)
- [ ] R3 · ABC / XYZ analysis, demand forecasting, margin-leak alerts
- [ ] R3 · Ask questions in plain language ("what sold most last Diwali?")

## 7. Cloud, sync & mobile
- [x] R1 · Storage boundary (`StorageAdapter`) so engines can be swapped without UI changes
- [x] R2 · Go backend on Postgres (`server/`): accounts, shops, device pairing, sync feed with validation (id blocks, line tax totals, balanced vouchers), Docker; GST maths checked against the shared golden fixtures
- [x] R2 · Offline-first sync from the local SQLite (own engine: per-device id blocks, change capture by transaction, stock & payment status recomputed after every pull, bill series per device, deterministic clash rules for barcodes / categories / bill numbers / duplicate salaries)
- [x] R2 · Encrypted automatic cloud backup (AES-256-GCM on the device, daily + on demand, restore on a new PC)
- [x] R2 · Owner phone app — installable web app (PWA), works offline: today's sales & profit, cash & bank, dues with WhatsApp reminders and collection, low stock & expiry, staff requests
- [x] R2 · Salesman phone app: sale orders at the customer's price with live stock, collections; new Salesman role (no billing, cost or profit); counter bills orders from an Orders drawer
- [ ] R3 · Multi-branch; customer self-ordering link / catalogue; B2B retailer ordering app

## 8. Users & security
- [x] R1 · Owner / Manager / Cashier roles enforced inside the database worker (not just hidden in the UI)
- [x] R1 · PIN lock and quick user switch (Alt+L)
- [x] R1 · Cost, margin and profit hidden from cashiers; discount cap; no back-dated bills for cashiers
- [x] R1 · Audit log
- [x] R1 · Backup to a `.hisaab` file and restore; erase-all
- [x] R1 · Single-window lock so two tabs can't overwrite each other
- [x] R2 · Cloud account login; device management (pair with code/QR, rename, remove)
- [ ] R2 · Custom roles
- [x] R2 · Hashed PINs (PBKDF2-SHA256, old PINs upgraded automatically)
- [x] R2 · 4-digit PINs everywhere; the lock screen opens on the 4th digit; old longer PINs sign in once and must be changed
- [ ] R2 · At-rest encryption of the local database (SQLCipher in the native shell)
- [ ] R3 · Approval workflows (e.g. discount above a set % needs approval)

## 9. Platform & UX
- [x] R1 · Create-enterprise wizard with mandatory GSTIN, FSSAI, contact number, email and address (validated); FSSAI renewal reminder
- [x] R1 · Multiple enterprises on one computer, each with its own database, staff and settings
- [x] R1 · Ctrl+K command palette, `?` shortcut sheet, Alt-key navigation
- [x] R1 · Light & dark themes; English & Hindi labels
- [x] R1 · Plain-language UI (Money In / Out, Udhaar, Khata) with progressive disclosure
- [x] R1 · Tauri v2 shell scaffold (`in.hisaab.desktop`)
- [x] R2 · Desktop app keeps each shop's database as a file on disk: atomic saves, previous copy, 7 daily backups
- [ ] R2 · Signed Windows / macOS installers, auto-update — needs a code-signing certificate, an Apple Developer account and an updater signing key from the owner
- [ ] R2 · Native SQLite engine in the desktop app (today the same WASM engine as the browser, saved to disk)
- [ ] R2 · Marathi, Gujarati, Tamil; full Hindi coverage
- [ ] R2 · In-app help & short videos
- [ ] R4 · Subscription billing & licensing; partner / CA portal; public API & webhooks
- [ ] R4 · Payment gateway, UPI auto-reconciliation, payment links

> Counter hardware (printers, drawer, scale) is covered by automated tests against simulated devices (a test network printer, recorded scale output). Confirm on the real printer and scale at the shop before going live.

## 10. Quality gates (every release)
- [x] Paise-exact unit tests + golden fixtures (`packages/core/fixtures`) shared with future backends
- [x] Repository tests on real SQLite: ledger balance, FIFO, returns, cancel, RBAC, atomic rollback
- [x] Playwright journeys for the core flows against the production build
- [x] Migration upgrade test (release-1 schema → current)
- [x] Performance budget: a bill saves in < 50 ms with 50k items and 100k invoices — measured p95 **3.4 ms** (preview 0.7 ms, barcode scan 11 ms, name search 37 ms); `npm run perf`, also in CI
  - Known limit: at that size the database is ~200 MB and each disk snapshot takes ~200 ms, so snapshots back off (up to 5 s) on large shops; closing or hiding the window still saves immediately. Native SQLite in the Tauri shell (R2) removes whole-file snapshots.

---

## Phase plan for R2 (next)
1. **Native shell** — Tauri SQL storage adapter, ESC/POS + TSPL printing, scale reader, drawer kick, installers, auto-update.
2. **Backend (Go)** — auth, tenants, devices; Postgres schema mirroring SQLite; sync with PowerSync; run `packages/core/fixtures` in Go tests.
3. **Mobile (Expo)** — owner dashboard and salesman order-taking, reusing `@hisaab/core`.
4. **Compliance APIs** — e-Invoice IRN and e-Way Bill via a GSP; GSTR-2B reconciliation.
5. **Security** — hashed PINs, encrypted local DB, cloud backups.
