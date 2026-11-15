//! Native shell for Hisaab. The UI and the SQLite engine are the same web build that runs in a
//! browser; this adds what a browser can't do at a shop counter:
//!
//! * database files on disk, saved atomically with daily backups (`store_*`)
//! * raw printing to receipt and label printers — ESC/POS, TSPL, ZPL — and the cash drawer (`print_raw`)
//! * reading a weighing scale over serial / USB (`scale_read`)
//!
//! The hardware code lives in the `hisaab-hw` crate (src-tauri/hw) with its own tests.

use hisaab_hw::{printer, scale, store::Store};
use serde::Serialize;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Manager, State};

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

/// Send raw bytes to a printer. Header x-target: "192.168.1.50:9100" or an installed printer's name.
#[tauri::command]
async fn print_raw(request: Request<'_>) -> Result<(), String> {
    let target = printer::Target::parse(header(&request, "x-target")?)?;
    let bytes = raw_body(&request)?;
    tauri::async_runtime::spawn_blocking(move || printer::send_raw(&target, &bytes)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn printers_list() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(printer::list_system_printers).await.unwrap_or_default()
}

#[tauri::command]
fn serial_ports() -> Vec<String> {
    scale::list_ports()
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
    tauri::async_runtime::spawn_blocking(move || scale::read(&port, baud, Duration::from_millis(1500), request.as_deref().map(str::as_bytes)))
        .await
        .map_err(|e| e.to_string())?
        .map(|r| Weight { kg: r.kg, stable: r.stable })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?.join("data");
            let store = Store::new(dir, 7).map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            app.manage(AppStore(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![app_version, store_read, store_write, store_delete, store_info, print_raw, printers_list, serial_ports, scale_read])
        .run(tauri::generate_context!())
        .expect("error while running Hisaab");
}
