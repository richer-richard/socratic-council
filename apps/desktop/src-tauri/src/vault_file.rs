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

use std::fs;
use std::path::{Path, PathBuf};

use tauri::Manager;

const DEK_FILENAME: &str = "vault.key";
const DEK_LEN: usize = 32;

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

fn write_dek(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("Failed to write DEK file: {}", e))?;
    restrict_permissions(path)?;
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

/// Get (or create on first run) the 32-byte data-encryption key that the
/// frontend vault uses to encrypt sessions, attachments, and stored
/// secrets. Returned as a `Vec<u8>` — Tauri serializes it as a number
/// array which the TS side wraps into a `Uint8Array`.
#[tauri::command]
pub fn vault_get_dek(app: tauri::AppHandle) -> Result<Vec<u8>, String> {
    let path = resolve_dek_path(&app)?;

    if path.exists() {
        match read_dek(&path) {
            Ok(bytes) => return Ok(bytes),
            Err(err) => {
                // Corrupt / wrong-size file: regenerate rather than fail outright.
                // This is destructive for encrypted payloads already on disk, but
                // those would already be unreadable with a broken DEK.
                eprintln!("[vault] {} — regenerating", err);
            }
        }
    }

    let fresh = generate_dek()?;
    write_dek(&path, &fresh)?;
    Ok(fresh.to_vec())
}

/// Delete the DEK file — used if the user explicitly resets the vault.
/// Any at-rest encrypted sessions become unrecoverable after this call.
#[tauri::command]
pub fn vault_reset(app: tauri::AppHandle) -> Result<bool, String> {
    let path = resolve_dek_path(&app)?;
    if !path.exists() {
        return Ok(false);
    }
    fs::remove_file(&path).map_err(|e| format!("Failed to delete DEK file: {}", e))?;
    Ok(true)
}
