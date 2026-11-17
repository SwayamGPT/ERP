# Hisaab

**Billing, stock, money and GST for Indian shops — fast at the counter, honest in the books.**

Hisaab is an offline-first business app for kirana stores, supermarkets, medical and general
stores, and wholesalers. It runs on the shop computer (Windows / Mac), on phones over the shop's
Wi-Fi (Android app or any phone browser), and can sync and back up through its own cloud server
or the owner's Google Drive. It speaks the shop's language — *udhaar*, *khata*, *bills to pay* —
instead of accounting jargon, while keeping proper double-entry books underneath.

---

## Why Hisaab, compared with traditional ERPs

| Area | Traditional desktop ERP | Hisaab |
|---|---|---|
| **Billing speed** | Many screens and voucher types; training needed | One search box for name, code, barcode or scale sticker; several bills open at once; keyboard-first |
| **Supplier schemes and coupons** | Selling under the bill rate shows as a loss | Coupons and schemes lower the real cost of stock, so profit is shown correctly; coupons in hand are tracked and redeemed |
| **Buying without a GST bill** | Workarounds through journal entries | A purchase can be marked "no bill": no input GST, the full price is the cost — even straight from the billing screen when an item has run out |
| **Correcting a purchase rate** | Old profit figures stay wrong | Editing the purchase re-costs every sale already made from that stock |
| **Fixing a saved bill** | Cancel and re-enter under a new number | Edit the bill under the same number; stock, accounts and payments are corrected together and the change is audited |
| **Selling below cost** | Noticed at month end, if at all | Flagged on the line while billing; staff without cost permission only see that it is below cost |
| **Repeating bills (rent etc.)** | Monthly entries only | Daily, every few days, weekly, monthly…; skip closed days; pay several at once or in advance |
| **Quotations** | Often a separate document tool | Quotations priced exactly like a bill, printed or shared on WhatsApp, and turned into a bill in one click — nothing is sold until then |
| **Paying suppliers** | Separate bill-wise adjustment screens | Tick the bills while paying; the supplier's invoice number is recorded on every purchase |
| **Phones for staff** | Extra licences or remote desktop | Pair a phone over the shop Wi-Fi; staff bill, collect and check stock on the computer's own data, and print or share bills |
| **Who can do what** | Fixed roles | Roles plus per-person permissions set by the owner (for example, who may give credit) |
| **Many staff at the counter** | A long user list | A searchable sign-in grid, the last person first, and 4-digit PINs |
| **Cash, banks and cheques** | One bank ledger, cheques as journal entries | Several bank accounts, deposit slips for cash and cheques, cheques counted when they clear, statement matching |
| **Backups** | Manual copies | Automatic, encrypted backups to the owner's Google Drive on a schedule, plus encrypted cloud backups |
| **Moving in** | Re-type everything, or a consultant's data import | Import items, batch-wise stock with expiry and party balances from Excel / CSV exports; fix problem rows, do a trial run that saves nothing, compare totals with the old software, import, and undo in one click if anything is off |
| **Your CA** | CA asks you to stay on (or move back to) Tally | One-click Tally XML: ledgers, parties, stock items and a month's vouchers with item lines, ready for Tally import; ledger names can match the CA's |
| **Cheap counter hardware** | A printer or scale hang can freeze the billing screen | Every device call runs apart with a deadline; receipts wait in a print queue if the printer is off; printer profiles and a test page; "Find my scale" tries the ports and speeds; scans land on the bill wherever the cursor is |
| **Two counters offline** | One central server; offline means no billing | Each counter bills offline; when two sell the last packet, both bills stand and the owner is shown the shortfall |
| **GST** | Separate utilities | GSTR-1, GSTR-3B, HSN summary, e-Way Bill, e-Invoice and GSTR-2B matching from the same data; GST and cess default from the HSN code |
| **Correct numbers** | Floating-point totals, rounding surprises | Every amount in whole paise; GST rounded per line; every voucher balances to the paisa; a bill saves completely or not at all |


---

## Features

### Counter billing
- One search for name, short code, barcode, PLU and weighing-scale stickers (by weight or by price)
- Up to 9 bills open at once (F2 new, F3 next, Alt+1…9); bills survive a restart
- Cash, UPI QR, card, **split** (part cash, part UPI), **udhaar** with credit limits
- Tier prices (retail / wholesale / super-stockist), customer price lists, schemes (buy N get M, slab discounts), coupons, loyalty points
- FIFO batches with expiry, multi-unit (piece / box / carton, kg / g), negative-stock control
- **Loss warning** when a line sells below its stock cost; GST and cess breakup always visible
- **Quotations**: priced like a bill, printed or shared on WhatsApp, billed later — nothing sold until then
- **Edit saved bills** (same number) and returns / credit notes; "served by" staff for incentives
- **Bought outside?** — bring in an out-of-stock item fetched from a nearby shop without a bill
- Bills with no customer say **Cash**

