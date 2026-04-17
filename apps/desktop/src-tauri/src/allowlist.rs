//! Defensive validation of outbound HTTP requests issued through the IPC
//! surface. Every call to `http_request` / `http_request_stream` is checked
//! against:
//!
//!   1. **Host allowlist** — known provider domains plus registered local
//!      endpoints. Requests to any other host are rejected without making a
//!      network call.
//!   2. **Scheme rule** — external hosts must be `https://`; `http://` is
//!      only allowed for loopback (`127.0.0.1`, `localhost`, `::1`).
//!   3. **Body size cap** — 4MB upper bound on the outbound request body.
//!   4. **Process-wide rate limit** — a simple token-bucket, 200 requests per
//!      60-second window, to blunt any kind of runaway loop.
//!
//! None of these change the shape of the request; they only decide whether
//! to issue it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use url::Url;

/// Maximum size of an outbound request body, in bytes.
pub const MAX_REQUEST_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Provider and oracle hosts that we always permit.
///
/// Match is exact on the host component (after Url parsing), case-insensitive.
/// Do not use globs; every entry here represents a deliberate trust decision.
const PROVIDER_HOSTS: &[&str] = &[
    // Inner-circle providers
    "api.openai.com",
    "api.anthropic.com",
    "generativelanguage.googleapis.com",
    "api.deepseek.com",
    "api.moonshot.cn",
    "dashscope.aliyuncs.com",
    "api.minimaxi.com",
    "api.minimax.chat",
    "open.bigmodel.cn",
    // Oracle / web search
    "api.duckduckgo.com",
    "duckduckgo.com",
    "html.duckduckgo.com",
];

/// Loopback hosts — `http://` is permitted to these, everyone else is `https://` only.
const LOOPBACK_HOSTS: &[&str] = &["127.0.0.1", "localhost", "::1", "[::1]"];

fn host_matches(list: &[&str], host: &str) -> bool {
    let host_lc = host.to_ascii_lowercase();
    list.iter().any(|entry| *entry == host_lc)
}

fn is_loopback_host(host: &str) -> bool {
    host_matches(LOOPBACK_HOSTS, host)
}

fn is_allowlisted_provider(host: &str) -> bool {
    host_matches(PROVIDER_HOSTS, host)
}

/// Validate an outbound URL against scheme + host rules. Returns a concise
/// error message suitable for bubbling back to the frontend.
pub fn validate_outbound_url(url_str: &str) -> Result<Url, String> {
    let parsed =
        Url::parse(url_str).map_err(|_| "Outbound URL is malformed".to_string())?;

    let host = match parsed.host_str() {
        Some(h) if !h.is_empty() => h.to_string(),
        _ => return Err("Outbound URL is missing a host".to_string()),
    };

    let scheme = parsed.scheme();
    let loopback = is_loopback_host(&host);

    if loopback {
        if scheme != "http" && scheme != "https" {
            return Err(format!("Unsupported scheme '{}' for loopback", scheme));
        }
    } else {
        if scheme != "https" {
            return Err(format!("Scheme '{}' not allowed (https:// required)", scheme));
        }
        if !is_allowlisted_provider(&host) {
            return Err(format!("Host '{}' is not on the IPC allowlist", host));
        }
    }

    Ok(parsed)
}

/// Validate a prospective body size. The body itself is accepted as an
/// optional reference so callers don't need to allocate just to check.
pub fn validate_body_size(body: Option<&str>) -> Result<(), String> {
    if let Some(value) = body {
        if value.len() > MAX_REQUEST_BODY_BYTES {
            return Err(format!(
                "Request body exceeds {}-byte limit",
                MAX_REQUEST_BODY_BYTES
            ));
        }
    }
    Ok(())
}

// --- Process-wide rate limiter -----------------------------------------------

const RATE_LIMIT_PER_MINUTE: usize = 200;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

struct RateBucket {
    events: Vec<Instant>,
}

static RATE_BUCKET: Lazy<Mutex<RateBucket>> = Lazy::new(|| {
    Mutex::new(RateBucket {
        events: Vec::with_capacity(RATE_LIMIT_PER_MINUTE),
    })
});

/// Accept one request toward the window. Returns `Err` with a friendly
/// message when the limit is exceeded. Uses a simple sliding window over
/// timestamped events rather than a dedicated crate.
pub fn check_rate_limit() -> Result<(), String> {
    let mut bucket = RATE_BUCKET
        .lock()
        .map_err(|_| "Rate limiter state unavailable".to_string())?;
    let now = Instant::now();
    let cutoff = now - RATE_LIMIT_WINDOW;
    bucket.events.retain(|t| *t >= cutoff);
    if bucket.events.len() >= RATE_LIMIT_PER_MINUTE {
        return Err(format!(
            "IPC rate limit exceeded ({} requests per 60s)",
            RATE_LIMIT_PER_MINUTE
        ));
    }
    bucket.events.push(now);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlisted_https_provider_is_accepted() {
        assert!(validate_outbound_url("https://api.openai.com/v1/chat").is_ok());
        assert!(validate_outbound_url("https://api.anthropic.com/v1/messages").is_ok());
    }

    #[test]
    fn unknown_host_is_rejected() {
        let err = validate_outbound_url("https://evil.test/exfil").unwrap_err();
        assert!(err.contains("not on the IPC allowlist"));
    }

    #[test]
    fn http_scheme_rejected_for_external() {
        let err = validate_outbound_url("http://api.openai.com/v1/chat").unwrap_err();
        assert!(err.contains("https:// required"));
    }

    #[test]
    fn loopback_http_is_accepted() {
        assert!(validate_outbound_url("http://127.0.0.1:11434/api/chat").is_ok());
        assert!(validate_outbound_url("http://localhost:11434/api/chat").is_ok());
    }

    #[test]
    fn oversized_body_rejected() {
        let long = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
        assert!(validate_body_size(Some(&long)).is_err());
        assert!(validate_body_size(Some("small")).is_ok());
        assert!(validate_body_size(None).is_ok());
    }
}
