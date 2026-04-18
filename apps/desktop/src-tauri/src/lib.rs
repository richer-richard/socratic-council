//! Socratic Council Tauri Application
//!
//! This is the Rust backend for the Tauri desktop application.
//! Handles HTTP requests with proxy support for AI API calls.

mod allowlist;
mod http;
mod redact;
mod vault_file;

#[cfg(debug_assertions)]
use tauri::Manager;

/// Configure the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(http::RequestRegistry::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Auto-updater: enabled in release builds only. The public key that
    // validates update manifests is pinned in `tauri.conf.json` under
    // `plugins.updater.pubkey`. Release builds with no configured pubkey
    // will panic at first-use — the pubkey must be populated (via CI) before
    // shipping. Debug builds don't load the plugin at all.
    #[cfg(not(debug_assertions))]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            http::http_request,
            http::http_request_stream,
            http::http_cancel,
            vault_file::vault_get_dek,
            vault_file::vault_reset,
        ])
        .setup(|_app| {
            #[cfg(debug_assertions)]
            {
                let window = _app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
