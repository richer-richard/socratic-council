//! `socratic-council` — a terminal multi-agent debate workstation.
//!
//! Eight AI agents, one per provider (OpenAI, Anthropic, Google, DeepSeek,
//! Kimi/Moonshot, Qwen, MiniMax, Z.AI), debate any topic in a ratatui TUI.
//! Models are chosen by the same Auto resolver + live `/models` scanning as the
//! desktop app — no hardcoded ids to hand-bump.

pub mod bridge;
pub mod catalog;
pub mod config;
pub mod crypto;
pub mod engine;
pub mod error;
pub mod providers;
pub mod tui;
pub mod types;

/// Build an HTTP client, optionally routed through a proxy URL. A connect +
/// overall request timeout means a stalled provider eventually errors (the turn
/// fails gracefully) instead of hanging the whole debate forever.
pub fn http_client(proxy: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .user_agent("socratic-council-cli")
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300));
    if let Some(p) = proxy {
        if let Ok(px) = reqwest::Proxy::all(p) {
            builder = builder.proxy(px);
        }
    }
    builder.build().unwrap_or_default()
}
