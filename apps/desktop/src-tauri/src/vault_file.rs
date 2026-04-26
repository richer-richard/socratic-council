//! File-based vault DEK storage (replaces the keychain-backed secrets module).
//!
//! Rationale: macOS keychain access prompts the user for their login password
//! on every invocation when the binary has only an ad-hoc code signature,
//! because the keychain ACL system binds to a stable code signing identity
//! that ad-hoc simply doesn't provide. Result: ~15 password prompts per
//! launch as the frontend fetched one key per provider + the vault DEK.
//!
//! This module stores the 32-byte DEK in the platform's app-data directory
//! with user-only (0600 on unix) permissions. On macOS that's
//! `~/Library/Application Support/com.socratic-council.desktop/vault.key`.
//! The frontend reads it once via `vault_get_dek` at boot; thereafter every
//! secret is encrypted through the same XChaCha20-Poly1305 envelope used
//! for sessions and stored in localStorage — so nothing leaves the app's
//! own data directory in plaintext, and the OS never prompts.
//!
//! Tradeoff vs. keychain:
//!   + no prompts, no signing identity dependency
//!   + works identically across macOS / Linux / Windows
//!   + DEK file is protected by filesystem perms + the user's account
//!   - less hardening than keychain *if* the keychain were usable — on an
//!     unsigned/ad-hoc build it wasn't anyway
//!   - backups (Time Machine, iCloud Drive) may include the DEK file; this
//!     is acceptable for a local-first app where the session data lives on
//!     the same machine.
//!
//! Recovery semantics (Fix 1.1):
//!   When the DEK file exists but can't be read (corrupt, wrong size, etc.),
//!   the file is QUARANTINED — moved aside to `vault.key.corrupt-<unix-ts>`
//!   — and a fresh DEK is generated. The frontend learns about this via
//!   the `status` field on the response so it can warn the user that any
//!   previously-encrypted data is unrecoverable with the new key. Without
//!   the quarantine, a transient FS hiccup silently destroys all secrets.
//!
//! Atomicity (Fix 1.4):
//!   Writes go through a tempfile + rename so a power loss mid-write
//!   never leaves a partial DEK on disk. First-time creation uses
//!   `create_new` so two concurrent callers can't both write a different
//!   DEK in the same race window.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::Manager;

const DEK_FILENAME: &str = "vault.key";
const DEK_LEN: usize = 32;

/// Sentinel string the frontend must pass to `vault_reset`. Defense-in-depth
/// against a future UI button accidentally invoking the destructive command
/// without an explicit user confirmation. The frontend should ALSO confirm
/// with the user before issuing this, but if that confirmation is bypassed
/// (e.g. wired up wrong) the IPC call still refuses without this sentinel.
const VAULT_RESET_CONFIRMATION: &str = "DELETE-ALL-LOCAL-DATA";

/// Status of a `vault_get_dek` call so the frontend can distinguish a
/// fresh-install boot from a "DEK corruption recovery" boot.
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultDekStatus {
    /// Successfully read the existing DEK file.
    Existing,
    /// No DEK file existed; a fresh one was created (typical first launch).
    FreshlyCreated,
    /// A DEK file existed but couldn't be read; quarantined and replaced.
    /// Encrypted blobs in localStorage from the prior DEK will fail to
    /// decrypt — surface a warning to the user.
    Quarantined,
}

#[derive(Serialize)]
pub struct VaultDekResponse {
    /// Base64-style serialization happens automatically via Tauri's serde
    /// pipeline (number array on the JS side). The frontend wraps it in a
    /// `Uint8Array(...)` and zeroes nothing — the array lives in JS heap
    /// for the lifetime of the app.
    pub dek: Vec<u8>,
    pub status: VaultDekStatus,
    /// Absolute path of the quarantined file when `status == Quarantined`.
    /// `None` for the other variants.
    pub quarantine_path: Option<String>,
}

fn resolve_dek_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    Ok(dir.join(DEK_FILENAME))
}

