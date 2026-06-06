//! Model catalog + the Auto resolver (a faithful port of the desktop
//! `packages/shared/src/models/resolver.ts`).
//!
//! Hard rule (no fabricated model ids): the catalog reuses only real ids, and
//! the resolver never invents one — candidates come from a live scan or this
//! catalog. Version dominates ranking so a newer scanned flagship is adopted
//! automatically.

use crate::types::{Provider, ReasoningTier};
use regex::Regex;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelSource {
    Catalog,
    Scanned,
}

#[derive(Debug, Clone)]
pub struct DiscoveredModel {
    pub id: String,
    pub provider: Provider,
    pub display_name: Option<String>,
    pub source: ModelSource,
    pub context_window: Option<u32>,
    pub supports_thinking: Option<bool>,
    pub output_price: Option<f64>,
}

impl DiscoveredModel {
    fn catalog(
        id: &str,
        provider: Provider,
        name: &str,
        ctx: u32,
        thinking: bool,
        out_price: f64,
    ) -> Self {
        Self {
            id: id.to_string(),
            provider,
            display_name: Some(name.to_string()),
            source: ModelSource::Catalog,
            context_window: Some(ctx),
            supports_thinking: Some(thinking),
            output_price: Some(out_price),
        }
    }
}

/// Static catalog flagship per provider — the fallback "Auto" lands on when no
/// scan has run. Real ids only.
pub fn default_model(provider: Provider) -> &'static str {
    match provider {
        Provider::OpenAI => "gpt-5.5",
        Provider::Anthropic => "claude-opus-4-8",
        Provider::Google => "gemini-3.1-pro-preview",
        Provider::DeepSeek => "deepseek-v4-pro",
        Provider::Kimi => "kimi-k2.6",
        Provider::Qwen => "qwen3.7-max",
        Provider::MiniMax => "MiniMax-M2.7-highspeed",
        Provider::Zhipu => "glm-5.1",
    }
}

/// A representative slice of the desktop catalog (real ids), enough for Auto to
/// pick sensible flagship / balanced / fast models per provider offline.
pub fn catalog_models(provider: Provider) -> Vec<DiscoveredModel> {
    use Provider::*;
    let m = DiscoveredModel::catalog;
    match provider {
        OpenAI => vec![
            m("gpt-5.5", OpenAI, "GPT-5.5", 1_000_000, true, 30.0),
            m("gpt-5.4", OpenAI, "GPT-5.4", 1_050_000, true, 15.0),
            m("gpt-5.2", OpenAI, "GPT-5.2", 128_000, true, 15.0),
            m("gpt-5-mini", OpenAI, "GPT-5 Mini", 128_000, true, 1.6),
            m("gpt-5-nano", OpenAI, "GPT-5 Nano", 128_000, true, 0.4),
        ],
        Anthropic => vec![
            m("claude-opus-4-8", Anthropic, "Claude Opus 4.8", 1_000_000, true, 25.0),
            m("claude-opus-4-7", Anthropic, "Claude Opus 4.7", 1_000_000, true, 25.0),
            m("claude-sonnet-4-5-20250929", Anthropic, "Claude Sonnet 4.5", 200_000, true, 15.0),
            m("claude-haiku-4-5-20251001", Anthropic, "Claude Haiku 4.5", 200_000, true, 5.0),
        ],
        Google => vec![
            m("gemini-3.1-pro-preview", Google, "Gemini 3.1 Pro", 1_000_000, true, 12.0),
            m("gemini-3-flash-preview", Google, "Gemini 3 Flash", 1_000_000, false, 0.4),
            m("gemini-2.5-pro", Google, "Gemini 2.5 Pro", 1_000_000, true, 5.0),
            m("gemini-2.5-flash-lite", Google, "Gemini 2.5 Flash Lite", 1_000_000, false, 0.08),
        ],
        DeepSeek => vec![
            m("deepseek-v4-pro", DeepSeek, "DeepSeek V4 Pro", 1_000_000, true, 3.48),
            m("deepseek-v4-flash", DeepSeek, "DeepSeek V4 Flash", 1_000_000, true, 1.1),
            m("deepseek-reasoner", DeepSeek, "DeepSeek Reasoner", 128_000, true, 2.19),
            m("deepseek-chat", DeepSeek, "DeepSeek Chat", 128_000, false, 1.1),
        ],
        Kimi => vec![
            m("kimi-k2.6", Kimi, "Kimi K2.6", 262_144, true, 4.0),
            m("kimi-k2.5", Kimi, "Kimi K2.5", 256_000, false, 3.6),
            m("kimi-k2-thinking", Kimi, "Kimi K2 Thinking", 256_000, true, 2.4),
            m("kimi-k2-turbo-preview", Kimi, "Kimi K2 Turbo", 256_000, false, 2.4),
        ],
        Qwen => vec![
            m("qwen3.7-max", Qwen, "Qwen 3.7 Max", 1_000_000, true, 7.8),
            m("qwen3.6-plus", Qwen, "Qwen 3.6 Plus", 131_072, true, 1.68),
        ],
        MiniMax => vec![m(
            "MiniMax-M2.7-highspeed",
            MiniMax,
            "MiniMax M2.7 Highspeed",
            1_000_000,
            true,
            2.4,
        )],
        Zhipu => vec![
            m("glm-5.1", Zhipu, "GLM-5.1", 200_000, true, 4.4),
            m("glm-5", Zhipu, "GLM-5", 200_000, true, 2.0),
            m("glm-4.7", Zhipu, "GLM-4.7", 128_000, false, 1.0),
        ],
    }
}

