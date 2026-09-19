//! Core domain types shared across the CLI.

use serde::{Deserialize, Serialize};
use std::fmt;

/// The eight supported model providers (mirrors the desktop app).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    OpenAI,
    Anthropic,
    Google,
    DeepSeek,
    Kimi,
    Qwen,
    MiniMax,
    Zhipu,
}

impl Provider {
    pub const ALL: [Provider; 8] = [
        Provider::OpenAI,
        Provider::Anthropic,
        Provider::Google,
        Provider::DeepSeek,
        Provider::Kimi,
        Provider::Qwen,
        Provider::MiniMax,
        Provider::Zhipu,
    ];

    /// Stable lowercase slug used in config keys and CLI flags.
    pub fn slug(self) -> &'static str {
        match self {
            Provider::OpenAI => "openai",
            Provider::Anthropic => "anthropic",
            Provider::Google => "google",
            Provider::DeepSeek => "deepseek",
            Provider::Kimi => "kimi",
            Provider::Qwen => "qwen",
            Provider::MiniMax => "minimax",
            Provider::Zhipu => "zhipu",
        }
    }

    /// Human-facing provider name.
    pub fn display_name(self) -> &'static str {
        match self {
            Provider::OpenAI => "OpenAI",
            Provider::Anthropic => "Anthropic",
            Provider::Google => "Google",
            Provider::DeepSeek => "DeepSeek",
            Provider::Kimi => "Moonshot",
            Provider::Qwen => "Qwen",
            Provider::MiniMax => "MiniMax",
            Provider::Zhipu => "Z.AI",
        }
    }

    /// The environment variable that supplies this provider's API key.
    pub fn env_var(self) -> &'static str {
        match self {
            Provider::OpenAI => "OPENAI_API_KEY",
            Provider::Anthropic => "ANTHROPIC_API_KEY",
            Provider::Google => "GOOGLE_API_KEY",
            Provider::DeepSeek => "DEEPSEEK_API_KEY",
            Provider::Kimi => "MOONSHOT_API_KEY",
            Provider::Qwen => "DASHSCOPE_API_KEY",
            Provider::MiniMax => "MINIMAX_API_KEY",
            Provider::Zhipu => "ZHIPU_API_KEY",
        }
    }

    /// The provider's default API base URL (Chinese providers on their
    /// Chinese endpoints).
    pub fn default_base_url(self) -> &'static str {
        let provider = self;
        match provider {
            Provider::OpenAI => "https://api.openai.com",
            Provider::Anthropic => "https://api.anthropic.com",
            Provider::Google => "https://generativelanguage.googleapis.com",
            Provider::DeepSeek => "https://api.deepseek.com",
            Provider::Kimi => "https://api.moonshot.cn",
            Provider::Qwen => "https://dashscope.aliyuncs.com/compatible-mode/v1",
            Provider::MiniMax => "https://api.minimaxi.com/anthropic",
            Provider::Zhipu => "https://open.bigmodel.cn/api/paas/v4",
        }
    }

    pub fn from_slug(s: &str) -> Option<Provider> {
        Provider::ALL.into_iter().find(|p| p.slug() == s)
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.slug())
    }
}

/// Council-wide reasoning level. Maps to a chosen model per provider and to a
/// provider-specific reasoning-effort knob.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningTier {
    Low,
    Medium,
    High,
}

impl ReasoningTier {
    pub const ALL: [ReasoningTier; 3] = [
        ReasoningTier::Low,
        ReasoningTier::Medium,
        ReasoningTier::High,
    ];

    pub fn label(self) -> &'static str {
        match self {
            ReasoningTier::Low => "Low",
            ReasoningTier::Medium => "Medium",
            ReasoningTier::High => "High",
        }
    }
}

impl std::str::FromStr for ReasoningTier {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "low" => Ok(ReasoningTier::Low),
            "medium" | "med" => Ok(ReasoningTier::Medium),
            "high" => Ok(ReasoningTier::High),
            other => Err(format!("unknown reasoning tier: {other}")),
        }
    }
}

/// Confidence band on a piece of evidence (high / medium / low).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Confidence {
    High,
    Medium,
    Low,
}

