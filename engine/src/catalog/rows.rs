//! The model table: one row per real model id with its class, limits, prices
//! and request contract. Refreshed 2026-09-19 from each provider's published
//! docs (see `docs/provider-contract-sheet.md` for the sources). CNY list
//! prices are converted at `CNY_PER_USD`; anything the docs do not price
//! stays `None` so the ledger reports an unpriced lower bound instead of a
//! guess. Ids unknown to the table inherit their family's contract by prefix
//! (`family_contract`) and stay unpriced.

use crate::types::{ExtraEffort, Provider};
use serde::{Deserialize, Serialize};

/// Exchange rate used for the Chinese providers' CNY list prices.
pub const CNY_PER_USD: f64 = 7.1;

/// Capability class: what the moderator routes hard reasoning to (Flagship)
/// versus bounded chores (Fast). Also what the Auto tiers map to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelClass {
    Flagship,
    Balanced,
    Fast,
}

impl ModelClass {
    pub fn label(self) -> &'static str {
        match self {
            ModelClass::Flagship => "flagship",
            ModelClass::Balanced => "balanced",
            ModelClass::Fast => "fast",
        }
    }
}

/// Which wire protocol the provider speaks for this model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiFamily {
    /// OpenAI Responses API (`/v1/responses`).
    Responses,
    /// Anthropic Messages API (`/v1/messages`); MiniMax rides it too.
    Messages,
    /// Google Generative Language `generateContent`.
    Gemini,
    /// OpenAI-compatible `chat/completions` (DeepSeek, Kimi, Qwen, Zhipu).
    ChatCompletions,
}

/// The per-model reasoning knob and its documented values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThinkingKnob {
    /// No reasoning control; temperature is the only dial.
    Absent,
    /// `reasoning.effort`; `floor` is the lowest value the model accepts
    /// ("low" for gpt-6-astra, "none" for gpt-5.x); `top` the highest.
    OpenAiEffort { floor: &'static str, top: Top },
    /// Claude 4.6+ / 5.x: `thinking.type: adaptive` (+ `display`), depth via
    /// `output_config.effort`. `default_on`: the model thinks unless told not
    /// to (5.x). `always_on`: `thinking.type: disabled` is rejected (Fable).
    /// `top`: the highest effort documented for it.
    AnthropicAdaptive {
        default_on: bool,
        always_on: bool,
        top: Top,
    },
    /// Claude ≤ 4.5: `thinking.type: enabled` + `budget_tokens`.
    AnthropicExtended,
    /// Gemini 3.x and 2.5 Pro: `thinkingConfig.thinkingLevel` low|medium|high.
    GeminiLevel,
    /// Gemini 2.5 Flash family: `thinkingConfig.thinkingBudget`.
    GeminiBudget,
    /// DeepSeek V4: `thinking.type` enabled|disabled + `reasoning_effort`
    /// low|high|max in thinking mode; temperature ignored while thinking.
    DeepSeekType,
    /// Kimi K3: top-level `reasoning_effort` low|high|max, always reasons, no
    /// `thinking` object.
    KimiEffort,
    /// Kimi K2.6: `thinking.type` enabled|disabled.
    KimiType,
    /// Kimi K2.7-code: always on; sending `disabled` is a 400.
    KimiAlwaysOn,
    /// Qwen 3.x: `enable_thinking` bool.
    QwenEnable,
    /// MiniMax-M3: `thinking.type: adaptive` switches it on; omitted = off.
    MiniMaxAdaptive,
    /// MiniMax M2.x: cannot be turned off; `disabled` is accepted and ignored.
    MiniMaxAlwaysOn,
    /// GLM-5.3 family: always on, `reasoning_effort` low|high|max (default max).
    GlmEffort,
    /// GLM-4.5 .. 5.2: `thinking.type` enabled|disabled; `forced` for 4.7.
    GlmType { forced: bool },
}

/// The highest reasoning effort a model documents. `High` is every model's
/// ceiling unless its docs name more (`docs/provider-contract-sheet.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Top {
    High,
    XHigh,
    Max,
}

