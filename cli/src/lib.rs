//! `socratic-council` — the terminal client of the Socratic Council engine.
//!
//! The engine (`socratic_council_engine`) is re-exported module by module so
//! the client's own modules and its integration surface keep the historical
//! paths (`socratic_council::deliberation`, `::catalog`, ...).

pub use socratic_council_engine::{
    attach, catalog, cost, crypto, deliberation, error, handoff, http_client, providers, search,
    store, text, tools, types,
};

pub mod bridge;
pub mod config;
pub mod engine;
pub mod tui;