### Printing & hardware (desktop app)
- 5 templates: classic and big-print receipts (58 / 80 mm), GST tax invoice, modern A4, half-page A5 — live preview, choose how much GST to show
- Silent ESC/POS printing to the receipt printer (F9), cash drawer kick, auto-cut, barcode labels (TSPL / ZPL), weighing scale over serial / USB
- **Never freezes the counter**: every printer / scale call runs on its own thread with a deadline, panics are caught; a bill is saved first and its receipt waits in a print queue (with Retry) if the printer is off
- **Printer profiles** (Epson, TVS / Retsol, Xprinter-style, 42-column, 58 mm) and a test page with five yes / no questions that tune the cut command, line width, QR code and drawer pin
- **Find my scale** tries every port at the usual baud rates; **scanner** scans are caught even when the cursor is in the quantity box; unknown barcodes offer *Add item*
- Diagnostics: the last 50 hardware calls with result and time
- Step-by-step guide for 80 mm printers in Settings → Print setup

### Purchases & stock
- Keyboard purchase grid: batch, expiry, MRP, free qty, discounts; supplier invoice number required; IGST for other-state suppliers
- **Edit purchase bills** — corrected rates flow into the cost of everything already sold from that stock
- **Supplier coupons / schemes** per item or per purchase line; coupons in hand; redeem for cash / UPI, off the next bill, or free goods
- **Purchases without a GST bill** (local seller): full price is the cost, no input credit, kept out of 2B matching
- Purchase orders with partial receipts, reorder suggestions, bill import from distributor CSV
- Godowns with transfers and godown rent; stock overview and detailed stock report; stock count from a phone

### Money
- **Cash & bank**: cash in drawer, several bank accounts (default account for UPI / card), cheques in hand and waiting to clear
- **Deposit slips**: cash from the drawer plus cheques, into a chosen account; cheques reach the bank when they clear (or bounce and the due comes back)
- Cash ↔ bank and bank ↔ bank transfers, owner withdrawals / capital, other income, drawer count
- Bank statement import (CSV / Excel) with auto-matching, per account
- Money log (who, when, running balance), cash-flow statement, profit & loss
- Payments against chosen bills; WhatsApp payment reminders on a schedule

### Expenses & staff
- Expenses paid now or as bills with due dates; approvals above a limit; petty cash; bill photos; GST input credit
- **Repeating expenses** — daily, every N days / weeks / months, skip weekdays and closed days, pay several days at once or in advance
- Salaries with advances, incentives and festival bonuses; staff money requests from their own PIN

### Khata (customers & suppliers)
- Running statements, credit limits, WhatsApp reminders, bill-wise payments, outstanding reports

### GST
- CGST / SGST / IGST / cess, GST 2.0 slabs; GST rate and cess fill in from the HSN code (editable)
- GSTR-1 and GSTR-3B JSON (GSTN offline-tool format), HSN summary
- e-Invoice (IRN, signed QR) and e-Way Bill — test mode built in, live through a GSP
- GSTR-2B import and matching: what's matched, what credit is at risk
- **Export to Tally** for the CA: masters (ledgers with GSTIN and opening balances, stock items with HSN and GST) and vouchers for any period, each balanced to the paisa; ledger names can be set to the CA's own

