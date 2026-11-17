//! Native shell for Hisaab. The UI and the SQLite engine are the same web build that runs in a
//! browser; this adds what a browser can't do at a shop counter:
//!
//! * database files on disk, saved atomically with daily backups (`store_*`)
//! * raw printing to receipt and label printers — ESC/POS, TSPL, ZPL — and the cash drawer (`print_raw`)
//! * reading a weighing scale over serial / USB (`scale_read`, `scale_find`)
//! * every device call runs on its own thread with a deadline and panics caught, so a bad driver
//!   or a hung port returns an error instead of freezing or closing the app (`hw_events` logs them)
//! * "Phones on Wi-Fi": a small web server on the shop network that phones use to reach this
//!   computer's data (`lan_*`); requests are answered by the web view, where the database lives
//!
//! The hardware code lives in the `hisaab-hw` crate (src-tauri/hw) with its own tests.

use hisaab_hw::lan::{local_addresses, Assets, LanServer, Relay};
use hisaab_hw::{guard, printer, scale, store::Store};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use serde::Serialize;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppStore(Store);

fn header<'a>(req: &'a Request<'_>, name: &str) -> Result<&'a str, String> {
    req.headers().get(name).and_then(|v| v.to_str().ok()).ok_or_else(|| format!("missing {name}"))
}

