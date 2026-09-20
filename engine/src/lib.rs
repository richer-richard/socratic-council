//! `socratic-council-engine` — the shared deliberation engine.
//!
//! A council of AI models, any model per seat across eight providers,
//! deliberates a question in structured rounds under a moderator that plans,
//! keeps a board, judges convergence and writes a decision record. Seats
//! call tools natively (web search, claim verification, attachments, a
//! session workspace, a sandboxed shell). Both the terminal client and the
//! desktop app drive this crate through `deliberation::Deliberation` and
//! render its `DebateEvent` stream.

#![forbid(unsafe_code)]

pub mod attach;
pub mod catalog;
pub mod cost;
pub mod crypto;
pub mod deliberation;
pub mod error;
pub mod handoff;
pub mod providers;
pub mod search;
pub mod store;
pub mod text;
pub mod tools;
pub mod types;

/// Build the HTTP client every provider and search call goes through.
/// Redirects are never followed (one could carry the key headers to another
/// host); a connect + overall timeout means a stalled provider eventually
/// errors instead of hanging the session; and a proxy URL that cannot be
/// parsed is an error, never a silent direct connection.
pub fn http_client(proxy: Option<&str>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent("socratic-council")
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300));
    if let Some(p) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        // The URL may carry credentials: never echo it.
        let px = reqwest::Proxy::all(p).map_err(|_| {
            "the proxy URL could not be parsed (expected http(s)://host:port or socks5://host:port)"
                .to_string()
        })?;
        builder = builder.proxy(px);
    }
    builder
        .build()
        .map_err(|_| "the HTTP client could not be built".to_string())
}