### People & control
- Owner / Manager / Cashier / Salesman roles, enforced in the data layer (the screen can't bypass them)
- **Per-person permissions** on top of the role — e.g. *Give credit (udhaar)*, *See purchase cost*, *Cancel or edit bills*
- Delete users (history keeps their name); 4-digit PINs; searchable sign-in grid for many staff
- Plain-language activity log of every change

### Devices, sync & backup
- **Phones on Wi-Fi**: the shop computer serves its data to paired phones on the local network — bill, collect, check stock; print on the counter printer, a Wi-Fi printer, the phone itself, or WhatsApp
- **Android app** (built by CI) — the phone client for the shop Wi-Fi, prints straight to Wi-Fi thermal printers, Save as PDF
- **Cloud sync** (optional, Go server): several counters and phones share one shop, each working offline; stock sold twice while offline is flagged with the bills involved ([docs/SYNC.md](docs/SYNC.md))
- Automatic encrypted backups to **Google Drive** on a schedule; encrypted cloud backups; restore as a separate business
- Several businesses on one computer, each with its own database, staff and open bills

### Moving in
- Import items, opening stock and party balances from Marg, Tally, Busy or any Excel / CSV export — the smart matcher finds the columns. (Marg’s own `.zip` backup is password-protected and can’t be read; export the Stock report and Outstanding to Excel instead — the Import page shows the exact steps.)
- **Staged migration**: checks flag duplicate barcodes, expired stock, impossible GST rates and duplicate parties; fix or skip rows; a trial run imports into a scratch copy and shows the totals (items, stock quantity, stock value at cost, receivable, payable) next to the old software's figures; the real import can be undone exactly, and cloud sync waits until it is kept
- Batch-wise stock with expiry and each batch's own cost; 15,000 items with 30,000 batches import in about 10 seconds
- Day-one cut-over checklist and a migration check to send to the CA
- "Bring in your shop" quick grids for shops that were already running

### Insights
- Live dashboard, 30-day trend, top items, **daily, item and bill profit** (amount and margin %, real FIFO cost after supplier coupons), registers, day book, cash book, outstanding — every report to CSV

---

## How it works

```
 Shop computer (desktop app)                     Phones on the shop Wi-Fi
 ┌───────────────────────────────┐   pair code   ┌───────────────────────────┐
 │ React UI                      │◄─────────────►│ Android app / phone browser│
 │ SQLite (sql.js) in a worker   │  HTTP on LAN  │ no local data: every call  │
 │ Rust: printers, scale, drawer,│               │ runs on the computer       │
 │ files, Wi-Fi server for phones│               └───────────────────────────┘
 └──────────────┬────────────────┘
                │ optional
     ┌──────────▼──────────┐        ┌──────────────────────┐
     │ Hisaab cloud (Go +  │        │ Owner's Google Drive │
     │ Postgres): sync +   │        │ encrypted backups    │
     │ encrypted backups   │        └──────────────────────┘
     └─────────────────────┘
```

**Invariants** — every amount is integer paise; GST is rounded half-up per line so
`taxable + CGST + SGST + IGST + cess = line total` exactly; round-off is an explicit ledger line;
every voucher is double-entry and balances to the paisa; a bill (invoice, lines, batch deductions,
stock moves, payments, ledger) commits in one SQLite transaction. Snapshots are written to disk
right after each change and flushed when the window hides or closes. Permissions are enforced inside
the database worker, so no screen can bypass them.

## Repository

```
packages/core        Pure TypeScript rules: money (paise), GST, units, pricing, schemes, FIFO,
                     barcodes, GSTR builders, roles & permissions. Shared by every client.
apps/desktop         React + Tailwind UI (Vite); SQLite (sql.js WASM) in a Web Worker
  src/db/            adapter → migrations → repositories → permission-checked API
  src/lan/           phones on Wi-Fi: computer bridge and phone client
  src-tauri/         Tauri v2 shell (Rust); src-tauri/hw: printing, scale, file store, Wi-Fi server
server/              Go + Postgres cloud sync and backup service
e2e/                 Playwright journeys (incl. two-browser phone ↔ computer and cloud sync)
.github/workflows/   desktop installers (Windows / macOS) and Android APK
docs/ROADMAP.md      Product checklist
docs/SYNC.md         How devices sync, and what happens when two sell the last packet
```

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit + database tests (Vitest)
npm run typecheck
npm run build && npm run e2e   # Playwright journeys against the production build
npm run perf         # performance budget: bill save < 50 ms with 50k items / 100k bills
cargo test --manifest-path apps/desktop/src-tauri/hw/Cargo.toml   # hardware + Wi-Fi server
```

First launch opens **Create enterprise**: business & contact details, GSTIN and the owner PIN are
validated (GSTIN check digit, mobile, email, PIN code; FSSAI optional). The app ships with no sample
data; the test suites build their own fixture shop.

## Installers

**Download** (no GitHub account needed) — the latest build:

| | |
|---|---|
| Windows | [Hisaab-Setup-Windows.exe](https://github.com/SwayamGPT/Hisaab-ERP/releases/download/latest-build/Hisaab-Setup-Windows.exe) · [.msi](https://github.com/SwayamGPT/Hisaab-ERP/releases/download/latest-build/Hisaab-Windows.msi) |
| macOS | [Hisaab-macOS.dmg](https://github.com/SwayamGPT/Hisaab-ERP/releases/download/latest-build/Hisaab-macOS.dmg) |
| Android | [Hisaab-Android.apk](https://github.com/SwayamGPT/Hisaab-ERP/releases/download/latest-build/Hisaab-Android.apk) |

All files: the [latest build release](https://github.com/SwayamGPT/Hisaab-ERP/releases/tag/latest-build).
Every push updates it; pushing a tag such as `v0.1.0` publishes a versioned release "Hisaab v0.1.0".

**Desktop (Windows / macOS)** — the `Desktop build` workflow builds the Windows `.exe` + `.msi` and a
universal macOS `.dmg` on every push and publishes them as above (also kept as workflow artifacts). Locally:
`cd apps/desktop && npm run tauri build` (needs Rust and the Tauri prerequisites). Builds are unsigned,
so SmartScreen / Gatekeeper warn on first launch.

**Android** — the `Android build` workflow builds the APK on every push and publishes it as above.
Without signing secrets it is debug-signed and installs directly; add `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` to get a signed release APK.

**Auto-update** — the desktop app checks for a new version a few seconds after it starts and every
4 hours, downloads it quietly and shows *Hisaab x.y.z is ready — Restart now / Later*; nothing
changes until someone presses Restart. The Android app shows *Hisaab x.y.z is available — Install*
and Android asks to confirm. Every build gets a rising version (`0.1.<commits>`, or the tag's).
Updates are switched on by adding signing keys as repository secrets
(*GitHub → Settings → Secrets and variables → Actions → New repository secret*). Keep the key files
and passwords safe and private: if they are lost, installed apps cannot receive updates and must be
reinstalled.

1. *Desktop update key* (on any computer with Node.js, inside `apps/desktop` after `npm install`):
   `npx tauri signer generate -w hisaab-updates.key` — choose a password. Add the secrets
   `TAURI_SIGNING_PRIVATE_KEY` (the whole contents of `hisaab-updates.key`),
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (that password) and `TAURI_UPDATER_PUBKEY` (the contents of
   `hisaab-updates.key.pub`).
2. *Android signing key* (needs Java): `keytool -genkeypair -v -keystore hisaab.jks -alias hisaab -keyalg RSA -keysize 2048 -validity 10000`
   — use the same password for the keystore and the key. Add `ANDROID_KEYSTORE_BASE64` (the file as
   base64: `base64 -w0 hisaab.jks` on Linux / macOS, or in PowerShell
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("hisaab.jks"))`), `ANDROID_KEY_ALIAS` (`hisaab`)
   and `ANDROID_KEY_PASSWORD`.

