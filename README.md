# Hisaab

**Billing, stock & GST that just works** — a fast, offline-first business app for Indian kirana
stores, supermarkets and wholesalers. A modern alternative to legacy ERPs: plain language, a
keyboard-first counter, and GST returns in one click.

> Release R1 (this repo): the complete offline desktop app. See [`docs/ROADMAP.md`](docs/ROADMAP.md)
> for the full product checklist and what comes next (cloud sync, mobile apps, native printing).

## What's inside

| | |
|---|---|
| **Counter billing** | Several bills open at once (F2 new, F3 next, Alt+1…9) · one search box for name / code / barcode / weighing-scale stickers · F4 cash, F5 UPI QR, F6 udhaar, F8 discount, F9 save & print · GST breakup always visible · tier prices, schemes, FIFO batches |
| **Printing** | 5 templates — classic & big-print receipts, GST tax invoice, modern A4, half-page A5 — with live preview; choose full GST breakup, totals only, or none (B2B bills always keep tax totals) |
| **Stock** | Multi-unit (piece / box / carton, kg & g), batches & expiry with FIFO, low-stock & expiry alerts, adjustments, barcode labels |
| **Purchases** | Keyboard grid with batch, expiry, MRP, free qty; IGST input for other-state suppliers; debit notes |
| **Khata** | Customers & suppliers, credit limits, running statements, WhatsApp reminders, money in / out, expenses, cash & bank book |
| **GST** | CGST/SGST/IGST/cess, GSTR-1 & GSTR-3B JSON (GSTN offline-tool format), HSN summary, e-Way Bill JSON, GST 2.0 slabs |
| **Insights** | Live dashboard, 30-day trend, top items, item & bill profit (FIFO cost), registers, day book, outstanding — every report to CSV |
| **Control** | Owner / Manager / Cashier PINs enforced in the data layer, audit log, backup & restore |

## Architecture

```
packages/core     Pure TypeScript business rules — money (integer paise), GST, units, pricing,
                  schemes, FIFO, barcodes, GSTR builders, RBAC. No DOM; reused by mobile/backends.
apps/desktop      React + Tailwind UI (Vite). SQLite (sql.js WASM) runs in a Web Worker:
  src/db/         adapter → migrations → repositories → api (permission-checked)
  src-tauri/      Tauri v2 native shell (scaffold)
e2e/              Playwright user journeys
docs/ROADMAP.md   Full product checklist
```

**Invariants** — every amount is integer paise; GST is rounded half-up per line so
`taxable + CGST + SGST + IGST + cess = line total` exactly; round-off is an explicit ledger line;
every voucher is double-entry and balances to the paisa; a bill (invoice, lines, batch deductions,
stock moves, payments, ledger) commits in one SQLite transaction; nested failures roll back to a
savepoint. Snapshots go to IndexedDB 150 ms after each write and are flushed when the window hides
or closes. Permissions are enforced inside the worker, so the UI cannot bypass them.

**Why no Go/Rust server yet?** R1 has no server: billing speed comes from SQLite on the shop PC.
The R2 cloud backend will be **Go** (simple, fast, cheap to run, easy to hire for). **Rust** is used
where it pays off — inside the Tauri shell for printers, scales and the cash drawer. Tax maths stays
in `@hisaab/core` so desktop, mobile and web agree; the backend checks itself against the shared
golden fixtures in `packages/core/fixtures`.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # unit + database tests (Vitest)
npm run typecheck
npm run build && npm run e2e   # Playwright journeys against the production build
```

First launch opens **Create enterprise**: business & contact details, GSTIN, FSSAI licence and the
owner PIN are mandatory and validated (GSTIN check digit, 14-digit FSSAI, mobile, email, PIN code).
Several enterprises can live on one computer, each with its own database, staff PINs and open bills —
switch from the name at the top of the sidebar. The app ships with no sample data; the test suites
build their own fixture shop.

### Desktop installer (Tauri)

Needs Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

**From GitHub (recommended):** the `Desktop build` workflow (`.github/workflows/desktop-build.yml`)
builds the Windows `.exe` setup + `.msi` and a universal macOS `.dmg`. Run it from the Actions tab
(*Run workflow*) and download the `hisaab-windows` / `hisaab-macos` artifacts, or push a tag such as
`v0.1.0` to get a draft GitHub Release with the installers attached.

**Locally:**

```bash
cd apps/desktop
npm run tauri build      # → src-tauri/target/release/bundle
```

Builds are unsigned, so Windows SmartScreen and macOS Gatekeeper will warn on first launch (on a Mac:
right-click → Open). Code signing can be added to the workflow later with a certificate and Apple
Developer account.

## Keyboard map

`Ctrl K` search anything · `?` shortcuts · `Alt N` new bill · `Alt P` purchase · `Alt S` sales ·
`Alt I` items · `Alt C` parties · `Alt M` money · `Alt R` reports · `Alt G` GST · `Alt L` lock.

## Notes

GST rates in the HSN helper follow the GST 2.0 rationalisation (22 Sep 2025). Rates depend on
packaging and labelling — confirm with your CA; every item's rate can be overridden.
