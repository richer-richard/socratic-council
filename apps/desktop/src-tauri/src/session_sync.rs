//! Shared session files — the desktop half of the CLI ↔ app session store.
//!
//! One file per session under `<app data dir>/sessions/<id>.json`, each holding
//! the same `ENC1:` envelope the frontend vault produces (sealed with the file
//! DEK from `vault_file.rs`). The CLI reads and writes the very same files with
//! the very same key, so a debate run in either surface shows up in the other.
//!
//! The commands are deliberately dumb: the frontend encrypts/decrypts and
//! decides what wins (last writer by `updatedAt`); Rust only guards the path
//! (ids are a safe alphabet, never a path) and the file permissions.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

const SESSIONS_DIR: &str = "sessions";

#[derive(Serialize)]
pub struct SharedSessionEntry {
    pub id: String,
    /// File mtime in unix milliseconds — a cheap "changed since I last looked".
    pub modified_ms: u64,
}

/// Ids are file names: keep them to a safe alphabet, never a path.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 120
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn sessions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?
        .join(SESSIONS_DIR);
    ensure_dir(&dir)?;
    Ok(dir)
}

fn ensure_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Failed to create sessions directory: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(dir) {
            let mut perms = meta.permissions();
            perms.set_mode(0o700);
            let _ = fs::set_permissions(dir, perms);
        }
    }
    Ok(())
}

fn path_for(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("Invalid session id".to_string());
    }
    Ok(dir.join(format!("{id}.json")))
}

pub fn list_in(dir: &Path) -> Vec<SharedSessionEntry> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.strip_suffix(".json")?;
            if !valid_id(id) {
                return None;
            }
            let modified_ms = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            Some(SharedSessionEntry { id: id.to_string(), modified_ms })
        })
        .collect()
}

pub fn read_in(dir: &Path, id: &str) -> Result<Option<String>, String> {
    let path = path_for(dir, id)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read session file: {}", e)),
    }
}

/// Owner-only, atomic (temp + rename) write of the sealed envelope.
pub fn write_in(dir: &Path, id: &str, envelope: &str) -> Result<(), String> {
    let path = path_for(dir, id)?;
    if !envelope.starts_with("ENC1:") {
        // Never let a plaintext session land on disk through this path.
        return Err("Session payload must be a sealed ENC1 envelope".to_string());
    }
    let tmp = dir.join(format!(".{id}.json.tmp"));
    let _ = fs::remove_file(&tmp);
    let mut file = open_owner_only(&tmp).map_err(|e| format!("Failed to create session temp file: {}", e))?;
    file.write_all(envelope.as_bytes())
        .map_err(|e| format!("Failed to write session file: {}", e))?;
    file.sync_all().map_err(|e| format!("Failed to sync session file: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Failed to install session file: {}", e)
    })
}

pub fn delete_in(dir: &Path, id: &str) -> Result<bool, String> {
    let path = path_for(dir, id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Failed to delete session file: {}", e)),
    }
}

#[cfg(unix)]
fn open_owner_only(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)
}

#[cfg(not(unix))]
fn open_owner_only(path: &Path) -> std::io::Result<fs::File> {
    fs::OpenOptions::new().write(true).create_new(true).open(path)
}

#[tauri::command]
pub fn session_sync_list(app: tauri::AppHandle) -> Result<Vec<SharedSessionEntry>, String> {
    Ok(list_in(&sessions_dir(&app)?))
}

#[tauri::command]
pub fn session_sync_read(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    read_in(&sessions_dir(&app)?, &id)
}

#[tauri::command]
pub fn session_sync_write(app: tauri::AppHandle, id: String, envelope: String) -> Result<(), String> {
    write_in(&sessions_dir(&app)?, &id, &envelope)
}

#[tauri::command]
pub fn session_sync_delete(app: tauri::AppHandle, id: String) -> Result<bool, String> {
    delete_in(&sessions_dir(&app)?, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        // Tests run in parallel and the clock can hand two of them the same
        // instant, so a counter keeps each folder its own.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "sc-sync-{}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        ensure_dir(&dir).unwrap();
        dir
    }

    #[test]
    fn write_list_read_delete_round_trip() {
        let dir = temp_dir();
        write_in(&dir, "sc-1-abc", "ENC1:AAAA").unwrap();
        let list = list_in(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "sc-1-abc");
        assert!(list[0].modified_ms > 0);
        assert_eq!(read_in(&dir, "sc-1-abc").unwrap().as_deref(), Some("ENC1:AAAA"));
        assert_eq!(read_in(&dir, "missing").unwrap(), None);
        assert!(delete_in(&dir, "sc-1-abc").unwrap());
        assert!(!delete_in(&dir, "sc-1-abc").unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_path_like_ids_and_plaintext() {
        let dir = temp_dir();
        assert!(write_in(&dir, "../etc/passwd", "ENC1:x").is_err());
        assert!(write_in(&dir, "", "ENC1:x").is_err());
        assert!(read_in(&dir, "a/b").is_err());
        assert!(write_in(&dir, "sc-2", "{\"plain\":true}").is_err());
        assert!(list_in(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        write_in(&dir, "sc-3", "ENC1:BBBB").unwrap();
        let mode = fs::metadata(dir.join("sc-3.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }
}
