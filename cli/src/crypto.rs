//! Portable at-rest secret encryption — XChaCha20-Poly1305 (`ENC1:` envelopes)
//! plus a file-based 32-byte data-encryption key (DEK).
//!
//! **No OS keychain.** Pure Rust (`chacha20poly1305` + `base64` + `getrandom`),
//! so it builds and runs identically on macOS / Linux / Windows — a plain
//! `cargo install socratic-council` works everywhere with no platform crypto
//! services and no C toolchain beyond what the optional desktop bridge needs.
//!
//! Envelope format — byte-compatible with the desktop app's `vault.ts`:
//!
//! ```text
//!   ENC1:<base64( nonce[24] || ciphertext || tag[16] )>
//! ```
//!
//! so a secret the desktop app sealed and one the CLI sealed are mutually
//! readable given the same DEK. A 256-bit symmetric key is already
//! post-quantum-safe for data at rest (Grover only square-roots the search
//! space → ~128-bit), which is why this — not a PQ KEM like ML-KEM, which
//! solves key *exchange*, not local encryption — is the right primitive here.

use base64::Engine as _;
use chacha20poly1305::{aead::Aead, KeyInit, XChaCha20Poly1305, XNonce};
use std::path::Path;

pub const ENC_PREFIX: &str = "ENC1:";
pub const DEK_LEN: usize = 32;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

/// Whether a value is one of our `ENC1:` envelopes (vs. legacy plaintext).
pub fn is_enveloped(value: &str) -> bool {
    value.starts_with(ENC_PREFIX)
}

fn fill_random(buf: &mut [u8]) -> Result<(), String> {
    getrandom::getrandom(buf).map_err(|e| format!("OS RNG failed: {e}"))
}

/// Encrypt bytes into an `ENC1:` envelope, sealing under a fresh random nonce.
pub fn encrypt(dek: &[u8; DEK_LEN], plaintext: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; NONCE_LEN];
    fill_random(&mut nonce)?;
    let cipher = XChaCha20Poly1305::new_from_slice(dek).map_err(|e| e.to_string())?;
    let sealed = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|_| "encryption failed".to_string())?;
    let mut combined = Vec::with_capacity(NONCE_LEN + sealed.len());
    combined.extend_from_slice(&nonce);
    combined.extend_from_slice(&sealed);
    Ok(format!("{ENC_PREFIX}{}", base64::engine::general_purpose::STANDARD.encode(combined)))
}

/// Decrypt an `ENC1:` envelope. Returns `None` on any failure — not enveloped,
/// bad base64, short payload, wrong key, or tag mismatch. Callers that want
/// legacy-plaintext passthrough should check [`is_enveloped`] first.
pub fn decrypt(dek: &[u8; DEK_LEN], envelope: &str) -> Option<Vec<u8>> {
    let b64 = envelope.strip_prefix(ENC_PREFIX)?;
    let payload = base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()?;
    if payload.len() < NONCE_LEN + TAG_LEN {
        return None;
    }
    let (nonce, body) = payload.split_at(NONCE_LEN);
    let cipher = XChaCha20Poly1305::new_from_slice(dek).ok()?;
    cipher.decrypt(XNonce::from_slice(nonce), body).ok()
}

/// Encrypt a UTF-8 string into an `ENC1:` envelope.
pub fn encrypt_str(dek: &[u8; DEK_LEN], plaintext: &str) -> Result<String, String> {
    encrypt(dek, plaintext.as_bytes())
}

/// Decrypt an `ENC1:` envelope back to a UTF-8 string (`None` on any failure).
pub fn decrypt_str(dek: &[u8; DEK_LEN], envelope: &str) -> Option<String> {
    String::from_utf8(decrypt(dek, envelope)?).ok()
}

/// Read a 32-byte DEK from `path` if it exists and is well-formed. **Read-only**
/// — used to read the desktop app's `vault.key` without ever creating one.
pub fn load_dek(path: &Path) -> Option<[u8; DEK_LEN]> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() != DEK_LEN {
        return None;
    }
    let mut dek = [0u8; DEK_LEN];
    dek.copy_from_slice(&bytes);
    Some(dek)
}