fn speed_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(mini|flash|lite|nano|turbo|haiku|air|small|fast|instant|highspeed|speed|tiny|micro)")
            .unwrap()
    })
}

fn non_chat_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(image|embed|embedding|audio|tts|whisper|realtime|moderation|rerank|guard|sora|dall|speech|ocr|vision-preview|-vl-|voice|video|^ft:|transcribe|search-api)")
            .unwrap()
    })
}

fn thinking_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(think|reason|reasoner|-r1|^o\d|\bo\d-)").unwrap())
}

pub fn is_non_chat(id: &str) -> bool {
    non_chat_re().is_match(id)
}

pub fn is_speed_variant(id: &str) -> bool {
    speed_re().is_match(id)
}

/// Largest decimal version token < 100 after stripping dated snapshots.
pub fn version_score(id: &str) -> f64 {
    static DATE_FULL: OnceLock<Regex> = OnceLock::new();
    static DATE8: OnceLock<Regex> = OnceLock::new();
    static YEAR: OnceLock<Regex> = OnceLock::new();
    static SNAP: OnceLock<Regex> = OnceLock::new();
    static TOKEN: OnceLock<Regex> = OnceLock::new();

    let mut s = id.to_lowercase();
    s = DATE_FULL
        .get_or_init(|| Regex::new(r"(19|20)\d{2}[-_]\d{2}[-_]\d{2}").unwrap())
        .replace_all(&s, "")
        .into_owned();
    s = DATE8.get_or_init(|| Regex::new(r"\d{8}").unwrap()).replace_all(&s, "").into_owned();
    s = YEAR
        .get_or_init(|| Regex::new(r"(19|20)\d{2}").unwrap())
        .replace_all(&s, "")
        .into_owned();
    s = SNAP
        .get_or_init(|| Regex::new(r"[-_]\d{3,4}(?:[-_]|$)").unwrap())
        .replace_all(&s, "")
        .into_owned();
    // Strip parameter-count / context-window unit tokens (72b, 235b, 16k, 128k)
    // so "qwen2.5-72b-instruct" scores 2.5, not 72.
    static UNIT: OnceLock<Regex> = OnceLock::new();
    s = UNIT
        .get_or_init(|| Regex::new(r"(?i)(\d+(?:\.\d+)?)[kmb]\b").unwrap())
        .replace_all(&s, "")
        .into_owned();

    let token = TOKEN.get_or_init(|| Regex::new(r"\d+(?:[.\-]\d+)?").unwrap());
    let mut best = 0.0_f64;
    for cap in token.find_iter(&s) {
        let normalized = cap.as_str().replace('-', ".");
        if let Ok(v) = normalized.parse::<f64>() {
            if v < 100.0 && v > best {
                best = v;
            }
        }
    }
    best
}