fn raw_body(req: &Request<'_>) -> Result<Vec<u8>, String> {
    match req.body() {
        InvokeBody::Raw(b) => Ok(b.clone()),
        _ => Err("expected raw bytes".into()),
    }
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Read a stored file. An empty response means "not stored yet".
#[tauri::command]
fn store_read(key: String, store: State<'_, AppStore>) -> Result<Response, String> {
    Ok(Response::new(store.0.read(&key)?.unwrap_or_default()))
}

/// Save a file atomically. Headers: x-key, x-today (yyyy-mm-dd, for the daily backup copy).
#[tauri::command]
fn store_write(request: Request<'_>, store: State<'_, AppStore>) -> Result<(), String> {
    let key = header(&request, "x-key")?;
    let today = header(&request, "x-today").unwrap_or("undated");
    store.0.write(key, &raw_body(&request)?, today)
}

#[tauri::command]
fn store_delete(key: String, store: State<'_, AppStore>) -> Result<(), String> {
    store.0.delete(&key)
}

/// Where the files are (shown in Settings so the owner can copy them to a pen drive).
#[tauri::command]
fn store_info(key: String, store: State<'_, AppStore>) -> (String, Vec<String>) {
    (store.0.dir().display().to_string(), store.0.backups(&key))
}

/// Run a device call off the UI thread, with a deadline and panics caught (see `hisaab_hw::guard`).
async fn hw<T, F>(device: &'static str, secs: u64, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || guard::guarded(device, Duration::from_secs(secs), f)).await.map_err(|e| e.to_string())?
}

/// Send raw bytes to a printer (three tries). Header x-target: "192.168.1.50:9100" or an installed printer's name.
#[tauri::command]
async fn print_raw(request: Request<'_>) -> Result<(), String> {
    let target = printer::Target::parse(header(&request, "x-target")?)?;
    let bytes = raw_body(&request)?;
    hw("printer", 30, move || printer::send_reliably(&target, &bytes)).await
}

#[tauri::command]
async fn printers_list() -> Vec<String> {
    hw("printer list", 10, || Ok(printer::list_system_printers())).await.unwrap_or_default()
}

#[tauri::command]
async fn serial_ports() -> Vec<String> {
    hw("serial ports", 5, || Ok(scale::list_ports())).await.unwrap_or_default()
}

#[derive(Serialize)]
struct HwEvent {
    at: u64,
    device: String,
    ok: bool,
    detail: String,
    ms: u64,
}

/// The last 50 printer / scale calls, newest first (Settings → Hardware → Diagnostics).
#[tauri::command]
fn hw_events() -> Vec<HwEvent> {
    guard::events().into_iter().map(|e| HwEvent { at: e.at, device: e.device, ok: e.ok, detail: e.detail, ms: e.ms }).collect()
}

#[derive(Serialize)]
struct FoundScale {
    port: String,
    baud: u32,
    request: Option<String>,
    kg: f64,
}

/// "Find my scale": try every serial port at the usual speeds; put something on the scale first.
#[tauri::command]
async fn scale_find() -> Result<Option<FoundScale>, String> {
    hw("scale search", 120, || Ok(scale::find(Duration::from_millis(700)).map(|f| FoundScale { port: f.port, baud: f.baud, request: f.request, kg: f.reading.kg }))).await
}

#[derive(Serialize)]
struct Weight {
    kg: f64,
    stable: bool,
}

/// Read the scale: first steady weight within ~1.5 s. `request` is sent first for scales that only
/// answer when asked (e.g. "W" or "P\r").
#[tauri::command]
async fn scale_read(port: String, baud: u32, request: Option<String>) -> Result<Weight, String> {
    let request = request.map(|r| r.replace("\\r", "\r").replace("\\x05", "\x05"));
    hw("scale", 4, move || scale::read(&port, baud, Duration::from_millis(1500), request.as_deref().map(str::as_bytes)))
        .await
        .map(|r| Weight { kg: r.kg, stable: r.stable })
}

/* ───────── phones on Wi-Fi ───────── */

#[derive(Default)]
struct Lan {
    server: Mutex<Option<LanServer>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>,
    next: Arc<AtomicU64>,
}

#[derive(Serialize)]
struct LanInfo {
    running: bool,
    port: u16,
    addresses: Vec<String>,
}

#[derive(Serialize, Clone)]
struct LanCall {
    rid: u64,
    path: String,
    body: String,
}

fn lan_info_of(lan: &Lan) -> LanInfo {
    let g = lan.server.lock().unwrap_or_else(|e| e.into_inner());
    LanInfo { running: g.is_some(), port: g.as_ref().map(|s| s.port).unwrap_or(0), addresses: local_addresses() }
}

#[tauri::command]
fn lan_start(app: AppHandle, port: u16, lan: State<'_, Lan>) -> Result<LanInfo, String> {
    if let Some(old) = lan.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
        old.stop();
    }
    let files = app.clone();
    let assets: Assets = Arc::new(move |path: &str| {
        let a = files.asset_resolver().get(path.to_string()).or_else(|| files.asset_resolver().get(format!("/{path}")))?;
        Some((a.bytes().to_vec(), a.mime_type().to_string()))
    });
    let (pending, next, view) = (lan.pending.clone(), lan.next.clone(), app.clone());
    let relay: Relay = Arc::new(move |op: &str, body: String| {
        let rid = next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        pending.lock().unwrap_or_else(|e| e.into_inner()).insert(rid, tx);
        if let Err(e) = view.emit_to("main", "lan-call", LanCall { rid, path: op.to_string(), body }) {
            pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&rid);
            return Err(e.to_string());
        }
        let out = rx.recv_timeout(Duration::from_secs(20));
        pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&rid);
        out.map_err(|_| "The shop computer did not answer in time. Is Hisaab open and unlocked there?".to_string())
    });
    let server = LanServer::start(port, assets, relay)?;
    *lan.server.lock().unwrap_or_else(|e| e.into_inner()) = Some(server);
    Ok(lan_info_of(&lan))
}

#[tauri::command]
fn lan_stop(lan: State<'_, Lan>) -> LanInfo {
    if let Some(s) = lan.server.lock().unwrap_or_else(|e| e.into_inner()).take() {
        s.stop();
    }
    lan_info_of(&lan)
}

#[tauri::command]
fn lan_info(lan: State<'_, Lan>) -> LanInfo {
    lan_info_of(&lan)
}

/// The web view's answer to a phone request.
#[tauri::command]
fn lan_reply(rid: u64, body: String, lan: State<'_, Lan>) {
    if let Some(tx) = lan.pending.lock().unwrap_or_else(|e| e.into_inner()).remove(&rid) {
        let _ = tx.send(body);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().plugin(tauri_plugin_opener::init());
    // Updates are checked and downloaded from the web view (features/updates); the plugins do the
    // signature check, the install and the restart.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build()).plugin(tauri_plugin_process::init());
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("data");
            let store = Store::new(dir, 7).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(AppStore(store));
            app.manage(Lan::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version, store_read, store_write, store_delete, store_info, print_raw, printers_list, serial_ports, scale_read, scale_find, hw_events, lan_start, lan_stop, lan_info, lan_reply])
        .run(tauri::generate_context!())
        .expect("error while running Hisaab");
}
