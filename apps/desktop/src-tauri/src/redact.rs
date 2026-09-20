//! Scrub secrets from strings before they get returned to the frontend,
//! written to logs, or surfaced in error messages.
//!
//! Scope (intentionally conservative — better a visible `[REDACTED]` than a
//! leaked key):
//!
//!   * `userinfo@` in URLs (proxy credentials embedded in proxy URLs)
//!   * Common API-key prefixes in free text (sk-..., AIza...) — fix 7.5
//!
//! Called from the HTTP command error paths so the proxy URL built by
//! `build_proxy_url` — which contains the operator's proxy user/password —
//! never reaches JS/devtools/log files verbatim. Defense-in-depth: the
//! TS-side redactor at `apps/desktop/src/utils/redact.ts` performs the
//! same scrubbing on values that reach the apiLogger; this layer catches
//! anything that bypasses the JS redactor.

const REDACTED: &str = "[REDACTED]";

/// Scrub `text` of (1) every exact `secrets` value (the request's own credential
/// header values — the one set of secrets the broker *knows* verbatim, whatever
/// their shape) and (2) the pattern-based redactions below. Provider error
/// bodies sometimes echo the key back ("invalid api key: …"); pattern matching
/// alone missed MiniMax's JWT-shaped and Zhipu's `id.secret`-shaped keys.
pub fn redact_with_secrets(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.len() >= 8 {
            out = out.replace(s.as_str(), REDACTED);
        }
    }
    redact_urls_in(&out)
}

/// Remove `user:pass@` userinfo from any `scheme://user:pass@host:port/path`
/// substrings inside the input. Preserves surrounding text. Idempotent and
/// safe to call on arbitrary error messages; leaves strings without URLs
/// unchanged.
pub fn redact_urls_in(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        // Look for "://" — URL scheme marker.
        if let Some(scheme_end) = text[cursor..].find("://") {
            let scheme_abs = cursor + scheme_end;
            // Scan backward from scheme_end to find the scheme start (letters only).
            let mut scheme_start = scheme_abs;
            while scheme_start > cursor {
                let prev = bytes[scheme_start - 1];
                if prev.is_ascii_alphabetic() || prev == b'+' || prev == b'-' || prev == b'.' {
                    scheme_start -= 1;
                } else {
                    break;
                }
            }

            // Everything up to and including the scheme gets copied unchanged.
            out.push_str(&text[cursor..scheme_abs + 3]);
            cursor = scheme_abs + 3;

            // From here we're in the authority segment. Look for '@' before
            // the next '/', '?', '#', whitespace, or end of string.
            let segment_end = text[cursor..]
                .find(|c: char| c == '/' || c == '?' || c == '#' || c.is_whitespace())
                .map(|i| cursor + i)
                .unwrap_or_else(|| bytes.len());

            let authority = &text[cursor..segment_end];
            if let Some(at_idx) = authority.find('@') {
                // Redact userinfo portion.
                out.push_str(REDACTED);
                out.push('@');
                out.push_str(&authority[at_idx + 1..]);
            } else {
                out.push_str(authority);
            }
            cursor = segment_end;
        } else {
            out.push_str(&text[cursor..]);
            break;
        }
    }

    redact_api_keys_in(&out)
}

/// Replace common API-key prefixes (sk-..., sk-ant-..., sk-proj-..., AIza...)
/// with `[REDACTED]` so a provider error response that echoes back a key
/// (e.g. "Invalid API key: sk-...") doesn't leak the key into our error
/// surface (fix 7.5).
///
/// Conservative: requires a sufficient run of allowed key chars after the
/// prefix to avoid mangling ordinary words. The TS-side redactor mirrors
/// these rules; this is defense-in-depth.
fn redact_api_keys_in(text: &str) -> String {
    // Hand-rolled scanner so we don't pull in a regex crate just for this.
    // Scans for one of the known prefixes followed by ≥10 (or ≥16 for AIza)
    // chars from [A-Za-z0-9_-].
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = match_key_at(bytes, i) {
            out.push_str(REDACTED);
            i = end;
        } else {
            // Push one UTF-8 code unit at a time. Safe because we're working on
            // valid UTF-8 input; non-ASCII bytes are passed through.
            let ch_len = utf8_char_len(bytes[i]);
            out.push_str(&text[i..i + ch_len]);
            i += ch_len;
        }
    }
    out
}

fn utf8_char_len(b: u8) -> usize {
    // < 0x80 is ASCII (1 byte); 0x80..0xC0 are continuation bytes that shouldn't
    // appear at the head — treat them permissively as 1 byte too.
    if b < 0xC0 {
        1
    } else if b < 0xE0 {
        2
    } else if b < 0xF0 {
        3
    } else {
        4
    }
}

/// If `bytes` from offset `i` starts with a key-like token, return the
/// index AFTER the token. Otherwise None.
fn match_key_at(bytes: &[u8], i: usize) -> Option<usize> {
    // Word boundary at start: previous byte must not be alphanumeric.
    if i > 0 {
        let prev = bytes[i - 1];
        if prev.is_ascii_alphanumeric() || prev == b'-' || prev == b'_' {
            return None;
        }
    }

    // JWT-shaped tokens (MiniMax keys are JWTs): three base64url segments, the
    // first starting with `eyJ` (`{"` encoded).
    if let Some(end) = match_jwt_at(bytes, i) {
        return Some(end);
    }
    // Zhipu / Z.AI keys: 32 hex chars, a dot, then a 16+ char alphanumeric secret.
    if let Some(end) = match_zhipu_key_at(bytes, i) {
        return Some(end);
    }

    // Try sk-ant-, sk-proj-, sk-, AIza in priority order.
    let prefixes: &[(&[u8], usize)] = &[
        (b"sk-ant-", 10),
        (b"sk-proj-", 10),
        (b"sk-", 10),
        (b"AIza", 16),
    ];
    for (prefix, min_run) in prefixes {
        if !bytes[i..].starts_with(prefix) {
            continue;
        }
        let mut j = i + prefix.len();
        let mut run = 0usize;
        while j < bytes.len() {
            let c = bytes[j];
            if c.is_ascii_alphanumeric() || c == b'-' || c == b'_' {
                j += 1;
                run += 1;
            } else {
                break;
            }
        }
        if run >= *min_run {
            return Some(j);
        }
    }

    None
}

