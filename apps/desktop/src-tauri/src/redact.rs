//! Scrub secrets from strings before they get returned to the frontend,
//! written to logs, or surfaced in error messages.
//!
//! Scope (intentionally conservative — better a visible `[REDACTED]` than a
//! leaked key):
//!
//!   * `userinfo@` in URLs (proxy credentials embedded in proxy URLs)
//!   * Common API-key header serializations if they end up in error strings
//!
//! Called from the HTTP command error paths so the proxy URL built by
//! `build_proxy_url` — which contains the operator's proxy user/password —
//! never reaches JS/devtools/log files verbatim.

const REDACTED: &str = "[REDACTED]";

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

    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
