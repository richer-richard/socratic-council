//! The cost ledger — per-speaker token + USD accounting with budget caps.
//!
//! A faithful port of the app's `packages/core/src/cost.ts` +
//! `utils/budgetEnforcer.ts`: per-1M pricing, reasoning tokens billed at the
//! output rate when a model publishes no reasoning rate (the app's fix 5.15),
//! an 80%-of-cap warning, and a rolling daily total persisted across runs.
//!
//! Hard rule (mirrors the catalog): **no fabricated prices**. The table below
//! carries only real rows from the app's `MODEL_REGISTRY`; an unknown model is
//! simply unpriced — its tokens still count, its USD shows as a lower bound.

use crate::types::{CostLane, CostRow, CostSnapshot, Usage};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Per-1M-token pricing for one model.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
    pub reasoning: Option<f64>,
}

const fn p(input: f64, output: f64) -> Pricing {
    Pricing { input, output, reasoning: None }
}
const fn pr(input: f64, output: f64, reasoning: f64) -> Pricing {
    Pricing { input, output, reasoning: Some(reasoning) }
}

/// Real `$ / 1M tokens` rows ported from the desktop `MODEL_REGISTRY`.
/// Keys are lowercase; see `price_for` for the lookup rules.
const PRICES: &[(&str, Pricing)] = &[
    // OpenAI
    ("gpt-5.5", p(5.0, 30.0)),
    ("gpt-5.4", p(2.5, 15.0)),
    ("gpt-5.3-chat-latest", p(0.4, 2.0)),
    ("gpt-5.3-codex", pr(2.5, 10.0, 15.0)),
    ("gpt-5.2-pro", pr(2.5, 10.0, 15.0)),
    ("gpt-5.2", p(5.0, 15.0)),
    ("gpt-5-mini", p(0.4, 1.6)),
    ("gpt-5-nano", p(0.1, 0.4)),
    ("o4-mini", pr(1.1, 4.4, 4.4)),
    ("o3", pr(10.0, 40.0, 40.0)),
    ("o1", pr(15.0, 60.0, 60.0)),
    ("gpt-4o", p(2.5, 10.0)),
    ("gpt-4o-mini", p(0.15, 0.6)),
    ("gpt-4-turbo", p(10.0, 30.0)),
    // Anthropic
    ("claude-opus-4-8", p(5.0, 25.0)),
    ("claude-opus-4-7", p(5.0, 25.0)),
    ("claude-opus-4-6", p(5.0, 25.0)),
    ("claude-opus-4-5-20251101", p(5.0, 25.0)),
    ("claude-sonnet-4-5-20250929", p(3.0, 15.0)),
    ("claude-haiku-4-5-20251001", p(1.0, 5.0)),
    ("claude-sonnet-4-20250514", p(3.0, 15.0)),
    ("claude-opus-4-1-20250410", p(5.0, 25.0)),
    ("claude-3-5-sonnet-20241022", p(3.0, 15.0)),
    ("claude-3-5-haiku-20241022", p(0.8, 4.0)),
    ("claude-3-opus-20240229", p(15.0, 75.0)),
    // Google
    ("gemini-3.1-pro-preview", p(2.0, 12.0)),
    ("gemini-3-pro-preview", p(1.25, 5.0)),
    ("gemini-3-flash-preview", p(0.1, 0.4)),
    ("gemini-2.5-pro", p(1.25, 5.0)),
    ("gemini-2.5-flash-lite", p(0.02, 0.08)),
    ("gemini-2.5-flash", p(0.075, 0.3)),
    ("gemini-2.0-flash-lite", p(0.02, 0.08)),
    ("gemini-2.0-flash", p(0.1, 0.4)),
    // DeepSeek
    ("deepseek-v4-pro", pr(1.74, 3.48, 3.48)),
    ("deepseek-v4-flash", p(0.27, 1.1)),
    ("deepseek-reasoner", p(0.55, 2.19)),
    ("deepseek-chat", p(0.27, 1.1)),
    // Kimi / Moonshot
    ("kimi-k2.6", p(0.95, 4.0)),
    ("kimi-k2.5", p(0.9, 3.6)),
    ("kimi-k2-thinking-turbo", p(0.6, 2.4)),
    ("kimi-k2-thinking", p(0.6, 2.4)),
    ("kimi-k2-turbo-preview", p(0.6, 2.4)),
    ("kimi-k2-0905-preview", p(0.6, 2.4)),
    ("kimi-k2-0711-preview", p(0.55, 2.2)),
    ("moonshot-v1-128k", p(0.8, 0.8)),
    ("moonshot-v1-32k", p(0.35, 0.35)),
    ("moonshot-v1-8k", p(0.17, 0.17)),
    // MiniMax
    ("minimax-m2.7-highspeed", p(0.6, 2.4)),
    // Qwen / Alibaba DashScope (must stay in sync with MODEL_REGISTRY — Quinn is
    // seated as Provider::Qwen, so a missing row bills her at $0 and slips the cap)
    ("qwen3.7-max", p(1.3, 7.8)),
    ("qwen3.6-max-preview", p(1.3, 7.8)),
    ("qwen3.6-plus", p(0.56, 1.68)),
    ("qwen3.5-plus", p(0.56, 1.68)),
    // Zhipu / Z.AI
    ("glm-5.1", p(1.4, 4.4)),
    ("glm-5", p(0.5, 2.0)),
    ("glm-4.7", p(0.25, 1.0)),
];