impl Confidence {
    pub fn label(self) -> &'static str {
        match self {
            Confidence::High => "high",
            Confidence::Medium => "medium",
            Confidence::Low => "low",
        }
    }
    pub fn from_str_lenient(s: &str) -> Confidence {
        match s.to_ascii_lowercase().as_str() {
            "high" => Confidence::High,
            "low" => Confidence::Low,
            _ => Confidence::Medium,
        }
    }
}

/// A message role in the conversation transcript.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    /// The result of a tool call, answering an assistant `tool_calls` entry.
    Tool,
}

/// One transcript message destined for a provider request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Tool calls an assistant turn requested (echoed back to the provider
    /// ahead of their results).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// For `Role::Tool`: the call this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// For `Role::Tool`: the tool's name (Gemini keys results by name).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}

impl ChatMessage {
    fn plain(role: Role, content: impl Into<String>) -> Self {
        Self {
            role,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            tool_name: None,
        }
    }
    pub fn system(content: impl Into<String>) -> Self {
        Self::plain(Role::System, content)
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self::plain(Role::User, content)
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self::plain(Role::Assistant, content)
    }
    /// An assistant turn that requested tools (its text may be empty).
    pub fn assistant_with_calls(content: impl Into<String>, calls: Vec<ToolCall>) -> Self {
        Self {
            tool_calls: calls,
            ..Self::plain(Role::Assistant, content)
        }
    }
    /// One tool result, answering `call_id` for the tool `name`.
    pub fn tool(
        call_id: impl Into<String>,
        name: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            tool_call_id: Some(call_id.into()),
            tool_name: Some(name.into()),
            ..Self::plain(Role::Tool, content)
        }
    }
}

/// Token usage reported by a completion.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    /// Prompt-cache hits, a subset of `input`, billed at the cached rate.
    pub cached_input: u64,
    /// Prompt-cache writes (Anthropic `cache_creation_input_tokens` and the
    /// like), billed at the write rate where the provider has one.
    pub cache_write: u64,
}

/// A tool the model may call, described with a JSON-schema `parameters` object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// One tool call a model requested.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// Gemini thought signature riding on the `functionCall` part; must be
    /// echoed back unchanged when the call is replayed to the model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
}

/// Why a completion stopped.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum StopReason {
    #[default]
    EndTurn,
    /// The model requested tools; `CompletionOutcome::tool_calls` is non-empty.
    ToolUse,
    MaxTokens,
    Other,
}

/// Everything a finished completion produced.
#[derive(Debug, Clone, Default)]
pub struct CompletionOutcome {
    pub usage: Usage,
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: StopReason,
}

/// A completion request handed to a provider client.
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub temperature: f32,
    pub tier: ReasoningTier,
    /// Tools offered through the provider's native function calling.
    pub tools: Vec<ToolSpec>,
    /// A stable key for provider prompt caches: sets `prompt_cache_key` on
    /// the Responses API and turns on automatic caching on the Messages API.
    pub cache_key: Option<String>,
}

impl Default for CompletionRequest {
    fn default() -> Self {
        Self {
            model: String::new(),
            system: None,
            messages: Vec::new(),
            max_tokens: 1024,
            temperature: 1.0,
            tier: ReasoningTier::Medium,
            tools: Vec::new(),
            cache_key: None,
        }
    }
}

/// A streamed completion chunk.
#[derive(Debug, Clone, Default)]
pub struct CompletionChunk {
    pub content: String,
    pub thinking: String,
}

/// Which engine lane a completion is billed to in the cost ledger.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
pub enum CostLane {
    #[default]
    Council,
    Advisors,
    Moderator,
    Utility,
}

impl CostLane {
    pub fn label(self) -> &'static str {
        match self {
            CostLane::Council => "council",
            CostLane::Advisors => "advisors",
            CostLane::Moderator => "moderator",
            CostLane::Utility => "utility",
        }
    }
}

/// One speaker's accumulated tokens + estimated cost.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CostRow {
    pub agent_id: String,
    pub name: String,
    pub lane: CostLane,
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
    pub usd: f64,
    /// False when this row includes usage on a model with no published price
    /// (the USD figure is then a lower bound).
    pub priced: bool,
}

