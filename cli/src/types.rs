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