/// Price for a model id: case-insensitive exact match first, then the longest
/// table key that is a prefix of the id (so a dated snapshot like
/// `claude-opus-4-8-20260301` bills at the `claude-opus-4-8` rate). Unknown
/// ids return `None` — never a guessed price.
pub fn price_for(model_id: &str) -> Option<Pricing> {
    let id = model_id.trim().to_ascii_lowercase();
    if id.is_empty() {
        return None;
    }
    if let Some((_, pricing)) = PRICES.iter().find(|(k, _)| *k == id) {
        return Some(*pricing);
    }
    PRICES
        .iter()
        .filter(|(k, _)| id.starts_with(*k))
        .max_by_key(|(k, _)| k.len())
        .map(|(_, pricing)| *pricing)
}

/// Estimated USD for `usage` at `pricing`. Reasoning tokens with no published
/// reasoning rate bill at the output rate (the app's conservative fix 5.15).
pub fn estimate_usd(usage: Usage, pricing: Pricing) -> f64 {
    let reasoning_rate = pricing.reasoning.unwrap_or(pricing.output);
    (usage.input as f64 / 1_000_000.0) * pricing.input
        + (usage.output as f64 / 1_000_000.0) * pricing.output
        + (usage.reasoning as f64 / 1_000_000.0) * reasoning_rate
}

#[derive(Debug, Clone, Default)]
struct RowAccum {
    name: String,
    lane: CostLane,
    input: u64,
    output: u64,
    reasoning: u64,
    usd: f64,
    priced: bool,
    any_usage: bool,
}

/// The session ledger: per-speaker accumulation across the four lanes.
#[derive(Debug, Default)]
pub struct CostLedger {
    rows: BTreeMap<String, RowAccum>,
    unpriced_seen: bool,
}

