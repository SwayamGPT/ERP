//! Native shell for Hisaab. The UI and the SQLite engine are the same web build that runs in a
//! browser. Native commands added in R2: raw ESC/POS & TSPL printing, cash-drawer kick,
//! serial weighing-scale reader and native SQLite storage (see docs/ROADMAP.md).

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running Hisaab");
}
