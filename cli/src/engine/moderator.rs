//! The Moderator — a non-streaming meta-agent that frames the debate, synthesizes
//! periodically, nudges toward resolution, and publishes a scored closing verdict.
//! Prompts are ported verbatim from the desktop app (`MODERATOR_SYSTEM_PROMPT` +
//! the `generateModeratorMessage` kind branches in Chat.tsx).

use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, ConclusionStatus, ModeratorConclusion,
    Provider, ReasoningTier,
};
use regex::Regex;
use std::collections::HashMap;

pub const MODERATOR_SYSTEM_PROMPT: &str = "You are the Moderator in a group chat with George, Cathy, Grace, Douglas, Kate, Quinn, Mary, and Zara.\n\n\
Your job: keep the discussion focused, fair, rigorous, and productive. Be direct and demanding — call out weak reasoning, vague claims, and circular arguments.\n\n\
Rules:\n\
- Speak briefly (1-4 sentences, max ~120 words).\n\
- Prefer plain text.\n\
- Ask at most ONE question.\n\
- Be a harsh, honest grader. A score of 7+ requires the group to have backed their claims with specifics, named what would change their minds, and resolved real disagreement with clear reasoning. Most discussions deserve 4-6. Give 8+ only if the group landed a concrete, well-supported recommendation. Discussions that stayed abstract, repetitive, or hand-wavy should score 3-5.\n\
- Do NOT impersonate any agent.";

/// Which provider/model/key the moderator speaks through.
pub struct ModeratorPick {
    pub provider: Provider,
    pub model: String,
    pub key: String,
    pub base_url: String,
}

impl ModeratorPick {
    /// Prefer Google (neutral + cheap, mirroring the app's extractor runtime),
    /// then a sensible fallback chain, among the providers that have a key.
    pub fn choose(
        config: &Config,
        available: &HashMap<Provider, Vec<DiscoveredModel>>,
        keys: &HashMap<Provider, String>,
    ) -> Option<ModeratorPick> {
        const ORDER: [Provider; 8] = [
            Provider::Google,
            Provider::Anthropic,
            Provider::OpenAI,
            Provider::DeepSeek,
            Provider::Kimi,
            Provider::Qwen,
            Provider::MiniMax,
            Provider::Zhipu,
        ];
        let provider = ORDER.into_iter().find(|p| keys.contains_key(p))?;
        let key = keys.get(&provider)?.clone();
        let empty = Vec::new();
        let avail = available.get(&provider).unwrap_or(&empty);
        // Moderator runs at the cheaper utility tier (like the app's utilityTier).
        let tier = config.utility_tier;
        let model =
            resolve_model(provider, tier, avail, config.selection(provider, tier).as_deref());
        Some(ModeratorPick { provider, model, key, base_url: config.base_url(provider) })
    }
}

/// The moderator intervention kind — selects the final-instruction prompt.
pub enum ModeratorKind {
    Opening,
    Synthesis { turn: u32 },
    Resolution { remaining: u32 },
    FinalSummary { turns: u32 },
}

impl ModeratorKind {
    fn instruction(&self) -> String {
        match self {
            ModeratorKind::Opening =>
                "Write the opening moderator message (1-2 sentences). Re-state the topic in plain language, set one measurable objective, and ask one concrete kickoff question.\n\n\
HARD CONSTRAINTS:\n\
- Do NOT mention, name, address, invite, or single out any individual agent.\n\
- Do NOT use second-person address to a single agent.\n\
- The question is directed at the council as a whole. Use neutral phrasing.".to_string(),
            ModeratorKind::Synthesis { turn } => format!(
                "Provide a short synthesis for turn {turn}:\n\
- One clause: what the group currently agrees on.\n\
- One clause: the sharpest unresolved disagreement.\n\
- Ask exactly one question that pushes the group toward a concrete answer or names what would actually settle this."
            ),
            ModeratorKind::Resolution { remaining } => format!(
                "The discussion is near the end (remaining turns: {remaining}).\n\
Write a concise moderator note that moves the council into the closing round:\n\
- tell them the next step is to wrap up instead of extending the debate,\n\
- instruct each agent to summarize their conclusion in a few sentences and end with a short goodbye,\n\
- do not leave the room with another open-ended question."
            ),
            ModeratorKind::FinalSummary { turns } => format!(
                "The closing round is complete after {turns} turns.\n\
Write the official moderator wrap-up in 4 short sentences:\n\
- The first sentence must start with exactly one of these labels: Consensus:, Majority with dissent:, or Unresolved:.\n\
- State the council's final recommendation or the blocking issue in plain language.\n\
- The second sentence must be exactly: Score: X/10. Replace X with an integer from 0 to 10.\n\
- The third sentence must explain in plain language why the discussion earned that score, including the main dissent or uncertainty.\n\
- End with the next action, test, or evidence that matters most.\n\
- Do NOT ask a question."
            ),
        }
    }
}

