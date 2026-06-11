//! The outer circle — eight silent advisors, one paired to each council
//! debater, who read the public record and slip a private tactical note to
//! their partner. A faithful port of the app's `useObserverCircle.ts`:
//! same roster, same system prompt, same 16-message context window, same
//! <80-word instruction and 500-char cap, same "latest unconsumed note"
//! delivery semantics. Advisors run on their partner's provider at the Low
//! reasoning tier (notes are short and tactical).

use crate::catalog::{resolve_model, DiscoveredModel};
use crate::config::Config;
use crate::providers::stream_completion;
use crate::types::{
    AdvisorNote, ChatMessage, CompletionChunk, CompletionRequest, Provider, ReasoningTier, Usage,
};
use std::collections::HashMap;

use super::Turn;

/// Most recent public turns an advisor reads (the app's MAX_OBSERVER_CONTEXT).
const MAX_OBSERVER_CONTEXT: usize = 16;
/// Safety cap on a note's length (the app slices at 500 chars).
const NOTE_CHAR_CAP: usize = 500;

/// One outer-circle advisor: (id, name, partner_id, partner_name, provider).
pub const OBSERVERS: [(&str, &str, &str, &str, Provider); 8] = [
    ("greta", "Greta", "george", "George", Provider::OpenAI),
    ("clara", "Clara", "cathy", "Cathy", Provider::Anthropic),
    ("gaia", "Gaia", "grace", "Grace", Provider::Google),
    ("dara", "Dara", "douglas", "Douglas", Provider::DeepSeek),
    ("kira", "Kira", "kate", "Kate", Provider::Kimi),
    ("quincy", "Quincy", "quinn", "Quinn", Provider::Qwen),
    ("mila", "Mila", "mary", "Mary", Provider::MiniMax),
    ("zoe", "Zoe", "zara", "Zara", Provider::Zhipu),
];

/// The advisor's system prompt — ported verbatim from the app.
pub fn observer_system_prompt(observer_name: &str, partner_name: &str) -> String {
    format!(
        "You are {observer_name}, the outer-circle partner of {partner_name} in the Socratic Council.\n\n\
You are a silent observer. You do NOT speak in the discussion.\n\
Your role is to send a brief private note to {partner_name} with tactical advice.\n\n\
In your note:\n\
- Identify one blind spot or weakness in {partner_name}'s recent arguments, OR suggest one specific counterpoint, question, or evidence they should raise.\n\
- Keep it under 80 words. Be direct and actionable.\n\
- Do NOT address other agents. Your note is private to {partner_name}.\n\
- Write only the note itself — no greeting, no sign-off.",
    )
}

/// Build the message list an advisor sees: topic (+ attachment summary), the
/// last public turns as plain "Speaker: content" user messages, then the
/// note instruction.
pub fn build_observer_messages(
    topic: &str,
    attachment_summary: &str,
    transcript: &[Turn],
    partner_name: &str,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();
    let mut opening = format!("Discussion topic: \"{topic}\"");
    if !attachment_summary.trim().is_empty() {
        opening.push_str("\n\n");
        opening.push_str(attachment_summary);
    }
    messages.push(ChatMessage::user(opening));

    let start = transcript.len().saturating_sub(MAX_OBSERVER_CONTEXT);
    for turn in &transcript[start..] {
        messages.push(ChatMessage::user(format!("{}: {}", turn.name, turn.content)));
    }

    messages.push(ChatMessage::user(format!(
        "Write a short private note (under 80 words) to {partner_name}. Focus on the most useful tactical advice right now."
    )));
    messages
}

/// One advisor's generated note plus the usage it cost.
pub struct ObserverOutcome {
    pub note: AdvisorNote,
    pub model: String,
    pub usage: Usage,
}

