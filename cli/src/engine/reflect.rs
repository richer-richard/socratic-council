//! Optional draft → critique → revise pass. Ported from
//! `packages/core/src/reflection.ts` (`buildRevisePrompt` + the rubrics). The
//! draft is internal — only the revised text is revealed to the council.

use crate::providers::stream_completion;
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, Provider, ReasoningTier, Reflection,
};

const LIGHT_RUBRIC: &str = "Tighten the draft without changing its core position. Remove filler, collapse repetition, make claims more specific, and address the latest point more directly.";

const DEEP_RUBRIC: &str = "Review the draft against this rubric before rewriting:\n\
1. Are your concrete claims supported by evidence or clear reasoning?\n\
2. Did you address the most recent point from another agent (not drift to a tangent)?\n\
3. Are you repeating yourself from earlier turns?\n\
4. Could anything be sharper — specific numbers, names, mechanisms?\n\
5. Is there a hidden assumption you should surface?\n\n\
For each \"no\" in items 1-4, fix it in the revised version. For item 5, state the assumption explicitly.";

/// Revise `draft` per the reflection rubric using the agent's own model. Returns
/// the revised text, or `None` to keep the original.
#[allow(clippy::too_many_arguments)]
pub async fn revise(
    http: &reqwest::Client,
    provider: Provider,
    base_url: &str,
    key: &str,
    model: &str,
    system: &str,
    situation: &[String],
    draft: &str,
    name: &str,
    mode: Reflection,
) -> Option<String> {
    let rubric = match mode {
        Reflection::Light => LIGHT_RUBRIC,
        Reflection::Deep => DEEP_RUBRIC,
        Reflection::Off => return None,
    };
    let user = format!(
        "SITUATION (what you are responding to):\n{situation}\n\n\
YOUR DRAFT (internal — the council has not seen this yet):\n{draft}\n\n\
TASK — {name}, produce a revised final version:\n{rubric}\n\n\
Write ONLY the revised final response that will be shown to the council. Do not include meta-commentary, rubric scoring, or headers.",
        situation = situation.join("\n"),
    );
    let req = CompletionRequest {
        model: model.to_string(),
        system: Some(system.to_string()),
        messages: vec![ChatMessage::user(user)],
        max_tokens: 2048,
        temperature: 0.7,
        // Low tier keeps the revise pass cheap (the app disables thinking here).
        tier: ReasoningTier::Low,
    };
    let mut out = String::new();
    {
        let mut on_chunk = |c: &CompletionChunk| out.push_str(&c.content);
        stream_completion(http, provider, base_url, key, &req, &mut on_chunk).await.ok()?;
    }
    let out = out.trim().to_string();
    (!out.is_empty()).then_some(out)
}