/// Run one moderator completion (collected, non-streaming). `recent` is the tail
/// of the transcript as `"Name: content"` lines.
pub async fn generate(
    http: &reqwest::Client,
    pick: &ModeratorPick,
    topic: &str,
    recent: &[String],
    kind: ModeratorKind,
) -> Option<String> {
    let mut messages = vec![ChatMessage::user(format!("Discussion topic: \"{topic}\""))];
    if !recent.is_empty() {
        messages.push(ChatMessage::user(format!("Recent discussion:\n{}", recent.join("\n"))));
    }
    messages.push(ChatMessage::user(kind.instruction()));

    let req = CompletionRequest {
        model: pick.model.clone(),
        system: Some(MODERATOR_SYSTEM_PROMPT.to_string()),
        messages,
        max_tokens: 1024,
        temperature: 0.7,
        tier: ReasoningTier::Low,
    };

    let mut out = String::new();
    {
        let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
        stream_completion(http, pick.provider, &pick.base_url, &pick.key, &req, &mut on_chunk)
            .await
            .ok()?;
    }
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}

/// Parse the moderator's final-summary text into a structured conclusion.
/// Mirrors the app's `parseModeratorConclusionFromText` (label + `Score: X/10`).
pub fn parse_conclusion(text: &str) -> Option<ModeratorConclusion> {
    // Eat an optional trailing period so it doesn't leak into the reason split.
    let score_re = Regex::new(r"(?i)Score:\s*(\d{1,2})\s*/\s*10\.?").ok()?;
    let caps = score_re.captures(text)?;
    let score: u8 = caps.get(1)?.as_str().parse::<u8>().ok()?.min(10);
    let score_match = caps.get(0)?;

    let status = detect_status(text);

    // Summary = text before the Score line, with the leading label stripped.
    let before = text[..score_match.start()].trim();
    let summary = strip_leading_label(before).trim().to_string();

    // After the score: reason (first sentence) then an optional next-step.
    let after = text[score_match.end()..].trim_start_matches(['.', ' ', '\n']).trim();
    let (reason, next) = split_reason_next(after);

    Some(ModeratorConclusion {
        status,
        summary: if summary.is_empty() { text.lines().next().unwrap_or("").to_string() } else { summary },
        score,
        reason,
        next,
    })
}

fn detect_status(text: &str) -> ConclusionStatus {
    let lower = text.trim_start().to_ascii_lowercase();
    if lower.starts_with("consensus") {
        ConclusionStatus::Consensus
    } else if lower.starts_with("majority") {
        ConclusionStatus::Majority
    } else {
        // No / "Unresolved" label → treat as unresolved.
        ConclusionStatus::Unresolved
    }
}

fn strip_leading_label(s: &str) -> &str {
    for label in ["Consensus:", "Majority with dissent:", "Majority:", "Unresolved:"] {
        if let Some(rest) = s.strip_prefix(label) {
            return rest.trim_start();
        }
        // case-insensitive fallback
        if s.to_ascii_lowercase().starts_with(&label.to_ascii_lowercase()) {
            return s[label.len()..].trim_start();
        }
    }
    s
}

/// Split trailing text into (reason, optional next-step) on the last sentence.
fn split_reason_next(s: &str) -> (String, Option<String>) {
    let s = s.trim();
    if s.is_empty() {
        return (String::new(), None);
    }
    // Sentence boundaries: split on ". " keeping it simple + robust.
    let sentences: Vec<&str> =
        s.split_inclusive(['.', '!', '?']).map(|x| x.trim()).filter(|x| !x.is_empty()).collect();
    match sentences.len() {
        0 => (s.to_string(), None),
        1 => (sentences[0].to_string(), None),
        _ => {
            let next = sentences.last().unwrap().to_string();
            let reason = sentences[..sentences.len() - 1].join(" ");
            (reason, Some(next))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_conclusion() {
        let text = "Majority with dissent: The council leans toward shipping the smaller release. \
                    Score: 6/10. The case was decent but evidence on rollback risk stayed thin. \
                    Next, run a staged rollout behind a flag.";
        let c = parse_conclusion(text).unwrap();
        assert_eq!(c.status, ConclusionStatus::Majority);
        assert_eq!(c.score, 6);
        assert!(c.summary.starts_with("The council leans"));
        assert!(c.reason.contains("evidence on rollback"));
        assert!(c.next.unwrap().contains("staged rollout"));
    }

    #[test]
    fn handles_consensus_and_clamps_score() {
        let c = parse_conclusion("Consensus: Yes. Score: 12/10. Strong reasoning.").unwrap();
        assert_eq!(c.status, ConclusionStatus::Consensus);
        assert_eq!(c.score, 10);
    }

    #[test]
    fn returns_none_without_a_score() {
        assert!(parse_conclusion("Unresolved: we never agreed.").is_none());
    }
}
