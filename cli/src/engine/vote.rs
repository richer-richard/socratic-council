//! End-vote: when a council agent appends `@end()` to request the closing round,
//! every other agent casts a ballot. A simplified single round of the app's
//! two-round `EndVote` protocol — the motion passes on a simple majority.

use crate::providers::stream_completion;
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, ReasoningTier, Usage, VoteChoice,
};
use regex::Regex;

/// Majority threshold: `floor(n/2) + 1`.
pub fn threshold(total: usize) -> u32 {
    (total / 2 + 1) as u32
}

/// Build the ballot prompt for one voter (system = the voter's own prompt).
pub fn build_messages(
    topic: &str,
    recent: &[String],
    proposer: &str,
    total: usize,
) -> Vec<ChatMessage> {
    let thr = threshold(total);
    let instruction = format!(
        "{proposer} moved to end the session now. The other agents must vote.\n\
- The motion passes only if at least {thr} of {total} agents vote YES.\n\
- Vote your honest position. ABSTAIN only if you genuinely have no clear position.\n\
- Write 1-3 short sentences total.\n\
- Your first sentence must start EXACTLY with one of: Vote: YES, Vote: NO, or Vote: ABSTAIN.\n\
- If you vote NO, state one concrete reason the discussion should continue.\n\
- If you vote YES, briefly say why the room is ready to stop.\n\
- Do NOT ask a question."
    );
    let mut messages = vec![ChatMessage::user(format!("Discussion topic: \"{topic}\""))];
    if !recent.is_empty() {
        messages.push(ChatMessage::user(format!("Recent discussion:\n{}", recent.join("\n"))));
    }
    messages.push(ChatMessage::user(instruction));
    messages
}

/// A non-streaming ballot completion for one voter. Also returns the usage the
/// ballot cost (zero when the call failed).
#[allow(clippy::too_many_arguments)]
pub async fn cast(
    http: &reqwest::Client,
    provider: crate::types::Provider,
    base_url: &str,
    key: &str,
    model: &str,
    system: &str,
    topic: &str,
    recent: &[String],
    proposer: &str,
    total: usize,
    tier: ReasoningTier,
) -> (VoteChoice, String, Usage) {
    let req = CompletionRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        messages: build_messages(topic, recent, proposer, total),
        max_tokens: 512,
        temperature: 0.7,
        tier,
    };
    let mut out = String::new();
    let usage = {
        let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
        match stream_completion(http, provider, base_url, key, &req, &mut on_chunk).await {
            Ok(usage) => usage,
            Err(_) => {
                // A failed ballot abstains (and never blocks the motion).
                return (VoteChoice::Abstain, "(no response)".to_string(), Usage::default());
            }
        }
    };
    let (choice, reason) = parse_vote(&out);
    (choice, reason, usage)
}

/// Parse a ballot's visible text into `(choice, reason)`. Mirrors the app's
/// `parseVoteChoiceFromVisibleText`. No clear vote → abstain.
pub fn parse_vote(text: &str) -> (VoteChoice, String) {
    let re = Regex::new(r"(?i)\bVote:\s*(YES|NO|ABSTAIN)\b").unwrap();
    let choice = match re.captures(text).and_then(|c| c.get(1)) {
        Some(m) => match m.as_str().to_ascii_uppercase().as_str() {
            "YES" => VoteChoice::Yes,
            "NO" => VoteChoice::No,
            _ => VoteChoice::Abstain,
        },
        None => VoteChoice::Abstain,
    };
    // Reason = the visible text with the leading "Vote: X" prefix removed.
    let reason = re.replace(text, "").trim().to_string();
    let reason = reason.trim_start_matches(['.', ',', '-', ' ']).trim().to_string();
    (choice, reason)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thresholds() {
        assert_eq!(threshold(8), 5);
        assert_eq!(threshold(3), 2);
        assert_eq!(threshold(2), 2);
    }

    #[test]
    fn parses_votes() {
        let (c, r) = parse_vote("Vote: YES. The room has converged.");
        assert_eq!(c, VoteChoice::Yes);
        assert!(r.contains("converged"));
        assert_eq!(parse_vote("Vote: NO — more to discuss.").0, VoteChoice::No);
        assert_eq!(parse_vote("I have no strong view.").0, VoteChoice::Abstain);
    }
}