impl ThinkingKnob {
    /// The levels above High this model takes, in order.
    pub fn extra_efforts(self) -> &'static [ExtraEffort] {
        let top = match self {
            OpenAiEffort { top, .. } | AnthropicAdaptive { top, .. } => top,
            _ => Top::High,
        };
        match top {
            Top::High => &[],
            Top::XHigh => &[ExtraEffort::XHigh],
            Top::Max => &ExtraEffort::ALL,
        }
    }

    /// The effort to send for a seat asking for `wanted`: the level itself
    /// when the model takes it, else the highest extra it does, else none
    /// (the request stays at High).
    pub fn effort_for(self, wanted: Option<ExtraEffort>) -> Option<ExtraEffort> {
        let wanted = wanted?;
        self.extra_efforts().iter().copied().rfind(|e| *e <= wanted)
    }
}

/// What a request for this model may carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Contract {
    pub api: ApiFamily,
    pub thinking: ThinkingKnob,
    /// `temperature` is accepted (when thinking is off, for the knobs that
    /// forbid sampling parameters while reasoning).
    pub sampling: bool,
    /// Native function calling is available.
    pub tools: bool,
    pub vision: bool,
}

/// USD per million tokens. `None` = not published.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Pricing {
    pub input: Option<f64>,
    /// Prompt-cache read (hit) price.
    pub cached_input: Option<f64>,
    /// Prompt-cache write price where the provider bills writes separately.
    pub cache_write: Option<f64>,
    /// Output price; every provider bills reasoning tokens at this rate.
    pub output: Option<f64>,
}

