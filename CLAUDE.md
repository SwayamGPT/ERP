# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Hisaab is an offline-first ERP (billing, stock, GST) for Indian retail/wholesale shops.

## Commands

- Typecheck (do this before committing): `npm run typecheck` (core + desktop projects).
- Unit tests: `npx vitest run`. One file: `npx vitest run packages/core/test/escpos.test.ts`. One test: add `-t "name"`. Watch: `npm run test:watch`.
- Browser/e2e: `npx playwright test --trace off` (or `npm run e2e`). One file: append its path. Playwright **builds and previews** the app first (`npm run build && npm run preview`, port 4173), so a run takes a couple of minutes.
- Cloud-sync e2e (`e2e/cloud.spec.ts`) needs Postgres and the Go server built on the fly. Set `HISAAB_TEST_DB=postgres://hisaab:hisaab@localhost:5432/hisaab_test`; start Postgres with `pg_ctlcluster 16 main start` if `pg_lsclusters` shows it down. Without the env var these tests skip.
- Lint/format: `npm run lint`, `npm run format`.
- Rust (native shell + hardware): `cargo test` and `cargo check` in `apps/desktop/src-tauri/hw` (and `src-tauri`).
- Go (cloud server): `go build ./...` / `go test ./...` in `server/`.
- Run the desktop app: `npm run tauri:dev` (needs Rust + Tauri prerequisites). Browser-only dev: `npm run dev`.
- Perf budgets (gated, off by default): `npm run perf` / `HISAAB_PERF=1 ...`.

## Architecture

npm-workspaces monorepo:

- **`packages/core`** — pure, platform-agnostic TypeScript domain logic, each file re-exported from `src/index.ts` and unit-tested under `test/`: money math, GST/GSTR/e-invoice, HSN catalogue, RBAC, ESC/POS receipt bytes, Tally XML, the smart Excel/CSV importer, validators. No DOM, no Node, no Tauri — so it runs in the browser, the worker and tests alike. Import it as `@hisaab/core`.
- **`apps/desktop`** — the one web build (Vite + React + Tailwind) that is ALSO the browser app, the Tauri desktop app, the Android app and the phone Wi-Fi client. `src-tauri/` is the Rust shell; `src-tauri/hw/` is a separate, unit-tested crate for printing/scale/file-store/LAN.
- **`server/`** — Go + Postgres service for optional cloud sync and encrypted backups.

### Data layer (the most important thing to understand)

The database lives in a **Web Worker** (`apps/desktop/src/db/worker.ts`) running SQLite via sql.js; persisted to IndexedDB (browser) or the native file store (desktop). The UI never touches SQL. Flow:

`UI → call(method, args)` (`db/client.ts`, a typed React-Query wrapper) `→ worker → api[method](ctx, args)` (`db/api.ts`, the single method registry) `→ a repository` (`db/repos/*.ts`).

Invariants, enforced in this layer (not the UI):
- **Money is integer paise** everywhere. No floats for amounts.
- **Double-entry ledger**: every financial mutation posts a voucher via `postVoucher` (`db/repos/base.ts`) whose debits and credits must sum to 0, or it throws. Balances/reports are derived from `ledger_entries`.
- **Permissions**: repos call `guard(ctx, perm)` / `allowed(ctx, perm)` (`db/repos/base.ts`), backed by `can(role, perm, overrides)` in `@hisaab/core` (`rbac.ts`). The screen can't bypass a permission.
- **Schema migrations** are an append-only array in `db/schema.ts` (currently 21). Add a new numbered entry; never edit an applied one.
- `isMutation` (`db/methods.ts`) is a regex over method names that decides cache invalidation and sync — read it before naming a new method (read methods must match it, e.g. end in `.list`/`.get`/… or be added).

### The four surfaces run one codebase

- **Browser**: worker + IndexedDB.
- **Desktop (Tauri)**: adds raw ESC/POS printing, cash drawer, serial scale, atomic file store and the Wi-Fi server — Rust in `src-tauri/`, hardware in `src-tauri/hw/` (every device call is panic-guarded and deadline-bounded in `hw/src/guard.rs`; release profile is `panic = "unwind"`).
- **Android (Tauri mobile)**: the phone client; `src-tauri/android/patch-manifest.mjs` patches cleartext HTTP, window insets, the print bridge and the `hisaab://pair` deep link after `tauri android init`.
- **Phones on Wi-Fi (LAN)**: the phone has no database; its requests are relayed to the shop computer and answered there (`db/lan.ts`, `src/lan/*`, Rust `hw/src/lan.rs`). The `LAN` flag in `db/client.ts` switches the client into relay mode.

### Cloud sync (optional)

`db/sync/`: each device writes ids in its own block and bill numbers in its own series; bills/stock-moves/ledger are append-only, masters are last-writer-wins per row. After a pull, derived columns are recomputed and oversell/credit clashes are flagged into `_sync_alerts` (two devices selling the last unit offline both stand, then the owner is told). `server/api/sync.go` has a matching table whitelist to `db/sync/tables.ts`.

## Conventions

- Prefer existing `@hisaab/core` helpers and the repo/API/worker path over new one-off code; validators and formatters already exist there.
- A new capability is: a migration (if schema changes) → a repo function that guards + posts balanced vouchers → an `api` entry → a typed `call` from the UI. Mirror an existing repo (e.g. `db/repos/invoices.ts`).
- Changes usually need matching unit tests (`vitest`) and, for user flows, a Playwright spec; keep the double-entry books balanced (`reports.health` / `ledgerHealth`).
- CI builds publish the installers/APK to the public `latest-build` GitHub Release; auto-update is off unless signing-key secrets are set (see README "Auto-update").
