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
        // No tauri-plugin-http: the webview has NO direct network path. Every
        // outbound call is brokered by http.rs behind the allowlist.
        // No tauri-plugin-store either: nothing in the front end imports it,
        // and config, secrets and the session index all ride the vault.
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

#[cfg(test)]
mod tests {
    use serde_json::Value;

    /// The capability file is the app's whole permission surface, and it is easy
    /// to widen by reaching for a plugin's `default` set. Two of those grant far
    /// more than this app calls: `fs:default` carries
    /// `read-app-specific-dirs-recursive`, which lets the webview read the app
    /// data directory — `vault.key` and every sealed session file with it — and
    /// `opener:default` carries an unscoped reveal-in-dir. The front end calls
    /// `writeFile` and `openPath` and nothing else, both under a path scope.
    #[test]
    fn the_capability_file_grants_only_what_the_front_end_calls() {
        let raw = include_str!("../capabilities/default.json");
        let cap: Value = serde_json::from_str(raw).expect("capabilities/default.json is JSON");
        let permissions = cap["permissions"].as_array().expect("permissions is a list");

        let mut plain: Vec<&str> = Vec::new();
        for entry in permissions {
            match entry {
                Value::String(id) => plain.push(id),
                Value::Object(scoped) => {
                    let id = scoped["identifier"].as_str().expect("scoped identifier");
                    assert!(
                        scoped.get("allow").and_then(|a| a.as_array()).is_some_and(|a| !a.is_empty()),
                        "{id} takes a path and must carry an allow scope"
                    );
                    // A path-taking permission is only ever granted under a scope.
                    assert!(
                        id.starts_with("fs:") || id.starts_with("opener:"),
                        "unexpected scoped permission {id}"
                    );
                }
                other => panic!("unexpected permission entry: {other}"),
            }
        }

        // `core:default` is the IPC itself; every other plugin default set pulls
        // in commands nothing calls.
        for id in &plain {
            assert!(
                *id == "core:default" || !id.ends_with(":default"),
                "{id} is a plugin default set — name the commands instead"
            );
        }
        // Nothing may read through the fs plugin: the DEK and the sealed
        // sessions live where those permissions would reach.
        for entry in permissions {
            let id = match entry {
                Value::String(id) => id.as_str(),
                Value::Object(o) => o["identifier"].as_str().unwrap_or(""),
                _ => "",
            };
            assert!(
                !(id.starts_with("fs:") && id.contains("read")),
                "{id} would let the webview read the app data directory"
            );
        }
    }
}