/// Run one full advisor pass: every advisor whose partner is in the debate and
/// whose provider has a key writes (or declines) a note, **concurrently**.
/// Failures are silent (an advisor with a flaky provider just stays quiet).
#[allow(clippy::too_many_arguments)]
pub async fn run_pass(
    http: &reqwest::Client,
    config: &Config,
    available: &HashMap<Provider, Vec<DiscoveredModel>>,
    keys: &HashMap<Provider, String>,
    active_partner_ids: &[String],
    topic: &str,
    attachment_summary: &str,
    transcript: &[Turn],
) -> Vec<ObserverOutcome> {
    let mut jobs = Vec::new();
    for (obs_id, obs_name, partner_id, partner_name, provider) in OBSERVERS {
        if !active_partner_ids.iter().any(|id| id == partner_id) {
            continue;
        }
        let Some(key) = keys.get(&provider) else { continue };
        let empty = Vec::new();
        let avail = available.get(&provider).unwrap_or(&empty);
        // Notes are short + tactical: the partner's model at the Low tier.
        let tier = ReasoningTier::Low;
        let model = resolve_model(provider, tier, avail, config.selection(provider, tier).as_deref());
        let req = CompletionRequest {
            model: model.clone(),
            system: Some(observer_system_prompt(obs_name, partner_name)),
            messages: build_observer_messages(topic, attachment_summary, transcript, partner_name),
            max_tokens: 256,
            temperature: 0.7,
            tier,
        };
        let base_url = config.base_url(provider);
        let key = key.clone();
        let http = http.clone();
        jobs.push(async move {
            let mut out = String::new();
            let usage = {
                let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
                stream_completion(&http, provider, &base_url, &key, &req, &mut on_chunk)
                    .await
                    .ok()?
            };
            let text: String = super::sanitize_terminal(out.trim()).chars().take(NOTE_CHAR_CAP).collect();
            if text.is_empty() {
                return None;
            }
            Some(ObserverOutcome {
                note: AdvisorNote {
                    observer_id: obs_id.to_string(),
                    observer_name: obs_name.to_string(),
                    partner_id: partner_id.to_string(),
                    partner_name: partner_name.to_string(),
                    text,
                },
                model,
                usage,
            })
        });
    }

    futures_util::future::join_all(jobs).await.into_iter().flatten().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roster_pairs_every_council_agent_on_its_own_provider() {
        let partner_ids: Vec<&str> = OBSERVERS.iter().map(|o| o.2).collect();
        assert_eq!(
            partner_ids,
            vec!["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"]
        );
        // Provider must match the partner's provider (same key, no extra setup).
        for (i, agent) in super::super::default_agents(ReasoningTier::High).iter().enumerate() {
            assert_eq!(OBSERVERS[i].4, agent.provider);
            assert_eq!(OBSERVERS[i].2, agent.id);
        }
    }

    #[test]
    fn system_prompt_carries_the_four_rules() {
        let p = observer_system_prompt("Greta", "George");
        assert!(p.contains("silent observer"));
        assert!(p.contains("under 80 words"));
        assert!(p.contains("private to George"));
        assert!(p.contains("no greeting, no sign-off"));
    }

    #[test]
    fn observer_context_is_windowed_and_instructed() {
        let transcript: Vec<Turn> = (0..40)
            .map(|i| Turn {
                agent_id: "george".into(),
                name: "George".into(),
                content: format!("point {i}"),
            })
            .collect();
        let msgs = build_observer_messages("topic", "", &transcript, "George");
        // opening + 16 windowed turns + final instruction
        assert_eq!(msgs.len(), 1 + MAX_OBSERVER_CONTEXT + 1);
        assert!(msgs[1].content.contains("point 24"));
        assert!(msgs.last().unwrap().content.contains("under 80 words"));

        // Attachment summary rides in the opening message.
        let msgs = build_observer_messages("topic", "Attached: notes.txt", &[], "George");
        assert!(msgs[0].content.contains("Attached: notes.txt"));
    }
}