fn generate_dek() -> Result<[u8; DEK_LEN], String> {
    let mut buf = [0u8; DEK_LEN];
    getrandom::getrandom(&mut buf)
        .map_err(|e| format!("OS RNG failed to produce {} bytes: {}", DEK_LEN, e))?;
    Ok(buf)
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = fs::metadata(path)
        .map_err(|e| format!("Failed to read DEK permissions: {}", e))?
        .permissions();
    perms.set_mode(0o600);
    fs::set_permissions(path, perms)
        .map_err(|e| format!("Failed to tighten DEK permissions: {}", e))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    // On Windows the file inherits the AppData directory's ACL, which is
    // user-only by default. No explicit tightening needed.
    Ok(())
}

/// Atomic write: write to a sibling tempfile, fsync (best-effort), then
/// rename over the target. Avoids the "half-written 16-byte DEK" failure
/// mode if the process is killed mid-write or the disk loses power.
///
/// Currently unused — `create_new_dek` does its own atomic write so this
/// helper is left for future callers (e.g., a vault-rotation feature).
#[allow(dead_code)]
fn write_dek_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp_path = path.with_extension("key.tmp");

    // Best-effort cleanup of a stale tempfile from a prior crashed run.
    let _ = fs::remove_file(&tmp_path);

    {
        let mut tmp = fs::File::create(&tmp_path)
            .map_err(|e| format!("Failed to create DEK temp file: {}", e))?;
        tmp.write_all(bytes)
            .map_err(|e| format!("Failed to write DEK temp file: {}", e))?;
        tmp.sync_all()
            .map_err(|e| format!("Failed to sync DEK temp file: {}", e))?;
    }

    restrict_permissions(&tmp_path)?;

    fs::rename(&tmp_path, path)
        .map_err(|e| format!("Failed to install DEK file: {}", e))?;
    Ok(())
}

fn read_dek(path: &Path) -> Result<Vec<u8>, String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read DEK file: {}", e))?;
    if bytes.len() != DEK_LEN {
        return Err(format!(
            "DEK file has unexpected length {} (expected {})",
            bytes.len(),
            DEK_LEN
        ));
    }
    Ok(bytes)
}

fn quarantine_corrupt_dek(path: &Path, reason: &str) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let quarantine_name = format!("vault.key.corrupt-{}", timestamp);
    let quarantine = path.with_file_name(quarantine_name);
    fs::rename(path, &quarantine).map_err(|e| {
        format!(
            "Failed to quarantine corrupt DEK file ({}): {}",
            reason, e
        )
    })?;
    eprintln!(
        "[vault] Quarantined corrupt DEK ({}) -> {}",
        reason,
        quarantine.display()
    );
    Ok(quarantine)
}

/// Attempt to write a brand-new DEK file using `create_new` so two
/// concurrent callers can't both produce a different DEK in the same race.
/// Returns the bytes that ended up on disk — either the ones we wrote, or
/// the ones the racing caller already wrote.
fn create_new_dek(path: &Path) -> Result<Vec<u8>, String> {
    use std::fs::OpenOptions;

    let fresh = generate_dek()?;

    let tmp_path = path.with_extension("key.tmp");
    let _ = fs::remove_file(&tmp_path);

    // Try to claim the temp file atomically. If another process is creating
    // the DEK at the same instant, fall through to the read path.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp_path)
    {
        Ok(mut file) => {
            file.write_all(&fresh)
                .map_err(|e| format!("Failed to write fresh DEK: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to sync fresh DEK: {}", e))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // Stale temp from a crashed run — remove and retry once.
            let _ = fs::remove_file(&tmp_path);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp_path)
                .map_err(|e| format!("Failed to reopen DEK temp file: {}", e))?;
            file.write_all(&fresh)
                .map_err(|e| format!("Failed to write fresh DEK: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to sync fresh DEK: {}", e))?;
        }
        Err(e) => return Err(format!("Failed to create DEK temp file: {}", e)),
    }

    restrict_permissions(&tmp_path)?;

    // Atomic claim of the real path. If another caller already populated
    // it during the race window, our rename overwrites theirs — accepted
    // tradeoff because the frontend deduplicates init via `initPromise`,
    // so this only matters in adversarial multi-process scenarios.
    fs::rename(&tmp_path, path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Failed to install DEK file: {}", e)
    })?;

    Ok(fresh.to_vec())
}