impl Pricing {
    pub const fn usd(input: f64, cached_input: f64, output: f64) -> Self {
        Self {
            input: Some(input),
            cached_input: Some(cached_input),
            cache_write: None,
            output: Some(output),
        }
    }
    pub const fn usd_with_write(
        input: f64,
        cached_input: f64,
        cache_write: f64,
        output: f64,
    ) -> Self {
        Self {
            input: Some(input),
            cached_input: Some(cached_input),
            cache_write: Some(cache_write),
            output: Some(output),
        }
    }
    pub const fn usd_no_cache(input: f64, output: f64) -> Self {
        Self {
            input: Some(input),
            cached_input: None,
            cache_write: None,
            output: Some(output),
        }
    }
    /// CNY list price converted at `CNY_PER_USD`.
    pub fn cny(input: f64, cached_input: Option<f64>, output: f64) -> Self {
        Self {
            input: Some(input / CNY_PER_USD),
            cached_input: cached_input.map(|c| c / CNY_PER_USD),
            cache_write: None,
            output: Some(output / CNY_PER_USD),
        }
    }
    pub fn is_priced(&self) -> bool {
        self.input.is_some() && self.output.is_some()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelRow {
    pub id: String,
    pub provider: Provider,
    pub name: String,
    pub class: ModelClass,
    pub context_window: u32,
    pub max_output: u32,
    pub pricing: Pricing,
    pub contract: Contract,
    /// True when the row came from the table (false = inferred by family).
    pub catalogued: bool,
}

const fn c(
    api: ApiFamily,
    thinking: ThinkingKnob,
    sampling: bool,
    tools: bool,
    vision: bool,
) -> Contract {
    Contract {
        api,
        thinking,
        sampling,
        tools,
        vision,
    }
}

#[allow(clippy::too_many_arguments)]
fn row(
    id: &str,
    provider: Provider,
    name: &str,
    class: ModelClass,
    ctx: u32,
    out: u32,
    pricing: Pricing,
    contract: Contract,
) -> ModelRow {
    ModelRow {
        id: id.to_string(),
        provider,
        name: name.to_string(),
        class,
        context_window: ctx,
        max_output: out,
        pricing,
        contract,
        catalogued: true,
    }
}

use ApiFamily::*;
use ModelClass::*;
use ThinkingKnob::*;

// Efforts per docs/provider-contract-sheet.md: gpt-6-astra and gpt-5.6 take
// up to `max`, gpt-5.5 up to `xhigh`; older GPT-5 generations document High.
const OPENAI_6: Contract = c(
    Responses,
    OpenAiEffort {
        floor: "low",
        top: Top::Max,
    },
    false,
    true,
    true,
);
const OPENAI_56: Contract = c(
    Responses,
    OpenAiEffort {
        floor: "none",
        top: Top::Max,
    },
    false,
    true,
    true,
);
const OPENAI_55: Contract = c(
    Responses,
    OpenAiEffort {
        floor: "none",
        top: Top::XHigh,
    },
    false,
    true,
    true,
);
const OPENAI_5: Contract = c(
    Responses,
    OpenAiEffort {
        floor: "none",
        top: Top::High,
    },
    false,
    true,
    true,
);
// The Fable family documents `xhigh` and `max`; the rest document High.
const CLAUDE_ALWAYS: Contract = c(
    Messages,
    AnthropicAdaptive {
        default_on: true,
        always_on: true,
        top: Top::Max,
    },
    false,
    true,
    true,
);
const CLAUDE_5: Contract = c(
    Messages,
    AnthropicAdaptive {
        default_on: true,
        always_on: false,
        top: Top::High,
    },
    false,
    true,
    true,
);
const CLAUDE_47: Contract = c(
    Messages,
    AnthropicAdaptive {
        default_on: false,
        always_on: false,
        top: Top::High,
    },
    false,
    true,
    true,
);
const CLAUDE_46: Contract = c(
    Messages,
    AnthropicAdaptive {
        default_on: false,
        always_on: false,
        top: Top::High,
    },
    true,
    true,
    true,
);
const CLAUDE_EXT: Contract = c(Messages, AnthropicExtended, true, true, true);
const GEMINI_LEVEL: Contract = c(Gemini, GeminiLevel, true, true, true);
const GEMINI_BUDGET: Contract = c(Gemini, GeminiBudget, true, true, true);
const DEEPSEEK_TEXT: Contract = c(ChatCompletions, DeepSeekType, false, true, false);
const DEEPSEEK_VISION: Contract = c(ChatCompletions, DeepSeekType, false, true, true);
const KIMI_K3: Contract = c(ChatCompletions, KimiEffort, false, true, true);
const KIMI_K27: Contract = c(ChatCompletions, KimiAlwaysOn, false, true, true);
const KIMI_K26: Contract = c(ChatCompletions, KimiType, false, true, true);
const QWEN_TEXT: Contract = c(ChatCompletions, QwenEnable, true, true, false);
const QWEN_VISION: Contract = c(ChatCompletions, QwenEnable, true, true, true);
const MINIMAX_M3: Contract = c(Messages, MiniMaxAdaptive, true, true, true);
const MINIMAX_M2: Contract = c(Messages, MiniMaxAlwaysOn, false, true, false);
const GLM_53_TEXT: Contract = c(ChatCompletions, GlmEffort, true, true, false);
const GLM_53_VISION: Contract = c(ChatCompletions, GlmEffort, true, true, true);
const GLM_TYPE: Contract = c(
    ChatCompletions,
    GlmType { forced: false },
    true,
    true,
    false,
);
const GLM_FORCED: Contract = c(ChatCompletions, GlmType { forced: true }, true, true, false);

/// Every catalogued row for a provider, newest and strongest first. The order
/// is a tie-breaker for the Auto resolver (`catalog_rank`).
pub fn catalog_rows(provider: Provider) -> Vec<ModelRow> {
    use Provider::*;
    match provider {
        // developers.openai.com/api/docs/pricing + per-model pages (Standard tier,
        // ≤272K prompt). Cache writes are 1.25x input on the 6 / 5.6 family.
        OpenAI => vec![
            row(
                "gpt-6-astra",
                OpenAI,
                "GPT-6 Astra",
                Flagship,
                1_050_000,
                128_000,
                Pricing::usd_with_write(10.0, 1.0, 12.5, 50.0),
                OPENAI_6,
            ),
            row(
                "gpt-5.6-sol",
                OpenAI,
                "GPT-5.6 Sol",
                Flagship,
                1_050_000,
                128_000,
                Pricing::usd_with_write(4.0, 0.4, 5.0, 20.0),
                OPENAI_56,
            ),
            row(
                "gpt-5.6-terra",
                OpenAI,
                "GPT-5.6 Terra",
                Balanced,
                1_050_000,
                128_000,
                Pricing::usd_with_write(2.0, 0.2, 2.5, 12.0),
                OPENAI_56,
            ),
            row(
                "gpt-5.6-luna",
                OpenAI,
                "GPT-5.6 Luna",
                Fast,
                1_050_000,
                128_000,
                Pricing::usd_with_write(0.2, 0.02, 0.25, 1.2),
                OPENAI_56,
            ),
            row(
                "gpt-5.5",
                OpenAI,
                "GPT-5.5",
                Flagship,
                1_050_000,
                128_000,
                Pricing::usd(5.0, 0.5, 30.0),
                OPENAI_55,
            ),
            row(
                "gpt-5.5-pro",
                OpenAI,
                "GPT-5.5 Pro",
                Flagship,
                1_050_000,
                128_000,
                Pricing::usd_no_cache(30.0, 180.0),
                OPENAI_5,
            ),
            row(
                "gpt-5.4",
                OpenAI,
                "GPT-5.4",
                Balanced,
                1_050_000,
                128_000,
                Pricing::usd(2.5, 0.25, 15.0),
                OPENAI_5,
            ),
            row(
                "gpt-5.4-mini",
                OpenAI,
                "GPT-5.4 Mini",
                Fast,
                1_050_000,
                128_000,
                Pricing::usd(0.75, 0.075, 4.5),
                OPENAI_5,
            ),
            row(
                "gpt-5.4-nano",
                OpenAI,
                "GPT-5.4 Nano",
                Fast,
                1_050_000,
                128_000,
                Pricing::usd(0.2, 0.02, 1.25),
                OPENAI_5,
            ),
            row(
                "gpt-5.3-codex",
                OpenAI,
                "GPT-5.3 Codex",
                Balanced,
                400_000,
                128_000,
                Pricing::usd(1.75, 0.175, 14.0),
                OPENAI_5,
            ),
            row(
                "gpt-5.2",
                OpenAI,
                "GPT-5.2",
                Balanced,
                400_000,
                128_000,
                Pricing::usd(1.75, 0.175, 14.0),
                OPENAI_5,
            ),
            row(
                "gpt-5.2-pro",
                OpenAI,
                "GPT-5.2 Pro",
                Flagship,
                400_000,
                128_000,
                Pricing::usd_no_cache(21.0, 168.0),
                OPENAI_5,
            ),
            row(
                "gpt-5.1",
                OpenAI,
                "GPT-5.1",
                Balanced,
                400_000,
                128_000,
                Pricing::usd(1.25, 0.125, 10.0),
                OPENAI_5,
            ),
        ],
        // platform.claude.com/docs/en/about-claude/pricing + models/overview.
        // Cache reads are 0.1x input (0.025x on Fable 5.1); 5-minute writes 1.25x.
        Anthropic => vec![
            row(
                "claude-fable-5-1",
                Anthropic,
                "Claude Fable 5.1",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(10.0, 0.25, 12.5, 50.0),
                CLAUDE_ALWAYS,
            ),
            row(
                "claude-opus-5",
                Anthropic,
                "Claude Opus 5",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(5.0, 0.5, 6.25, 25.0),
                CLAUDE_5,
            ),
            row(
                "claude-sonnet-5",
                Anthropic,
                "Claude Sonnet 5",
                Balanced,
                1_000_000,
                128_000,
                Pricing::usd_with_write(2.0, 0.2, 2.5, 10.0),
                CLAUDE_5,
            ),
            row(
                "claude-fable-5",
                Anthropic,
                "Claude Fable 5",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(10.0, 1.0, 12.5, 50.0),
                CLAUDE_ALWAYS,
            ),
            row(
                "claude-opus-4-8",
                Anthropic,
                "Claude Opus 4.8",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(5.0, 0.5, 6.25, 25.0),
                CLAUDE_47,
            ),
            row(
                "claude-opus-4-7",
                Anthropic,
                "Claude Opus 4.7",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(5.0, 0.5, 6.25, 25.0),
                CLAUDE_47,
            ),
            row(
                "claude-opus-4-6",
                Anthropic,
                "Claude Opus 4.6",
                Flagship,
                1_000_000,
                128_000,
                Pricing::usd_with_write(5.0, 0.5, 6.25, 25.0),
                CLAUDE_46,
            ),
            row(
                "claude-sonnet-4-6",
                Anthropic,
                "Claude Sonnet 4.6",
                Balanced,
                1_000_000,
                64_000,
                Pricing::usd_with_write(3.0, 0.3, 3.75, 15.0),
                CLAUDE_46,
            ),
            row(
                "claude-opus-4-5-20251101",
                Anthropic,
                "Claude Opus 4.5",
                Flagship,
                200_000,
                64_000,
                Pricing::usd_with_write(5.0, 0.5, 6.25, 25.0),
                CLAUDE_EXT,
            ),
            row(
                "claude-sonnet-4-5-20250929",
                Anthropic,
                "Claude Sonnet 4.5",
                Balanced,
                200_000,
                64_000,
                Pricing::usd_with_write(3.0, 0.3, 3.75, 15.0),
                CLAUDE_EXT,
            ),
            row(
                "claude-haiku-4-5-20251001",
                Anthropic,
                "Claude Haiku 4.5",
                Fast,
                200_000,
                64_000,
                Pricing::usd_with_write(1.0, 0.1, 1.25, 5.0),
                CLAUDE_EXT,
            ),
        ],
        // ai.google.dev/gemini-api/docs/pricing (Standard, paid tier, ≤200K prompt
        // for Pro). 3.6–3.8 Flash prices are the rates through 2026-12-31; the
        // page schedules a doubling from 2027-01-01. Implicit caching has no
        // write charge; the cache price is the read rate.
        Google => vec![
            row(
                "gemini-3.1-pro-preview",
                Google,
                "Gemini 3.1 Pro",
                Flagship,
                1_000_000,
                65_536,
                Pricing::usd(2.0, 0.2, 12.0),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.8-flash",
                Google,
                "Gemini 3.8 Flash",
                Balanced,
                1_000_000,
                65_536,
                Pricing::usd(0.75, 0.075, 3.75),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.7-flash",
                Google,
                "Gemini 3.7 Flash",
                Balanced,
                1_000_000,
                65_536,
                Pricing::usd(0.75, 0.075, 3.75),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.6-flash",
                Google,
                "Gemini 3.6 Flash",
                Balanced,
                1_000_000,
                65_536,
                Pricing::usd(0.75, 0.075, 3.75),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.5-flash",
                Google,
                "Gemini 3.5 Flash",
                Balanced,
                1_000_000,
                65_536,
                Pricing::usd(1.5, 0.15, 9.0),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.5-flash-lite",
                Google,
                "Gemini 3.5 Flash-Lite",
                Fast,
                1_000_000,
                65_536,
                Pricing::usd(0.3, 0.03, 2.5),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3.1-flash-lite",
                Google,
                "Gemini 3.1 Flash-Lite",
                Fast,
                1_000_000,
                65_536,
                Pricing::usd(0.25, 0.025, 1.5),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-3-flash-preview",
                Google,
                "Gemini 3 Flash Preview",
                Fast,
                1_000_000,
                65_536,
                Pricing::usd(0.5, 0.05, 3.0),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-2.5-pro",
                Google,
                "Gemini 2.5 Pro",
                Flagship,
                1_000_000,
                65_536,
                Pricing::usd(1.25, 0.125, 10.0),
                GEMINI_LEVEL,
            ),
            row(
                "gemini-2.5-flash",
                Google,
                "Gemini 2.5 Flash",
                Balanced,
                1_000_000,
                65_536,
                Pricing::usd(0.3, 0.03, 2.5),
                GEMINI_BUDGET,
            ),
            row(
                "gemini-2.5-flash-lite",
                Google,
                "Gemini 2.5 Flash-Lite",
                Fast,
                1_000_000,
                65_536,
                Pricing::usd(0.1, 0.01, 0.4),
                GEMINI_BUDGET,
            ),
        ],
        // api-docs.deepseek.com/quick_start/pricing — peak-hour USD rates (off-peak
        // is half); cache hits are billed at the cache-hit input rate.
        DeepSeek => vec![
            row(
                "deepseek-v4-pro",
                DeepSeek,
                "DeepSeek V4 Pro",
                Flagship,
                1_000_000,
                384_000,
                Pricing::usd(1.32, 0.044, 3.96),
                DEEPSEEK_TEXT,
            ),
            row(
                "deepseek-flash",
                DeepSeek,
                "DeepSeek V4.1 Flash",
                Fast,
                1_000_000,
                384_000,
                Pricing::usd(0.3, 0.006, 1.2),
                DEEPSEEK_VISION,
            ),
        ],
        // platform.moonshot.cn/docs/pricing/chat — CNY per 1M; K3 writes the
        // 5-minute cache at the input rate (1h at 2x).
        Kimi => vec![
            {
                let mut r = row(
                    "kimi-k3",
                    Kimi,
                    "Kimi K3",
                    Flagship,
                    1_048_576,
                    131_072,
                    Pricing::cny(20.0, Some(2.0), 100.0),
                    KIMI_K3,
                );
                r.pricing.cache_write = Some(20.0 / CNY_PER_USD);
                r
            },
            row(
                "kimi-k2.7-code",
                Kimi,
                "Kimi K2.7 Code",
                Balanced,
                262_144,
                131_072,
                Pricing::cny(6.5, Some(1.3), 27.0),
                KIMI_K27,
            ),
            row(
                "kimi-k2.7-code-highspeed",
                Kimi,
                "Kimi K2.7 Code Highspeed",
                Fast,
                262_144,
                131_072,
                Pricing::cny(13.0, Some(2.6), 54.0),
                KIMI_K27,
            ),
            row(
                "kimi-k2.6",
                Kimi,
                "Kimi K2.6",
                Balanced,
                262_144,
                131_072,
                Pricing::cny(6.5, Some(1.1), 27.0),
                KIMI_K26,
            ),
        ],
        // help.aliyun.com/zh/model-studio/models (北京 region, CNY per 1M, first
        // tier). Implicit cache hits bill at 20% of input.
        Qwen => vec![
            row(
                "qwen3.8-max",
                Qwen,
                "Qwen 3.8 Max",
                Flagship,
                1_000_000,
                65_536,
                Pricing::cny(12.0, Some(2.4), 36.0),
                QWEN_VISION,
            ),
            row(
                "qwen3.8-2.4t-a95b",
                Qwen,
                "Qwen 3.8 2.4T-A95B",
                Flagship,
                1_000_000,
                65_536,
                Pricing::cny(12.0, Some(2.4), 36.0),
                QWEN_TEXT,
            ),
            row(
                "qwen3.7-max",
                Qwen,
                "Qwen 3.7 Max",
                Flagship,
                1_000_000,
                65_536,
                Pricing::cny(12.0, Some(2.4), 36.0),
                QWEN_TEXT,
            ),
            row(
                "qwen3.8-27b",
                Qwen,
                "Qwen 3.8 27B",
                Balanced,
                1_000_000,
                65_536,
                Pricing::cny(3.0, Some(0.6), 12.0),
                QWEN_TEXT,
            ),
            row(
                "qwen3.7-plus",
                Qwen,
                "Qwen 3.7 Plus",
                Balanced,
                1_000_000,
                65_536,
                Pricing::cny(2.0, Some(0.4), 8.0),
                QWEN_TEXT,
            ),
            row(
                "qwen3.8-flash",
                Qwen,
                "Qwen 3.8 Flash",
                Fast,
                1_000_000,
                65_536,
                Pricing::cny(0.8, Some(0.16), 2.7),
                QWEN_VISION,
            ),
            row(
                "qwen3.7-flash",
                Qwen,
                "Qwen 3.7 Flash",
                Fast,
                1_000_000,
                65_536,
                Pricing::cny(0.2, Some(0.04), 0.8),
                QWEN_TEXT,
            ),
        ],
        // MiniMax publishes M3 as "price unchanged" from M2.7 (minimax.io/models/text/m3);
        // no per-token table was fetchable on 2026-09-19, so the M2.7 CNY rates
        // (2.1 / 8.4 per 1M) are kept and flagged unverified in the contract sheet.
        MiniMax => vec![
            row(
                "MiniMax-M3",
                MiniMax,
                "MiniMax M3",
                Flagship,
                1_000_000,
                128_000,
                Pricing::cny(2.1, None, 8.4),
                MINIMAX_M3,
            ),
            row(
                "MiniMax-M2.7",
                MiniMax,
                "MiniMax M2.7",
                Balanced,
                204_800,
                128_000,
                Pricing::cny(2.1, None, 8.4),
                MINIMAX_M2,
            ),
            row(
                "MiniMax-M2.7-highspeed",
                MiniMax,
                "MiniMax M2.7 Highspeed",
                Fast,
                204_800,
                128_000,
                Pricing::cny(4.2, None, 16.8),
                MINIMAX_M2,
            ),
        ],
        // docs.bigmodel.cn/cn/guide/start/pricing (CNY per 1M; cache hits priced
        // per model). GLM-5.3 family: thinking always on + reasoning_effort.
        Zhipu => vec![
            row(
                "glm-5.3",
                Zhipu,
                "GLM-5.3",
                Flagship,
                1_000_000,
                128_000,
                Pricing::cny(8.0, Some(2.0), 28.0),
                GLM_53_TEXT,
            ),
            row(
                "glm-5.3-flashx",
                Zhipu,
                "GLM-5.3 FlashX",
                Balanced,
                1_000_000,
                128_000,
                Pricing::cny(2.0, Some(0.57), 7.0),
                GLM_53_VISION,
            ),
            row(
                "glm-5.3-flash",
                Zhipu,
                "GLM-5.3 Flash",
                Fast,
                1_000_000,
                128_000,
                Pricing::cny(0.8, Some(0.23), 2.8),
                GLM_53_VISION,
            ),
            row(
                "glm-5.2",
                Zhipu,
                "GLM-5.2",
                Flagship,
                1_000_000,
                128_000,
                Pricing::cny(8.0, Some(2.0), 28.0),
                GLM_TYPE,
            ),
            row(
                "glm-5.1",
                Zhipu,
                "GLM-5.1",
                Flagship,
                200_000,
                128_000,
                Pricing::cny(6.0, Some(1.3), 24.0),
                GLM_TYPE,
            ),
            row(
                "glm-5-turbo",
                Zhipu,
                "GLM-5 Turbo",
                Balanced,
                200_000,
                128_000,
                Pricing::cny(5.0, Some(1.2), 22.0),
                GLM_TYPE,
            ),
            row(
                "glm-5",
                Zhipu,
                "GLM-5",
                Balanced,
                200_000,
                128_000,
                Pricing::cny(4.0, Some(1.0), 18.0),
                GLM_TYPE,
            ),
            row(
                "glm-4.7",
                Zhipu,
                "GLM-4.7",
                Balanced,
                200_000,
                128_000,
                Pricing::cny(4.0, Some(0.8), 16.0),
                GLM_FORCED,
            ),
        ],
    }
}

/// The wire protocol a provider speaks, independent of model.
pub fn api_family(provider: Provider) -> ApiFamily {
    match provider {
        Provider::OpenAI => Responses,
        Provider::Anthropic | Provider::MiniMax => Messages,
        Provider::Google => Gemini,
        Provider::DeepSeek | Provider::Kimi | Provider::Qwen | Provider::Zhipu => ChatCompletions,
    }
}

/// The contract an unknown id inherits from its family, by prefix. Documented
/// here because the live `/models` scan surfaces ids before the table does.
pub fn family_contract(provider: Provider, id: &str) -> Contract {
    let m = id.to_ascii_lowercase();
    let starts = |p: &str| m.starts_with(p);
    let has = |p: &str| m.contains(p);
    match provider {
        Provider::OpenAI => {
            // Every GPT generation from 5 on reasons with `reasoning.effort`; the
            // o-series too. GPT-4-era ids and chat aliases take a temperature.
            if starts("gpt-4") || starts("chatgpt") || starts("gpt-3") {
                c(Responses, Absent, true, true, true)
            } else if starts("gpt-6") {
                OPENAI_6
            } else if starts("gpt-5.6") {
                OPENAI_56
            } else if m == "gpt-5.5" {
                OPENAI_55
            } else if starts("gpt-")
                || (m.len() > 1 && m.starts_with('o') && m.as_bytes()[1].is_ascii_digit())
            {
                OPENAI_5
            } else {
                c(Responses, Absent, true, true, true)
            }
        }
        Provider::Anthropic => {
            if has("fable") || has("mythos") {
                CLAUDE_ALWAYS
            } else if has("-opus-5") || has("-sonnet-5") || has("-haiku-5") {
                CLAUDE_5
            } else if has("opus-4-8") || has("opus-4-7") {
                CLAUDE_47
            } else if has("opus-4-6") || has("sonnet-4-6") {
                CLAUDE_46
            } else if has("-4-") || has("-4-1") || has("-4-5") || has("3-7") {
                CLAUDE_EXT
            } else {
                c(Messages, Absent, true, true, true)
            }
        }
        Provider::Google => {
            // Gemini 3 and later (and 2.5 Pro) take `thinkingLevel`; the 2.5
            // Flash family takes a token budget; older generations do not think.
            let major = m
                .strip_prefix("gemini-")
                .and_then(|rest| rest.split(['-', '.']).next())
                .and_then(|n| n.parse::<u32>().ok());
            if matches!(major, Some(n) if n >= 3) || starts("gemini-2.5-pro") {
                GEMINI_LEVEL
            } else if starts("gemini-2.5") {
                GEMINI_BUDGET
            } else {
                c(Gemini, Absent, true, true, true)
            }
        }
        Provider::DeepSeek => {
            if starts("deepseek-v4") || starts("deepseek-flash") || starts("deepseek-reasoner") {
                if has("flash") {
                    DEEPSEEK_VISION
                } else {
                    DEEPSEEK_TEXT
                }
            } else {
                c(ChatCompletions, Absent, true, true, false)
            }
        }
        Provider::Kimi => {
            if starts("kimi-k3") {
                KIMI_K3
            } else if starts("kimi-k2.7-code") {
                KIMI_K27
            } else if starts("kimi-k2") {
                KIMI_K26
            } else {
                c(ChatCompletions, Absent, true, true, false)
            }
        }
        Provider::Qwen => {
            if starts("qwen3")
                || starts("qwen-plus")
                || starts("qwen-max")
                || starts("qwen-flash")
                || starts("qwq")
            {
                if has("qwen3.8-max") || has("qwen3.8-flash") || has("omni") {
                    QWEN_VISION
                } else {
                    QWEN_TEXT
                }
            } else {
                c(ChatCompletions, Absent, true, true, false)
            }
        }
        Provider::MiniMax => {
            if has("m3") {
                MINIMAX_M3
            } else if has("m2") {
                MINIMAX_M2
            } else {
                c(Messages, Absent, true, true, false)
            }
        }
        Provider::Zhipu => {
            if starts("glm-5.3") {
                if has("flash") {
                    GLM_53_VISION
                } else {
                    GLM_53_TEXT
                }
            } else if m == "glm-4.7" {
                GLM_FORCED
            } else if starts("glm-5") || starts("glm-4.5") || starts("glm-4.6") || starts("glm-4.7")
            {
                GLM_TYPE
            } else {
                c(ChatCompletions, Absent, true, true, false)
            }
        }
    }
}

/// Class guess for an id the table does not know.
pub fn family_class(id: &str) -> ModelClass {
    let m = id.to_ascii_lowercase();
    if super::is_speed_variant(&m) {
        Fast
    } else if [
        "pro", "max", "opus", "ultra", "astra", "sol", "fable", "mythos", "plus", "k3",
    ]
    .iter()
    .any(|k| m.contains(k))
    {
        Flagship
    } else {
        Balanced
    }
}

/// The row for `(provider, id)`: exact table match, else a family row that
/// carries the inferred contract and class, a generous context guess, and no
/// price.
pub fn model_row(provider: Provider, id: &str) -> ModelRow {
    if let Some(r) = catalog_rows(provider)
        .into_iter()
        .find(|r| r.id.eq_ignore_ascii_case(id))
    {
        return r;
    }
    ModelRow {
        id: id.to_string(),
        provider,
        name: id.to_string(),
        class: family_class(id),
        context_window: 200_000,
        max_output: 32_768,
        pricing: Pricing::default(),
        contract: family_contract(provider, id),
        catalogued: false,
    }
}
