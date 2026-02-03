//! Socratic Council Tauri Application
//!
//! This is the Rust backend for the Tauri desktop application.
//! The main AI processing is handled by the Node.js sidecar.

#[cfg(debug_assertions)]
use tauri::Manager;

/// Configure the Tauri application
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
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