The next push builds signed apps that update themselves. Install that build once by hand: an APK
signed with the new key can't replace one signed with the old test key, so uninstall the old app
from the phone first (pair it again afterwards); desktop installs over the old version as usual.

**Phones on Wi-Fi** — on the shop computer open *Settings → Phones on Wi-Fi*, turn it on and press
*Pair a phone*. Allow Hisaab through the Windows firewall on private networks when asked. Keep the
shop Wi-Fi password-protected; don't forward the port to the internet.

## Cloud sync server (`server/`)

A small Go service (net/http + Postgres 16). Each device keeps its full local database and bills
offline; the server holds the latest version of every row and a change feed, and checks what devices
send (known tables, ids inside the device's own block, invoice lines that add up, vouchers that
balance). Backups are encrypted on the device; the server stores bytes it cannot read.

```bash
cd server
HISAAB_DB=postgres://user:pass@localhost:5432/hisaab go run .          # :8080
HISAAB_TEST_DB=postgres://user:pass@localhost:5432/hisaab_test go test ./...
HISAAB_DB_PASSWORD=change-me docker compose up -d                       # server + Postgres
```

Point the app at it in **Settings → Cloud & devices** (or build with `VITE_HISAAB_SERVER=https://your-host`).
Google Drive backup needs a Google OAuth client ID (Settings → Backup & data, or `VITE_GOOGLE_CLIENT_ID`).

## Keyboard map

`Ctrl K` search anything · `?` shortcuts · `Alt N` new bill · `Alt P` purchase · `Alt S` sales ·
`Alt I` items · `Alt C` parties · `Alt M` money · `Alt R` reports · `Alt G` GST · `Alt L` lock ·
billing: `F4` cash · `F5` UPI · `F6` udhaar · `F7` customer · `F8` discount · `F9` save & print · `F10` save.

## Notes

GST rates in the HSN helper follow the GST 2.0 rationalisation (22 Sep 2025). Rates depend on
packaging and labelling — confirm with your CA; every item's rate can be overridden.