fn run_len(bytes: &[u8], from: usize, pred: fn(u8) -> bool) -> usize {
    let mut j = from;
    while j < bytes.len() && pred(bytes[j]) {
        j += 1;
    }
    j - from
}

fn is_b64url(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'-' || c == b'_'
}

/// `eyJ…`.`…`.`…` with every segment ≥ 10 base64url chars.
fn match_jwt_at(bytes: &[u8], i: usize) -> Option<usize> {
    if !bytes[i..].starts_with(b"eyJ") {
        return None;
    }
    let mut j = i;
    for seg in 0..3 {
        let n = run_len(bytes, j, is_b64url);
        if n < 10 {
            return None;
        }
        j += n;
        if seg < 2 {
            if j >= bytes.len() || bytes[j] != b'.' {
                return None;
            }
            j += 1;
        }
    }
    Some(j)
}

/// `[0-9a-f]{32}.[A-Za-z0-9]{16,}` (Zhipu / Z.AI API keys).
fn match_zhipu_key_at(bytes: &[u8], i: usize) -> Option<usize> {
    let hex = run_len(bytes, i, |c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase());
    if hex != 32 {
        return None;
    }
    let dot = i + 32;
    if dot >= bytes.len() || bytes[dot] != b'.' {
        return None;
    }
    let tail = run_len(bytes, dot + 1, |c| c.is_ascii_alphanumeric());
    if tail < 16 {
        return None;
    }
    Some(dot + 1 + tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_exact_secret_values_of_any_shape() {
        let key = "weird::shape::key::9f8e7d6c5b4a";
        let input = format!("provider said: invalid credentials for {key} (retry)");
        let out = redact_with_secrets(&input, &[key.to_string()]);
        assert!(!out.contains(key));
        assert!(out.contains("[REDACTED] (retry)"));
        // Short values are never treated as secrets (would mangle ordinary text).
        assert_eq!(redact_with_secrets("ok", &["ok".to_string()]), "ok");
    }

    #[test]
    fn redacts_jwt_and_zhipu_shaped_keys() {
        let jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJtaW5pbWF4LXVzZXIifQ.abcdefghijklmnopqrstuvwxyz0123";
        let out = redact_urls_in(&format!("401 for token {jwt} at minimax"));
        assert!(!out.contains("eyJzdWIi"), "{out}");
        assert!(out.contains("[REDACTED] at minimax"));
        let zhipu = "0123456789abcdef0123456789abcdef.AbCdEfGhIjKlMnOpQrSt";
        let out = redact_urls_in(&format!("bigmodel rejected {zhipu}."));
        assert!(!out.contains("AbCdEfGh"), "{out}");
        // A plain 32-char hex hash without the `.secret` tail is left alone.
        let hash = "0123456789abcdef0123456789abcdef";
        assert_eq!(redact_urls_in(hash), hash);
    }

    #[test]
    fn strips_userinfo_from_http_url() {
        let input = "Failed to connect: http://bob:secret@proxy.local:3128/next";
        let out = redact_urls_in(input);
        assert!(!out.contains("bob"));
        assert!(!out.contains("secret"));
        assert!(out.contains("proxy.local:3128/next"));
        assert!(out.contains("[REDACTED]@proxy.local"));
    }

    #[test]
    fn leaves_urls_without_userinfo_alone() {
        let input = "ok: https://api.openai.com/v1/chat";
        assert_eq!(redact_urls_in(input), input);
    }

    #[test]
    fn handles_multiple_urls() {
        let input = "socks5://u:p@a:1 then http://x:y@b:2";
        let out = redact_urls_in(input);
        assert!(!out.contains("u:p@"));
        assert!(!out.contains("x:y@"));
        assert!(out.contains("[REDACTED]@a:1"));
        assert!(out.contains("[REDACTED]@b:2"));
    }

    #[test]
    fn no_urls_unchanged() {
        let input = "plain error message, nothing sensitive";
        assert_eq!(redact_urls_in(input), input);
    }

    #[test]
    fn redacts_bare_openai_key_prefix() {
        let input = "Invalid API key: sk-1234567890abcdefXYZ";
        let out = redact_urls_in(input);
        assert!(out.contains("[REDACTED]"));
        assert!(!out.contains("sk-1234567890abcdefXYZ"));
    }

    #[test]
    fn redacts_anthropic_key_prefix() {
        let input = "auth failed: sk-ant-very-long-secret-token-here-1234";
        let out = redact_urls_in(input);
        assert!(!out.contains("very-long-secret-token-here-1234"));
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn redacts_google_api_key_prefix() {
        let input = "denied for AIzaSyA1B2C3D4E5F6G7H8I9J0KLMN";
        let out = redact_urls_in(input);
        assert!(!out.contains("AIzaSyA1B2C3D4E5F6G7H8I9J0KLMN"));
    }

    #[test]
    fn leaves_ordinary_short_tokens_alone() {
        // Threshold is ≥10 chars after sk-; "sk-yes" is too short to look like a key.
        let input = "no airport code sk-yes here";
        assert_eq!(redact_urls_in(input), input);
    }
}