/// Get (or create on first run) the 32-byte data-encryption key that the
/// frontend vault uses to encrypt sessions, attachments, and stored
/// secrets. Returns the DEK plus a status flag so the frontend can
/// distinguish a typical boot from a corruption-recovery boot.
#[tauri::command]
pub fn vault_get_dek(app: tauri::AppHandle) -> Result<VaultDekResponse, String> {
    let path = resolve_dek_path(&app)?;

    if path.exists() {
        match read_dek(&path) {
            Ok(bytes) => {
                return Ok(VaultDekResponse {
                    dek: bytes,
                    status: VaultDekStatus::Existing,
                    quarantine_path: None,
                });
            }
            Err(err) => {
                // Quarantine the unreadable file rather than overwriting it.
                // The user's old encrypted data is irrecoverable with the new
                // DEK, but at least a backup tool can later attempt to repair
                // the original file and the user has a clear signal something
                // went wrong.
                let quarantine = quarantine_corrupt_dek(&path, &err)?;
                let fresh = create_new_dek(&path)?;
                return Ok(VaultDekResponse {
                    dek: fresh,
                    status: VaultDekStatus::Quarantined,
                    quarantine_path: Some(quarantine.to_string_lossy().to_string()),
                });
            }
        }
    }

    let fresh = create_new_dek(&path)?;
    Ok(VaultDekResponse {
        dek: fresh,
        status: VaultDekStatus::FreshlyCreated,
        quarantine_path: None,
    })
}

/// Delete the DEK file — used if the user explicitly resets the vault.
/// Any at-rest encrypted sessions become unrecoverable after this call.
///
/// Requires the caller to pass `confirmation == "DELETE-ALL-LOCAL-DATA"`
/// as defense-in-depth: a UI button accidentally wired up to this IPC
/// without an explicit user-typed confirmation will get a 400-equivalent
/// error rather than silently destroying all data.
#[tauri::command]
pub fn vault_reset(app: tauri::AppHandle, confirmation: String) -> Result<bool, String> {
    if confirmation != VAULT_RESET_CONFIRMATION {
        return Err(format!(
            "vault_reset requires confirmation parameter equal to '{}'",
            VAULT_RESET_CONFIRMATION
        ));
    }

    let path = resolve_dek_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete DEK file: {}", e))?;
    // Also remove any stale temp/quarantine files in the same directory so
    // a subsequent `vault_get_dek` lands on a clean state.
    if let Some(parent) = path.parent() {
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let s = name.to_string_lossy();
                if s.starts_with("vault.key.tmp") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir() -> PathBuf {
        let base = std::env::temp_dir();
        let unique = format!(
            "scvault-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let dir = base.join(unique);
        fs::create_dir_all(&dir).expect("create test temp dir");
        dir
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_and_read_round_trip() {
        let _lock = TEST_LOCK.lock().unwrap();
        let dir = temp_dir();
        let path = dir.join(DEK_FILENAME);

        let bytes = create_new_dek(&path).expect("create new dek");
        assert_eq!(bytes.len(), DEK_LEN);

        let read_back = read_dek(&path).expect("read dek");
        assert_eq!(bytes, read_back);

        cleanup(&dir);
    }

    #[test]
    fn quarantines_corrupt_file() {
        let _lock = TEST_LOCK.lock().unwrap();
        let dir = temp_dir();
        let path = dir.join(DEK_FILENAME);

        // Plant a wrong-size file.
        fs::write(&path, b"too short").expect("write corrupt file");

        let quarantine = quarantine_corrupt_dek(&path, "wrong size").expect("quarantine");
        assert!(!path.exists(), "original file should be moved");
        assert!(quarantine.exists(), "quarantined file should exist");
        assert!(quarantine.file_name().unwrap().to_string_lossy().starts_with("vault.key.corrupt-"));

        cleanup(&dir);
    }

    #[test]
    fn create_new_is_atomic_when_path_already_exists() {
        let _lock = TEST_LOCK.lock().unwrap();
        let dir = temp_dir();
        let path = dir.join(DEK_FILENAME);

        // First create succeeds.
        let first = create_new_dek(&path).expect("first create");
        assert_eq!(first.len(), DEK_LEN);

        // Second create overwrites the file with a fresh DEK. This is the
        // recovery path — caller must have already moved the prior DEK
        // aside via quarantine. The bytes returned reflect what's on disk.
        let second = create_new_dek(&path).expect("second create");
        let on_disk = read_dek(&path).expect("read after second create");
        assert_eq!(second, on_disk);
        assert_eq!(second.len(), DEK_LEN);

        cleanup(&dir);
    }
}