/// A point-in-time view of the session's cost ledger.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CostSnapshot {
    /// Per-speaker rows, sorted by USD descending.
    pub rows: Vec<CostRow>,
    /// Subtotals per lane (council / advisors / moderator / utility).
    pub lane_usd: Vec<(CostLane, f64)>,
    pub total_usd: f64,
    pub total_input: u64,
    pub total_output: u64,
    pub total_reasoning: u64,
    /// True when every recorded model had published pricing.
    pub all_priced: bool,
    /// The rolling UTC-day total (this session included), if tracked.
    pub daily_usd: f64,
    /// Active caps (0 = off) so the UI can show budget context.
    pub session_cap: f64,
    pub daily_cap: f64,
    /// A budget warning/stop message, when one fired with this snapshot.
    pub note: Option<String>,
}

/// How a seat picks its model: the Auto resolver at a tier (High = flagship,
/// Medium = balanced, Low = fast) or an explicit id from the provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelChoice {
    Auto(ReasoningTier),
    Id(String),
}

impl ModelChoice {
    /// `"auto"`, `"auto-fast"`, `"auto-balanced"`, or a model id.
    pub fn parse(s: &str) -> ModelChoice {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "auto" | "auto-flagship" => ModelChoice::Auto(ReasoningTier::High),
            "auto-balanced" => ModelChoice::Auto(ReasoningTier::Medium),
            "auto-fast" => ModelChoice::Auto(ReasoningTier::Low),
            _ => ModelChoice::Id(s.trim().to_string()),
        }
    }
    pub fn label(&self) -> String {
        match self {
            ModelChoice::Auto(ReasoningTier::High) => "auto".into(),
            ModelChoice::Auto(ReasoningTier::Medium) => "auto-balanced".into(),
            ModelChoice::Auto(ReasoningTier::Low) => "auto-fast".into(),
            ModelChoice::Id(id) => id.clone(),
        }
    }
}

/// A provider plus a model choice (the moderator and utility slots).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRef {
    pub provider: Provider,
    pub model: ModelChoice,
}

/// One council seat: a name, a provider and a model. Several seats may share
/// a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Seat {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub model: ModelChoice,
    /// Overrides the round's reasoning tier for this seat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningTier>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Roster {
    pub seats: Vec<Seat>,
}

/// The eight named seats, one per provider, in the traditional order.
pub const DEFAULT_SEATS: [(&str, &str, Provider); 8] = [
    ("george", "George", Provider::OpenAI),
    ("cathy", "Cathy", Provider::Anthropic),
    ("grace", "Grace", Provider::Google),
    ("douglas", "Douglas", Provider::DeepSeek),
    ("kate", "Kate", Provider::Kimi),
    ("quinn", "Quinn", Provider::Qwen),
    ("mary", "Mary", Provider::MiniMax),
    ("zara", "Zara", Provider::Zhipu),
];

impl Roster {
    /// The default roster on Auto flagships.
    pub fn default_eight() -> Roster {
        Roster {
            seats: DEFAULT_SEATS
                .iter()
                .map(|(id, name, provider)| Seat {
                    id: id.to_string(),
                    name: name.to_string(),
                    provider: *provider,
                    model: ModelChoice::Auto(ReasoningTier::High),
                    reasoning: None,
                })
                .collect(),
        }
    }
    /// Keep only seats whose provider has a key.
    pub fn with_keys(mut self, has_key: impl Fn(Provider) -> bool) -> Roster {
        self.seats.retain(|s| has_key(s.provider));
        self
    }
    /// The first `n` seats (presets: quick 3, standard 4, full 8).
    pub fn take(mut self, n: usize) -> Roster {
        self.seats.truncate(n);
        self
    }
    pub fn seat(&self, id: &str) -> Option<&Seat> {
        self.seats.iter().find(|s| s.id == id)
    }
    pub fn names(&self) -> Vec<String> {
        self.seats.iter().map(|s| s.name.clone()).collect()
    }
}
