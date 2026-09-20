//! Socratic Council Tauri Application
//!
//! This is the Rust backend for the Tauri desktop application.
//! Handles HTTP requests with proxy support for AI API calls.

#![forbid(unsafe_code)]

mod allowlist;
mod engine_host;
mod http;
mod redact;
mod session_sync;
mod vault_file;

#[cfg(debug_assertions)]
use tauri::Manager;

/// Configure the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(http::RequestRegistry::default())
        .manage(engine_host::EngineRegistry::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        // No tauri-plugin-http: the webview has NO direct network path. Every
        // outbound call is brokered by http.rs behind the allowlist.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Auto-updater: enabled in release builds only when a non-empty
    // `plugins.updater.pubkey` is configured in `tauri.conf.json`.
    //
    // Fix 7.9: previously the plugin always loaded in release builds, so a
    // local `pnpm tauri:build` (without the CI-injected pubkey) would
    // produce a binary that panicked on first auto-update check. The
    // build script writes `SC_UPDATER_PUBKEY_PRESENT=1` to the env when
    // a real pubkey was injected; absent that env var we skip the plugin
    // and the binary just doesn't auto-update.
    #[cfg(not(debug_assertions))]
    {
        if option_env!("SC_UPDATER_PUBKEY_PRESENT").map(|v| v == "1").unwrap_or(false) {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        } else {
            eprintln!(
                "[updater] SC_UPDATER_PUBKEY_PRESENT not set — skipping the auto-updater plugin. \
                 Set this env var at build time once a real signing pubkey is wired into tauri.conf.json."
            );
        }
    }

    builder
        .invoke_handler(tauri::generate_handler![
            http::http_request,
            http::http_request_stream,
            http::http_cancel,
            vault_file::vault_get_dek,
            vault_file::vault_reset,
            session_sync::session_sync_list,
            session_sync::session_sync_read,
            session_sync::session_sync_write,
            session_sync::session_sync_delete,
            engine_host::engine_start,
            engine_host::engine_input,
            engine_host::engine_cancel,
            engine_host::engine_catalog,
            engine_host::engine_scan,
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