impl CostLedger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one completion's usage for `agent_id` (a council agent, advisor,
    /// "moderator", or "utility"). Returns the USD delta this record added.
    pub fn record(
        &mut self,
        agent_id: &str,
        name: &str,
        lane: CostLane,
        model: &str,
        usage: Usage,
    ) -> f64 {
        let pricing = price_for(model);
        let usd = pricing.map(|pr| estimate_usd(usage, pr)).unwrap_or(0.0);
        if pricing.is_none() && (usage.input + usage.output + usage.reasoning) > 0 {
            self.unpriced_seen = true;
        }
        let row = self.rows.entry(agent_id.to_string()).or_default();
        if row.name.is_empty() {
            row.name = name.to_string();
            row.lane = lane;
        }
        row.input += usage.input;
        row.output += usage.output;
        row.reasoning += usage.reasoning;
        row.usd += usd;
        row.priced = row.priced || pricing.is_some();
        row.any_usage = true;
        usd
    }

    pub fn total_usd(&self) -> f64 {
        self.rows.values().map(|r| r.usd).sum()
    }

    /// A render-ready snapshot. Budget/daily fields are filled by the caller.
    pub fn snapshot(&self) -> CostSnapshot {
        let mut rows: Vec<CostRow> = self
            .rows
            .iter()
            .filter(|(_, r)| r.any_usage)
            .map(|(id, r)| CostRow {
                agent_id: id.clone(),
                name: r.name.clone(),
                lane: r.lane,
                input: r.input,
                output: r.output,
                reasoning: r.reasoning,
                usd: r.usd,
                priced: r.priced,
            })
            .collect();
        rows.sort_by(|a, b| b.usd.partial_cmp(&a.usd).unwrap_or(std::cmp::Ordering::Equal));

        let mut lanes: BTreeMap<CostLane, f64> = BTreeMap::new();
        for r in &rows {
            *lanes.entry(r.lane).or_default() += r.usd;
        }

        CostSnapshot {
            total_usd: self.total_usd(),
            total_input: rows.iter().map(|r| r.input).sum(),
            total_output: rows.iter().map(|r| r.output).sum(),
            total_reasoning: rows.iter().map(|r| r.reasoning).sum(),
            all_priced: !self.unpriced_seen,
            lane_usd: lanes.into_iter().collect(),
            rows,
            daily_usd: 0.0,
            session_cap: 0.0,
            daily_cap: 0.0,
            note: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Budget circuit breaker (port of utils/budgetEnforcer.ts; no "pause" — the
// CLI's actions are warn | stop).
// ---------------------------------------------------------------------------

/// Fire a warning once 80% of a cap is consumed (same as the app).
const WARN_AT: f64 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetAction {
    Warn,
    Stop,
}

impl BudgetAction {
    pub fn parse(s: &str) -> BudgetAction {
        match s.to_ascii_lowercase().as_str() {
            "stop" => BudgetAction::Stop,
            _ => BudgetAction::Warn,
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            BudgetAction::Warn => "warn",
            BudgetAction::Stop => "stop",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct BudgetPolicy {
    /// USD cap per session; 0 disables the dimension.
    pub per_session: f64,
    /// USD cap per UTC day (across sessions); 0 disables.
    pub per_day: f64,
    pub action: BudgetAction,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BudgetVerdict {
    Ok,
    Warn(String),
    Stop(String),
}

fn classify(consumed: f64, cap: f64, scope: &str, action: BudgetAction) -> BudgetVerdict {
    if cap <= 0.0 {
        return BudgetVerdict::Ok;
    }
    if consumed >= cap {
        let msg =
            format!("Budget reached ({scope} cap ${cap:.2}, spent ${consumed:.2}).");
        return match action {
            BudgetAction::Stop => BudgetVerdict::Stop(format!("{msg} Stopping the session.")),
            BudgetAction::Warn => BudgetVerdict::Warn(msg),
        };
    }
    if consumed >= cap * WARN_AT {
        let pct = ((consumed / cap) * 100.0).round() as u32;
        return BudgetVerdict::Warn(format!(
            "{pct}% of {scope} budget used (${consumed:.2} / ${cap:.2})."
        ));
    }
    BudgetVerdict::Ok
}

/// Evaluate session + daily totals against the policy. The highest-severity
/// verdict wins (stop > warn > ok).
pub fn evaluate_budget(session_usd: f64, daily_usd: f64, policy: BudgetPolicy) -> BudgetVerdict {
    let session = classify(session_usd, policy.per_session, "session", policy.action);
    let daily = classify(daily_usd, policy.per_day, "daily", policy.action);
    match (&session, &daily) {
        (BudgetVerdict::Stop(_), _) => session,
        (_, BudgetVerdict::Stop(_)) => daily,
        (BudgetVerdict::Warn(_), _) => session,
        (_, BudgetVerdict::Warn(_)) => daily,
        _ => BudgetVerdict::Ok,
    }
}

// ---------------------------------------------------------------------------
// Rolling daily ledger (UTC day; persisted as JSON in the config dir).
// ---------------------------------------------------------------------------

/// `YYYY-MM-DD` (UTC) for a unix timestamp — civil-from-days, no date crate.
/// (Howard Hinnant's `civil_from_days`; exact for all timestamps ≥ epoch.)
pub fn daily_key(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The rolling daily spend record (cross-session). Best-effort: a missing or
/// corrupt file just starts the day at zero.
#[derive(Debug, Clone)]
pub struct DailyLedger {
    path: PathBuf,
    day: String,
    pub total_usd: f64,
}

impl DailyLedger {
    pub fn load(config_dir: &Path) -> DailyLedger {
        let path = config_dir.join("daily-spend.json");
        let today = daily_key(now_unix());
        let mut ledger = DailyLedger { path, day: today.clone(), total_usd: 0.0 };
        if let Ok(text) = std::fs::read_to_string(&ledger.path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                let day = v.get("day").and_then(|d| d.as_str()).unwrap_or_default();
                let total = v.get("total_usd").and_then(|t| t.as_f64()).unwrap_or(0.0);
                if day == today && total.is_finite() && total >= 0.0 {
                    ledger.total_usd = total;
                }
            }
        }
        ledger
    }

    /// Add a positive cost delta and persist. Rolls over automatically if the
    /// UTC day changed while the session ran.
    pub fn add(&mut self, delta_usd: f64) {
        if !(delta_usd.is_finite() && delta_usd > 0.0) {
            return;
        }
        let today = daily_key(now_unix());
        if today != self.day {
            self.day = today;
            self.total_usd = 0.0;
        }
        self.total_usd += delta_usd;
        let body = serde_json::json!({ "day": self.day, "total_usd": self.total_usd });
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(&self.path, body.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_lookup_is_case_insensitive_with_prefix_fallback() {
        // Exact (case-insensitive) hit — the MiniMax id ships in mixed case.
        assert_eq!(price_for("MiniMax-M2.7-highspeed"), Some(p(0.6, 2.4)));
        // Dated snapshot falls back to its base id's price.
        assert_eq!(price_for("claude-opus-4-8-20260301"), Some(p(5.0, 25.0)));
        // Longest prefix wins: gpt-5.2-pro must not bill as gpt-5.2.
        assert_eq!(price_for("gpt-5.2-pro"), Some(pr(2.5, 10.0, 15.0)));
        // Unknown models are unpriced — never guessed.
        assert_eq!(price_for("totally-new-model"), None);
        assert_eq!(price_for(""), None);
    }

    #[test]
    fn qwen_council_models_are_priced() {
        // Regression: Quinn is seated as Provider::Qwen; missing rows billed her
        // at $0 and slipped the budget cap. Values mirror MODEL_REGISTRY.
        assert_eq!(price_for("qwen3.7-max"), Some(p(1.3, 7.8)));
        assert_eq!(price_for("qwen3.6-max-preview"), Some(p(1.3, 7.8)));
        assert_eq!(price_for("qwen3.6-plus"), Some(p(0.56, 1.68)));
        assert_eq!(price_for("qwen3.5-plus"), Some(p(0.56, 1.68)));
    }

    #[test]
    fn estimate_bills_reasoning_at_output_rate_when_unpublished() {
        let usage = Usage { input: 1_000_000, output: 500_000, reasoning: 200_000 };
        // gpt-5.5 publishes no reasoning rate → reasoning bills at $30/1M.
        let usd = estimate_usd(usage, price_for("gpt-5.5").unwrap());
        assert!((usd - (5.0 + 15.0 + 6.0)).abs() < 1e-9);
        // o3 has an explicit reasoning rate.
        let usd = estimate_usd(usage, price_for("o3").unwrap());
        assert!((usd - (10.0 + 20.0 + 8.0)).abs() < 1e-9);
    }

    #[test]
    fn ledger_accumulates_rows_and_lane_subtotals() {
        let mut ledger = CostLedger::new();
        let usage = Usage { input: 2_000_000, output: 1_000_000, reasoning: 0 };
        ledger.record("george", "George", CostLane::Council, "gpt-5.5", usage);
        ledger.record("george", "George", CostLane::Council, "gpt-5.5", usage);
        ledger.record("greta", "Greta", CostLane::Advisors, "gpt-5.5", usage);
        ledger.record("moderator", "Moderator", CostLane::Moderator, "unknown-model", usage);

        let snap = ledger.snapshot();
        assert_eq!(snap.rows.len(), 3);
        // George is the most expensive row (2× the usage).
        assert_eq!(snap.rows[0].agent_id, "george");
        assert!((snap.rows[0].usd - 2.0 * (10.0 + 30.0)).abs() < 1e-9);
        // The unknown-model row counted tokens but no USD, flagging the total.
        assert!(!snap.all_priced);
        let council: f64 = snap
            .lane_usd
            .iter()
            .find(|(l, _)| *l == CostLane::Council)
            .map(|(_, v)| *v)
            .unwrap();
        assert!((council - 80.0).abs() < 1e-9);
        assert_eq!(snap.total_input, 8_000_000);
    }

    #[test]
    fn budget_warns_at_80_percent_and_acts_at_the_cap() {
        let policy =
            BudgetPolicy { per_session: 10.0, per_day: 0.0, action: BudgetAction::Stop };
        assert_eq!(evaluate_budget(1.0, 0.0, policy), BudgetVerdict::Ok);
        assert!(matches!(evaluate_budget(8.0, 0.0, policy), BudgetVerdict::Warn(_)));
        assert!(matches!(evaluate_budget(10.0, 0.0, policy), BudgetVerdict::Stop(_)));
        // Warn action never stops.
        let policy = BudgetPolicy { action: BudgetAction::Warn, ..policy };
        assert!(matches!(evaluate_budget(12.0, 0.0, policy), BudgetVerdict::Warn(_)));
        // The daily dimension fires independently.
        let policy =
            BudgetPolicy { per_session: 0.0, per_day: 5.0, action: BudgetAction::Stop };
        assert!(matches!(evaluate_budget(0.0, 5.0, policy), BudgetVerdict::Stop(_)));
        // Zero caps disable everything.
        let policy =
            BudgetPolicy { per_session: 0.0, per_day: 0.0, action: BudgetAction::Stop };
        assert_eq!(evaluate_budget(1e9, 1e9, policy), BudgetVerdict::Ok);
    }

    #[test]
    fn daily_key_matches_known_dates() {
        assert_eq!(daily_key(0), "1970-01-01");
        // 2026-06-11 00:00:00 UTC.
        assert_eq!(daily_key(1_781_136_000), "2026-06-11");
        // Leap day: 2024-02-29 12:00:00 UTC.
        assert_eq!(daily_key(1_709_208_000), "2024-02-29");
        // Day boundary.
        assert_eq!(daily_key(86_399), "1970-01-01");
        assert_eq!(daily_key(86_400), "1970-01-02");
    }

    #[test]
    fn daily_ledger_persists_and_accumulates() {
        let dir = std::env::temp_dir().join(format!(
            "sc-cost-test-{}-{}",
            std::process::id(),
            now_unix()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let mut ledger = DailyLedger::load(&dir);
        assert_eq!(ledger.total_usd, 0.0);
        ledger.add(1.25);
        ledger.add(0.75);
        // Ignored deltas.
        ledger.add(0.0);
        ledger.add(f64::NAN);
        let reloaded = DailyLedger::load(&dir);
        assert!((reloaded.total_usd - 2.0).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
