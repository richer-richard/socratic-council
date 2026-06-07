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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningTier {
    Low,
    Medium,
    High,
}

impl ReasoningTier {
    pub const ALL: [ReasoningTier; 3] =
        [ReasoningTier::Low, ReasoningTier::Medium, ReasoningTier::High];

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

/// One labelled section of an agent's private canvas (scratchpad).
#[derive(Debug, Clone)]
pub struct CanvasSection {
    pub label: String,
    pub text: String,
}

/// Confidence band on a research finding (mirrors the app's high/medium/low).
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

/// One section of the deep-research report.
#[derive(Debug, Clone)]
pub struct ResearchSection {
    pub heading: String,
    pub body: String,
    pub confidence: Confidence,
}

/// A structured analytical report synthesized from the debate transcript.
#[derive(Debug, Clone)]
pub struct DeepResearchReport {
    pub title: String,
    pub abstract_text: String,
    pub confidence: Confidence,
    pub sections: Vec<ResearchSection>,
}

/// Optional draft → critique → revise pass after each council turn (off default).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Reflection {
    #[default]
    Off,
    Light,
    Deep,
}

impl std::str::FromStr for Reflection {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_ascii_lowercase().as_str() {
            "off" | "none" => Ok(Reflection::Off),
            "light" => Ok(Reflection::Light),
            "deep" => Ok(Reflection::Deep),
            other => Err(format!("unknown reflection mode: {other} (use off|light|deep)")),
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
}

/// One transcript message destined for a provider request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self { role: Role::System, content: content.into() }
    }
    pub fn user(content: impl Into<String>) -> Self {
        Self { role: Role::User, content: content.into() }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self { role: Role::Assistant, content: content.into() }
    }
}

/// Token usage reported by a completion.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub reasoning: u64,
}

/// One inner-circle council agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub provider: Provider,
    pub system_prompt: String,
    pub tier: ReasoningTier,
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
}

/// A streamed completion chunk.
#[derive(Debug, Clone, Default)]
pub struct CompletionChunk {
    pub content: String,
    pub thinking: String,
}

/// The Moderator's official closing verdict — mirrors the app's
/// `ModeratorConclusionSnapshot`. Parsed from the moderator's final-summary text.
#[derive(Debug, Clone)]
pub struct ModeratorConclusion {
    pub status: ConclusionStatus,
    pub summary: String,
    pub score: u8, // 0..=10
    pub reason: String,
    pub next: Option<String>,
}

/// Five 0-100 dimensions one agent scores a peer on.
#[derive(Debug, Clone, Copy, Default)]
pub struct PeerEvalScores {
    pub rigor: u8,
    pub evidence: u8,
    pub novelty: u8,
    pub civility: u8,
    pub on_topic: u8,
}

/// How an evaluator stands relative to the peer they reviewed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stance {
    Agree,
    Disagree,
    Mixed,
}

impl Stance {
    pub fn label(self) -> &'static str {
        match self {
            Stance::Agree => "agree",
            Stance::Disagree => "disagree",
            Stance::Mixed => "mixed",
        }
    }
    pub fn from_str_lenient(s: &str) -> Stance {
        match s.to_ascii_lowercase().as_str() {
            "agree" => Stance::Agree,
            "disagree" => Stance::Disagree,
            _ => Stance::Mixed,
        }
    }
}

/// One evaluator's review of one peer.
#[derive(Debug, Clone)]
pub struct PeerCritique {
    pub evaluator_name: String,
    pub target_id: String,
    pub scores: PeerEvalScores,
    pub overall: u8,
    pub stance: Stance,
    pub critique: String,
}

/// Aggregated standing for one reviewed agent.
#[derive(Debug, Clone)]
pub struct PeerEvalSummary {
    pub agent_id: String,
    pub name: String,
    pub avg: PeerEvalScores,
    pub overall: u8,
    pub rank: u32,
    pub reviews: u32,
    /// The sharpest (lowest-overall) critique received — the standout.
    pub standout: Option<String>,
}

/// A full peer-evaluation round, ready to render as a scorecard.
#[derive(Debug, Clone)]
pub struct PeerEvalRound {
    pub critiques: Vec<PeerCritique>,
    pub summaries: Vec<PeerEvalSummary>,
}

/// A council agent's ballot when someone moves to end the session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoteChoice {
    Yes,
    No,
    Abstain,
}

impl VoteChoice {
    pub fn label(self) -> &'static str {
        match self {
            VoteChoice::Yes => "YES",
            VoteChoice::No => "NO",
            VoteChoice::Abstain => "ABSTAIN",
        }
    }
}

/// Outcome label the moderator leads its verdict with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConclusionStatus {
    Consensus,
    Majority,
    Unresolved,
}

impl ConclusionStatus {
    pub fn label(self) -> &'static str {
        match self {
            ConclusionStatus::Consensus => "Consensus",
            ConclusionStatus::Majority => "Majority with dissent",
            ConclusionStatus::Unresolved => "Unresolved",
        }
    }
    /// The disclosure glyph shown in the conclusion card.
    pub fn glyph(self) -> &'static str {
        match self {
            ConclusionStatus::Consensus => "✓",
            ConclusionStatus::Majority => "≈",
            ConclusionStatus::Unresolved => "✕",
        }
    }
}