/// Capability score — version dominates; thinking/premium/catalog are
/// tie-breakers; speed variants are pushed below same-gen flagships.
pub fn capability_score(model: &DiscoveredModel, provider: Provider) -> f64 {
    let id = model.id.to_lowercase();
    let mut score = version_score(&id) * 1000.0;

    if let Some(rank) = catalog_rank(provider, &model.id) {
        score += (20.0 - rank as f64).max(0.0);
    }
    if model.supports_thinking.unwrap_or(false) || thinking_re().is_match(&id) {
        score += 30.0;
    }
    if Regex::new(r"(?i)(pro|max|opus|ultra|flagship|plus)").unwrap().is_match(&id) {
        score += 20.0;
    }
    if is_speed_variant(&id) {
        score -= 900.0;
    }
    if let Some(ctx) = model.context_window {
        score += (ctx as f64).log10().min(10.0);
    }
    score
}

/// Speed score — higher means faster / cheaper (used for the low tier).
pub fn speed_score(model: &DiscoveredModel) -> f64 {
    let id = model.id.to_lowercase();
    let mut score = 0.0;
    if is_speed_variant(&id) {
        score += 600.0;
    }
    if let Some(price) = model.output_price {
        score += (120.0 - price).max(0.0);
    }
    score += version_score(&id) * 6.0;
    if model.supports_thinking.unwrap_or(false) || thinking_re().is_match(&id) {
        score -= 40.0;
    }
    score
}

fn catalog_rank(provider: Provider, id: &str) -> Option<usize> {
    catalog_models(provider).iter().position(|m| m.id == id)
}

/// Merge scanned models with the catalog, deduped by id (scanned ids matching
/// the catalog are enriched + marked Scanned; unknown ids inferred).
pub fn merge_with_catalog(provider: Provider, scanned: Vec<DiscoveredModel>) -> Vec<DiscoveredModel> {
    let mut out = catalog_models(provider);
    for s in scanned {
        if s.provider != provider {
            continue;
        }
        if let Some(existing) = out.iter_mut().find(|m| m.id == s.id) {
            existing.source = ModelSource::Scanned;
            if existing.display_name.is_none() {
                existing.display_name = s.display_name;
            }
        } else {
            let mut s = s;
            if s.supports_thinking.is_none() {
                s.supports_thinking = Some(thinking_re().is_match(&s.id.to_lowercase()));
            }
            out.push(s);
        }
    }
    out
}

