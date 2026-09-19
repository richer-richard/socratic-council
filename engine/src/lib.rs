//! `socratic-council-engine` — the shared deliberation engine.
//!
//! A council of AI models, any model per seat across eight providers,
//! deliberates a question in structured rounds under a moderator that plans,
//! keeps a board, judges convergence and writes a decision record. Seats
//! call tools natively (web search, claim verification, attachments, a
//! session workspace, a sandboxed shell). Both the terminal client and the
//! desktop app drive this crate through `deliberation::Deliberation` and
//! render its `DebateEvent` stream.

pub mod attach;
pub mod catalog;
pub mod cost;
pub mod crypto;
pub mod deliberation;
pub mod error;
pub mod providers;
pub mod search;
pub mod store;
pub mod text;
pub mod tools;
pub mod types;

/// Build an HTTP client, optionally routed through a proxy URL. A connect +
/// overall request timeout means a stalled provider eventually errors (the
/// turn fails gracefully) instead of hanging the whole session forever.
pub fn http_client(proxy: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent("socratic-council")
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300));
    if let Some(p) = proxy {
        if let Ok(px) = reqwest::Proxy::all(p) {
            builder = builder.proxy(px);
        }
    }
    builder.build().unwrap_or_default()
}
