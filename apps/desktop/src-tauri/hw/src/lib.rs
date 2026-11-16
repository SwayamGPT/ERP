//! Counter hardware for the Hisaab desktop app, kept free of Tauri so it can be unit-tested anywhere.
//!
//! * [`printer`] — send raw bytes (ESC/POS receipts, cash-drawer kick, TSPL/ZPL labels) to a network
//!   printer (port 9100) or to a printer installed in the operating system.
//! * [`scale`] — read a weight from a serial / USB weighing scale.
//! * [`store`] — write the shop's database files atomically, keeping the previous copy and daily backups.
//! * [`guard`] — every device call on its own thread, with a deadline and panics caught, plus a
//!   diagnostics log of the last 50 calls.
//! * [`lan`] — the small web server phones on the shop Wi-Fi use to reach this computer.

pub mod guard;
pub mod lan;
pub mod printer;
pub mod scale;
pub mod store;