/// Load the DEK at `path`, creating a fresh random one (owner-only `0600`) on
/// first use. For the CLI's OWN key store — never point this at the app's vault.
///
/// A **valid** existing DEK is never replaced (it's what an encrypted key file is
/// sealed under). An *absent* or *malformed* (wrong-length) DEK — which can't
/// decrypt anything anyway — is replaced via a temp-file + rename, so a partial
/// write or corruption can't permanently wedge the keystore.
pub fn load_or_create_dek(path: &Path) -> Result<[u8; DEK_LEN], String> {
    if let Some(dek) = load_dek(path) {
        return Ok(dek);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create config dir: {e}"))?;
    }
    let mut dek = [0u8; DEK_LEN];
    fill_random(&mut dek)?;
    write_dek_atomic(path, &dek)?;
    Ok(dek)
}

/// Install a DEK atomically: write a fresh owner-only temp file, then rename it
/// over `path`. No empty/partial-DEK window, and an existing corrupt file is
/// replaced by the rename rather than blocking creation.
fn write_dek_atomic(path: &Path, dek: &[u8; DEK_LEN]) -> Result<(), String> {
    let tmp = path.with_extension("key.tmp");
    let _ = std::fs::remove_file(&tmp);
    create_new_owner_only(&tmp, dek)?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("install DEK: {e}")
    })
}

#[cfg(unix)]
fn create_new_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn create_new_owner_only(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    // On Windows the file inherits the (user-only) profile-dir ACL.
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dek() -> [u8; DEK_LEN] {
        let mut d = [0u8; DEK_LEN];
        for (i, b) in d.iter_mut().enumerate() {
            *b = i as u8;
        }
        d
    }

    #[test]
    fn round_trips() {
        let d = dek();
        let env = encrypt_str(&d, "sk-test-1234567890").unwrap();
        assert!(is_enveloped(&env));
        assert_eq!(decrypt_str(&d, &env).as_deref(), Some("sk-test-1234567890"));
    }

    #[test]
    fn fresh_nonce_each_time() {
        let d = dek();
        // Same plaintext encrypts to different envelopes (random nonce).
        assert_ne!(encrypt_str(&d, "same").unwrap(), encrypt_str(&d, "same").unwrap());
    }

    #[test]
    fn wrong_key_is_rejected() {
        let env = encrypt_str(&dek(), "secret").unwrap();
        let mut other = dek();
        other[0] ^= 0xFF;
        assert_eq!(decrypt_str(&other, &env), None);
    }

    #[test]
    fn tamper_is_rejected() {
        let d = dek();
        let mut env = encrypt_str(&d, "secret").unwrap();
        // Flip a base64 char in the body — the Poly1305 tag must reject it.
        let last = env.pop().unwrap();
        env.push(if last == 'A' { 'B' } else { 'A' });
        assert_eq!(decrypt_str(&d, &env), None);
    }

    #[test]
    fn non_envelope_decrypts_to_none() {
        assert_eq!(decrypt_str(&dek(), "plain text"), None);
        assert!(!is_enveloped("plain text"));
    }

    #[test]
    fn create_then_load_dek_round_trip() {
        let dir = std::env::temp_dir().join(format!("sc-crypto-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vault.key");
        let _ = std::fs::remove_file(&path);
        let a = load_or_create_dek(&path).unwrap();
        let b = load_or_create_dek(&path).unwrap(); // second call adopts the same DEK
        assert_eq!(a, b);
        assert_eq!(load_dek(&path), Some(a));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_dek_is_recovered_not_wedged() {
        let dir = std::env::temp_dir().join(format!("sc-crypto-mal-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("vault.key");
        // Plant a wrong-length (truncated/partial-write) DEK.
        std::fs::write(&path, b"too short").unwrap();
        assert_eq!(load_dek(&path), None);
        // Must recover with a fresh, usable 32-byte DEK rather than erroring.
        let dek = load_or_create_dek(&path).unwrap();
        assert_eq!(load_dek(&path), Some(dek));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