/// Resolve a concrete model id for `(provider, tier)`. An explicit `selection`
/// (not "auto"/empty) is honored; otherwise candidates are ranked for the tier.
pub fn resolve_model(
    provider: Provider,
    tier: ReasoningTier,
    available: &[DiscoveredModel],
    selection: Option<&str>,
) -> String {
    if let Some(sel) = selection {
        let sel = sel.trim();
        if !sel.is_empty() && sel != "auto" {
            return sel.to_string();
        }
    }

    let catalog_fallback;
    let mut candidates: Vec<&DiscoveredModel> = available
        .iter()
        .filter(|m| m.provider == provider && !is_non_chat(&m.id))
        .collect();
    if candidates.is_empty() {
        // Fall back to the catalog and still rank it for the tier (parity with
        // the TS resolver), rather than always returning the flagship.
        catalog_fallback = catalog_models(provider);
        candidates = catalog_fallback.iter().filter(|m| !is_non_chat(&m.id)).collect();
    }
    if candidates.is_empty() {
        return default_model(provider).to_string();
    }
    if candidates.len() == 1 {
        return candidates[0].id.clone();
    }

    match tier {
        ReasoningTier::High => {
            candidates.sort_by(|a, b| {
                capability_score(b, provider)
                    .partial_cmp(&capability_score(a, provider))
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            candidates[0].id.clone()
        }
        ReasoningTier::Low => {
            candidates.sort_by(|a, b| {
                speed_score(b).partial_cmp(&speed_score(a)).unwrap_or(std::cmp::Ordering::Equal)
            });
            candidates[0].id.clone()
        }
        ReasoningTier::Medium => {
            // Blend normalized capability + speed.
            let caps: Vec<f64> =
                candidates.iter().map(|m| capability_score(m, provider)).collect();
            let speeds: Vec<f64> = candidates.iter().map(|m| speed_score(m)).collect();
            let (cmin, cmax) = min_max(&caps);
            let (smin, smax) = min_max(&speeds);
            let mut best = 0;
            let mut best_blend = f64::NEG_INFINITY;
            for i in 0..candidates.len() {
                let blend = 0.55 * normalize(caps[i], cmin, cmax)
                    + 0.45 * normalize(speeds[i], smin, smax);
                if blend > best_blend {
                    best_blend = blend;
                    best = i;
                }
            }
            candidates[best].id.clone()
        }
    }
}

fn min_max(values: &[f64]) -> (f64, f64) {
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for &v in values {
        min = min.min(v);
        max = max.max(v);
    }
    if !min.is_finite() {
        (0.0, 0.0)
    } else {
        (min, max)
    }
}

fn normalize(v: f64, min: f64, max: f64) -> f64 {
    if max <= min {
        0.5
    } else {
        (v - min) / (max - min)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scanned(id: &str, provider: Provider) -> DiscoveredModel {
        DiscoveredModel {
            id: id.to_string(),
            provider,
            display_name: None,
            source: ModelSource::Scanned,
            context_window: None,
            supports_thinking: None,
            output_price: None,
        }
    }

    #[test]
    fn version_strips_dates() {
        assert_eq!(version_score("gpt-5.5"), 5.5);
        assert_eq!(version_score("claude-opus-4-8"), 4.8);
        assert_eq!(version_score("claude-opus-4-5-20251101"), 4.5);
        assert_eq!(version_score("gpt-5.5-2026-04-01"), 5.5);
        assert_eq!(version_score("kimi-k2-0905-preview"), 2.0);
    }

    #[test]
    fn version_ignores_param_and_context_suffixes() {
        assert_eq!(version_score("qwen2.5-72b-instruct"), 2.5);
        assert_eq!(version_score("qwen2.5-32b-instruct"), 2.5);
        assert_eq!(version_score("qwen3-235b-a22b"), 3.0);
        assert_eq!(version_score("gpt-3.5-turbo-16k"), 3.5);
    }

    #[test]
    fn keeps_flagship_over_open_weight_72b() {
        let merged = merge_with_catalog(
            Provider::Qwen,
            vec![scanned("qwen2.5-72b-instruct", Provider::Qwen)],
        );
        assert_eq!(
            resolve_model(Provider::Qwen, ReasoningTier::High, &merged, Some("auto")),
            "qwen3.7-max"
        );
    }

    #[test]
    fn high_tier_picks_catalog_flagship() {
        let avail = catalog_models(Provider::Anthropic);
        assert_eq!(
            resolve_model(Provider::Anthropic, ReasoningTier::High, &avail, Some("auto")),
            "claude-opus-4-8"
        );
    }

    #[test]
    fn adopts_newer_scanned_flagship() {
        let merged = merge_with_catalog(Provider::OpenAI, vec![scanned("gpt-5.6", Provider::OpenAI)]);
        assert_eq!(
            resolve_model(Provider::OpenAI, ReasoningTier::High, &merged, Some("auto")),
            "gpt-5.6"
        );
    }

    #[test]
    fn low_tier_picks_fast_variant() {
        let avail = catalog_models(Provider::OpenAI);
        let id = resolve_model(Provider::OpenAI, ReasoningTier::Low, &avail, Some("auto"));
        assert!(is_speed_variant(&id), "expected a speed variant, got {id}");
    }

    #[test]
    fn explicit_selection_honored() {
        let avail = catalog_models(Provider::OpenAI);
        assert_eq!(
            resolve_model(Provider::OpenAI, ReasoningTier::High, &avail, Some("gpt-5-mini")),
            "gpt-5-mini"
        );
    }
}
