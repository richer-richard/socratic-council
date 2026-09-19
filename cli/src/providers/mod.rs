//! Provider HTTP clients. One streaming entry point dispatches per provider;
//! request shapes, headers, SSE framing, and the reasoning-tier → effort knob
//! are ported from the desktop TypeScript SDK.

pub mod scan;
pub mod sse;

use crate::error::{Error, Result};
use crate::types::{
    ChatMessage, CompletionChunk, CompletionRequest, Provider, ReasoningTier, Role, Usage,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sse::SseDecoder;

fn role_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
    }
}

pub(crate) fn ensure_path(base: &str, version: &str, endpoint: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with(&format!("/{version}")) {
        format!("{base}/{endpoint}")
    } else {
        format!("{base}/{version}/{endpoint}")
    }
}

pub(crate) fn google_v1beta(base: &str) -> String {
    let b = base.trim_end_matches('/');
    if let Some(idx) = b.find("/v1beta") {
        b[..idx + "/v1beta".len()].to_string()
    } else {
        format!("{b}/v1beta")
    }
}

use crate::catalog::{model_row, ApiFamily, ThinkingKnob};

/// `reasoning.effort` for the Responses API: the three tiers map onto the
/// documented low / medium / high; xhigh and max are never sent by default
/// (they exist for long-horizon agent work, not a council turn).
fn openai_effort(tier: ReasoningTier) -> &'static str {
    match tier {
        ReasoningTier::Low => "low",
        ReasoningTier::Medium => "medium",
        ReasoningTier::High => "high",
    }
}

/// The three-step effort ladder DeepSeek V4, Kimi K3 and GLM-5.3 share
/// (`low | high | max`): the fast tier turns thinking off or down, the
/// balanced tier is the providers' recommended `high`, the deep tier `max`.
fn ladder_effort(tier: ReasoningTier) -> &'static str {
    match tier {
        ReasoningTier::Low => "low",
        ReasoningTier::Medium => "high",
        ReasoningTier::High => "max",
    }
}

fn gemini_level(tier: ReasoningTier) -> &'static str {
    match tier {
        ReasoningTier::Low => "low",
        ReasoningTier::Medium => "medium",
        ReasoningTier::High => "high",
    }
}

fn gemini_budget(tier: ReasoningTier) -> i64 {
    match tier {
        ReasoningTier::Low => 0,
        ReasoningTier::Medium => 8192,
        ReasoningTier::High => 24576,
    }
}

/// The `thinking` block for the Messages API (Claude and MiniMax), or `None`
/// when the block must be omitted. Returns `(block, thinking_is_on)`.
fn messages_thinking(
    knob: ThinkingKnob,
    max_tokens: u32,
    tier: ReasoningTier,
) -> (Option<Value>, bool) {
    match knob {
        ThinkingKnob::AnthropicAdaptive {
            default_on,
            always_on,
        } => {
            if tier == ReasoningTier::Low {
                if always_on {
                    // Fable cannot be switched off; it is throttled with effort=low instead.
                    (None, true)
                } else if default_on {
                    // Opus 5 / Sonnet 5 think unless told not to.
                    (Some(json!({ "type": "disabled" })), false)
                } else {
                    // 4.6 / 4.7 / 4.8 are off until asked.
                    (None, false)
                }
            } else {
                // `display: summarized` is what makes thinking text stream at all —
                // the 4.7+/5.x default is `omitted` (empty thinking blocks).
                (
                    Some(json!({ "type": "adaptive", "display": "summarized" })),
                    true,
                )
            }
        }
        ThinkingKnob::AnthropicExtended => {
            if tier == ReasoningTier::Low {
                return (None, false);
            }
            let cap: i64 = if tier == ReasoningTier::Medium {
                4096
            } else {
                8192
            };
            let budget = cap.min(max_tokens as i64 - 256);
            if budget >= 1024 {
                (
                    Some(json!({ "type": "enabled", "budget_tokens": budget })),
                    true,
                )
            } else {
                (None, false)
            }
        }
        // MiniMax-M3: `adaptive` switches interleaved thinking on; omitting the
        // block leaves it off (the fast tier).
        ThinkingKnob::MiniMaxAdaptive => {
            if tier == ReasoningTier::Low {
                (None, false)
            } else {
                (Some(json!({ "type": "adaptive" })), true)
            }
        }
        // M2.x cannot be turned off: send nothing, it thinks regardless.
        ThinkingKnob::MiniMaxAlwaysOn => (None, true),
        _ => (None, false),
    }
}

struct PreparedRequest {
    url: String,
    headers: Vec<(String, String)>,
    body: Value,
}

fn non_system(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| m.role != Role::System)
        .map(|m| json!({ "role": role_str(m.role), "content": m.content }))
        .collect()
}

fn bearer(api_key: &str) -> Vec<(String, String)> {
    vec![("Authorization".into(), format!("Bearer {api_key}"))]
}

fn prepare(
    provider: Provider,
    base_url: &str,
    api_key: &str,
    req: &CompletionRequest,
) -> PreparedRequest {
    let row = model_row(provider, &req.model);
    let contract = row.contract;
    match contract.api {
        ApiFamily::Responses => {
            let mut body = json!({
                "model": req.model,
                "input": non_system(&req.messages),
                "max_output_tokens": req.max_tokens,
                "stream": true,
            });
            if let Some(system) = &req.system {
                body["instructions"] = json!(system);
            }
            match contract.thinking {
                ThinkingKnob::OpenAiEffort { .. } => {
                    body["reasoning"] =
                        json!({ "effort": openai_effort(req.tier), "summary": "auto" });
                }
                _ => {
                    if contract.sampling {
                        body["temperature"] = json!(req.temperature);
                    }
                }
            }
            PreparedRequest {
                url: ensure_path(base_url, "v1", "responses"),
                headers: bearer(api_key),
                body,
            }
        }
        ApiFamily::Messages => {
            let mut body = json!({
                "model": req.model,
                "messages": non_system(&req.messages),
                "max_tokens": req.max_tokens,
                "stream": true,
            });
            if let Some(system) = &req.system {
                body["system"] = json!(system);
            }
            let (thinking, thinking_on) =
                messages_thinking(contract.thinking, req.max_tokens, req.tier);
            if let Some(t) = thinking {
                body["thinking"] = t;
            }
            // Effort (Claude 4.6+ / 5.x adaptive models): low/medium are explicit,
            // high is the API default.
            if let ThinkingKnob::AnthropicAdaptive { .. } = contract.thinking {
                match req.tier {
                    ReasoningTier::Low => body["output_config"] = json!({ "effort": "low" }),
                    ReasoningTier::Medium => body["output_config"] = json!({ "effort": "medium" }),
                    ReasoningTier::High => {}
                }
            }
            if !thinking_on && contract.sampling {
                body["temperature"] = json!(req.temperature.min(1.0));
            }
            let headers = vec![
                ("x-api-key".into(), api_key.to_string()),
                ("anthropic-version".into(), "2023-06-01".into()),
            ];
            // Anthropic: `<base>/v1/messages`. MiniMax base already ends with
            // `/anthropic`, so this yields `<base>/anthropic/v1/messages`.
            PreparedRequest {
                url: ensure_path(base_url, "v1", "messages"),
                headers,
                body,
            }
        }
        ApiFamily::Gemini => {
            let system = req.system.clone();
            let contents: Vec<Value> = req
                .messages
                .iter()
                .filter(|m| m.role != Role::System)
                .map(|m| {
                    let role = if m.role == Role::Assistant {
                        "model"
                    } else {
                        "user"
                    };
                    json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            let mut gen = json!({
                "temperature": req.temperature,
                "maxOutputTokens": req.max_tokens,
            });
            match contract.thinking {
                // Gemini 3.x and 2.5 Pro think dynamically; steer with thinking_level
                // (low|medium|high — never "minimal", which the Pro and newer Flash
                // models reject) and ask for thought summaries (`part.thought`).
                ThinkingKnob::GeminiLevel => {
                    gen["thinkingConfig"] =
                        json!({ "thinkingLevel": gemini_level(req.tier), "includeThoughts": true });
                }
                ThinkingKnob::GeminiBudget => {
                    let budget = gemini_budget(req.tier);
                    if budget > 0 {
                        gen["thinkingConfig"] =
                            json!({ "thinkingBudget": budget, "includeThoughts": true });
                    }
                }
                _ => {}
            }
            let mut body = json!({ "contents": contents, "generationConfig": gen });
            if let Some(system) = system {
                body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            }
            let url = format!(
                "{}/models/{}:streamGenerateContent?alt=sse",
                google_v1beta(base_url),
                req.model
            );
            PreparedRequest {
                url,
                headers: vec![("x-goog-api-key".into(), api_key.to_string())],
                body,
            }
        }
        ApiFamily::ChatCompletions => {
            // Carry the system prompt as the leading `system` message — these
            // providers have no separate field for it. Without this the agent
            // never learns its role/constraints and rambles or invents.
            let mut messages: Vec<Value> = Vec::new();
            if let Some(system) = &req.system {
                if !system.trim().is_empty() {
                    messages.push(json!({ "role": "system", "content": system }));
                }
            }
            messages.extend(
                req.messages
                    .iter()
                    .filter(|m| m.role != Role::System)
                    .map(|m| json!({ "role": role_str(m.role), "content": m.content })),
            );
            let mut body = json!({
                "model": req.model,
                "messages": messages,
                "max_tokens": req.max_tokens,
                "stream": true,
                "stream_options": { "include_usage": true },
            });
            let low = req.tier == ReasoningTier::Low;
            let mut thinking_on = false;
            match contract.thinking {
                ThinkingKnob::QwenEnable => {
                    body["enable_thinking"] = json!(!low);
                    thinking_on = !low;
                }
                // DeepSeek V4 merges chat/reasoner into one id with a per-request
                // switch, plus a low|high|max effort ladder while thinking.
                ThinkingKnob::DeepSeekType => {
                    body["thinking"] = json!({ "type": if low { "disabled" } else { "enabled" } });
                    if !low {
                        body["reasoning_effort"] = json!(ladder_effort(req.tier));
                    }
                    thinking_on = !low;
                }
                // Kimi K3 always reasons and takes top-level reasoning_effort
                // (low|high|max, default max) and must NOT get a `thinking` object.
                ThinkingKnob::KimiEffort => {
                    body["reasoning_effort"] = json!(ladder_effort(req.tier));
                    thinking_on = true;
                }
                ThinkingKnob::KimiType => {
                    body["thinking"] = json!({ "type": if low { "disabled" } else { "enabled" } });
                    thinking_on = !low;
                }
                // K2.7-code is always on (sending "disabled" is a 400): send nothing.
                ThinkingKnob::KimiAlwaysOn => thinking_on = true,
                // GLM-5.3 family: always on, depth via reasoning_effort.
                ThinkingKnob::GlmEffort => {
                    body["thinking"] = json!({ "type": "enabled" });
                    body["reasoning_effort"] = json!(ladder_effort(req.tier));
                    thinking_on = true;
                }
                ThinkingKnob::GlmType { forced } => {
                    let on = !low || forced;
                    body["thinking"] = json!({ "type": if on { "enabled" } else { "disabled" } });
                    thinking_on = on;
                }
                _ => {}
            }
            // The reasoning models either ignore or reject sampling parameters
            // while thinking; only send a temperature when the contract allows it.
            if contract.sampling
                && (!thinking_on || contract_allows_temperature_while_thinking(provider))
            {
                body["temperature"] = json!(req.temperature);
            }
            let (version, base_seg) = match provider {
                Provider::Qwen => ("v1", "chat/completions"),
                Provider::Zhipu => ("v4", "chat/completions"),
                _ => ("v1", "chat/completions"),
            };
            PreparedRequest {
                url: ensure_path(base_url, version, base_seg),
                headers: bearer(api_key),
                body,
            }
        }
    }
}

/// Qwen and Zhipu document temperature as valid alongside thinking; DeepSeek
/// ignores it and Kimi rejects anything but its fixed value, and both of
/// those already have `sampling: false` on their rows.
fn contract_allows_temperature_while_thinking(provider: Provider) -> bool {
    matches!(provider, Provider::Qwen | Provider::Zhipu)
}

fn num(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}

/// Parse one SSE JSON payload into a chunk, updating `usage` in place.
fn parse_event(provider: Provider, value: &Value, usage: &mut Usage) -> CompletionChunk {
    let mut chunk = CompletionChunk::default();
    match provider {
        Provider::OpenAI => {
            let t = value["type"].as_str().unwrap_or("");
            if t == "response.output_text.delta" {
                chunk.content = value["delta"].as_str().unwrap_or("").to_string();
            } else if t.ends_with(".delta") && (t.contains("reasoning") || t.contains("summary")) {
                // Capture ONLY the incremental reasoning deltas. The Responses
                // API also emits aggregate `.done`/`.added` events carrying the
                // FULL summary text; matching those re-emitted the whole trace
                // 2-3× into the thinking panel.
                chunk.thinking = value["delta"].as_str().unwrap_or("").to_string();
            } else if t == "response.completed" {
                let u = &value["response"]["usage"];
                usage.input = num(&u["input_tokens"]);
                usage.output = num(&u["output_tokens"]);
                usage.reasoning = num(&u["output_tokens_details"]["reasoning_tokens"]);
            }
        }
        Provider::Anthropic | Provider::MiniMax => {
            let t = value["type"].as_str().unwrap_or("");
            if t == "content_block_delta" {
                let d = &value["delta"];
                if let Some(tk) = d["thinking"].as_str() {
                    chunk.thinking = tk.to_string();
                } else if let Some(tx) = d["text"].as_str() {
                    chunk.content = tx.to_string();
                }
            } else if t == "message_delta" {
                if let Some(o) = value["usage"]["output_tokens"].as_u64() {
                    usage.output = o;
                }
                // MiniMax's Anthropic-compatible stream reports input_tokens on
                // message_delta (Anthropic puts it on message_start); take it
                // wherever it appears so Mary isn't billed as 0 input.
                if let Some(i) = value["usage"]["input_tokens"].as_u64() {
                    if i > 0 {
                        usage.input = i;
                    }
                }
            } else if t == "message_start" {
                let u = &value["message"]["usage"];
                usage.input = num(&u["input_tokens"]);
            }
        }
        Provider::Google => {
            if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    if let Some(tx) = p["text"].as_str() {
                        if p["thought"].as_bool() == Some(true) {
                            chunk.thinking.push_str(tx);
                        } else {
                            chunk.content.push_str(tx);
                        }
                    }
                }
            }
            let u = &value["usageMetadata"];
            if let Some(i) = u["promptTokenCount"].as_u64() {
                usage.input = i;
            }
            if let Some(o) = u["candidatesTokenCount"].as_u64() {
                usage.output = o;
            }
        }
        Provider::DeepSeek | Provider::Kimi | Provider::Qwen | Provider::Zhipu => {
            let delta = &value["choices"][0]["delta"];
            if let Some(c) = delta["content"].as_str() {
                chunk.content = c.to_string();
            }
            if let Some(r) = delta["reasoning_content"].as_str() {
                chunk.thinking = r.to_string();
            }
            let u = &value["usage"];
            if u.is_object() {
                usage.input = num(&u["prompt_tokens"]);
                usage.output = num(&u["completion_tokens"]);
            }
        }
    }
    chunk
}

/// Stream a completion, invoking `on_chunk` for each token, returning usage.
/// `on_chunk` is synchronous (the orchestrator forwards into an unbounded
/// channel), which keeps this borrow-friendly and avoids extra tasks.
pub async fn stream_completion(
    http: &reqwest::Client,
    provider: Provider,
    base_url: &str,
    api_key: &str,
    req: &CompletionRequest,
    on_chunk: &mut (dyn FnMut(&CompletionChunk) + Send),
) -> Result<Usage> {
    let prepared = prepare(provider, base_url, api_key, req);
    let mut builder = http.post(&prepared.url).json(&prepared.body);
    for (name, value) in &prepared.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }

    let resp = builder.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(Error::Provider {
            status: status.as_u16(),
            body,
        });
    }

    let mut stream = resp.bytes_stream();
    let mut decoder = SseDecoder::new();
    let mut usage = Usage::default();
    // Carry incomplete UTF-8 sequences across network chunks so a multibyte
    // character (CJK/emoji) split on a chunk boundary isn't corrupted.
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let bytes = item?;
        byte_buf.extend_from_slice(&bytes);
        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 {
            continue;
        }
        // The prefix is valid UTF-8 by construction.
        let text: String = String::from_utf8_lossy(&byte_buf[..valid_len]).into_owned();
        byte_buf.drain(..valid_len);

        for payload in decoder.push(&text) {
            if payload == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                // `SC_STREAM_DEBUG=1` prints only event *types* (never content)
                // — enough to see which reasoning/summary events a provider emits.
                if std::env::var_os("SC_STREAM_DEBUG").is_some() {
                    if let Some(t) = value["type"].as_str() {
                        eprintln!("[stream:{}] {t}", provider.slug());
                    }
                }
                let chunk = parse_event(provider, &value, &mut usage);
                if !chunk.content.is_empty() || !chunk.thinking.is_empty() {
                    on_chunk(&chunk);
                }
            }
        }
    }

    Ok(usage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::CompletionRequest;

    fn req(model: &str) -> CompletionRequest {
        CompletionRequest {
            model: model.to_string(),
            system: Some("You are Douglas in the Socratic Council.".into()),
            messages: vec![ChatMessage::user("debate this")],
            max_tokens: 256,
            temperature: 1.0,
            tier: ReasoningTier::High,
        }
    }

    /// Regression: every provider must actually transmit the system prompt.
    /// The OpenAI-compatible providers previously dropped it entirely.
    #[test]
    fn system_prompt_is_sent_to_every_provider() {
        let needle = "Douglas in the Socratic Council";
        for provider in Provider::ALL {
            let p = prepare(provider, "https://example.com", "k", &req("some-model"));
            let body = serde_json::to_string(&p.body).unwrap();
            assert!(
                body.contains(needle),
                "{provider:?} request is missing the system prompt: {body}"
            );
        }
    }

    /// The OpenAI-compatible providers must carry it as a leading system message.
    #[test]
    fn openai_compatible_prepends_system_message() {
        for provider in [
            Provider::DeepSeek,
            Provider::Kimi,
            Provider::Qwen,
            Provider::Zhipu,
        ] {
            let p = prepare(provider, "https://example.com", "k", &req("chat"));
            let msgs = p.body["messages"].as_array().expect("messages array");
            assert_eq!(
                msgs[0]["role"], "system",
                "{provider:?} should lead with system"
            );
            assert!(msgs[0]["content"].as_str().unwrap().contains("Douglas"));
        }
    }

    /// MiniMax-M3 (docs: `thinking.type: adaptive` switches thinking on,
    /// omitting the block leaves it off) — no temperature while thinking.
    #[test]
    fn minimax_m3_adaptive_at_high_off_at_low() {
        let mut r = req("MiniMax-M3");
        r.tier = ReasoningTier::High;
        let p = prepare(
            Provider::MiniMax,
            "https://api.minimaxi.com/anthropic",
            "k",
            &r,
        );
        assert_eq!(p.body["thinking"]["type"], "adaptive");
        assert!(p.body.get("temperature").is_none());
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::MiniMax,
            "https://api.minimaxi.com/anthropic",
            "k",
            &r,
        );
        assert!(p.body.get("thinking").is_none());
        assert!(p.body.get("temperature").is_some());
        assert!(p.url.ends_with("/anthropic/v1/messages"));
    }

    /// MiniMax M2.x cannot turn thinking off (docs): no thinking block is sent
    /// at any tier and no temperature rides along.
    #[test]
    fn minimax_m2_is_always_on_and_never_gets_a_thinking_block() {
        for tier in ReasoningTier::ALL {
            let mut r = req("MiniMax-M2.7-highspeed");
            r.tier = tier;
            let p = prepare(
                Provider::MiniMax,
                "https://api.minimaxi.com/anthropic",
                "k",
                &r,
            );
            assert!(p.body.get("thinking").is_none(), "{tier:?}");
            assert!(p.body.get("temperature").is_none(), "{tier:?}");
        }
    }

    // One test per thinking knob: the exact key each contract emits.

    #[test]
    fn knob_openai_effort_never_sends_temperature() {
        for (model, tier, effort) in [
            ("gpt-6-astra", ReasoningTier::High, "high"),
            ("gpt-5.6-luna", ReasoningTier::Medium, "medium"),
            ("gpt-5.5", ReasoningTier::Low, "low"),
        ] {
            let mut r = req(model);
            r.tier = tier;
            let p = prepare(Provider::OpenAI, "https://api.openai.com", "k", &r);
            assert_eq!(p.body["reasoning"]["effort"], effort, "{model}");
            assert!(p.body.get("temperature").is_none(), "{model}");
            assert!(p.body["instructions"].as_str().unwrap().contains("Douglas"));
        }
    }

    #[test]
    fn knob_anthropic_adaptive_per_generation() {
        // Fable: always on; low tier = effort low, no thinking block.
        let mut r = req("claude-fable-5-1");
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert!(p.body.get("thinking").is_none());
        assert_eq!(p.body["output_config"]["effort"], "low");
        assert!(p.body.get("temperature").is_none());
        // Opus 5: thinks by default, so the low tier says `disabled` explicitly.
        let mut r = req("claude-opus-5");
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "disabled");
        assert!(p.body.get("temperature").is_none());
        // Opus 4.8: adaptive-only, off until asked, never a temperature.
        let mut r = req("claude-opus-4-8");
        r.tier = ReasoningTier::High;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "adaptive");
        assert_eq!(p.body["thinking"]["display"], "summarized");
        assert!(p.body.get("output_config").is_none());
        assert!(p.body.get("temperature").is_none());
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert!(p.body.get("thinking").is_none());
        assert!(p.body.get("temperature").is_none());
    }

    #[test]
    fn knob_anthropic_extended_budget_and_temperature_when_off() {
        let mut r = req("claude-haiku-4-5-20251001");
        r.max_tokens = 4096;
        r.tier = ReasoningTier::High;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "enabled");
        assert!(p.body["thinking"]["budget_tokens"].as_i64().unwrap() >= 1024);
        assert!(p.body.get("temperature").is_none());
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert!(p.body.get("thinking").is_none());
        assert!(p.body.get("temperature").is_some());
    }

    #[test]
    fn knob_gemini_level_and_budget() {
        let r = req("gemini-3.1-pro-preview");
        let p = prepare(
            Provider::Google,
            "https://generativelanguage.googleapis.com",
            "k",
            &r,
        );
        assert_eq!(
            p.body["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
        assert_eq!(
            p.body["generationConfig"]["thinkingConfig"]["includeThoughts"],
            true
        );
        let mut r = req("gemini-2.5-flash");
        r.tier = ReasoningTier::Medium;
        let p = prepare(
            Provider::Google,
            "https://generativelanguage.googleapis.com",
            "k",
            &r,
        );
        assert_eq!(
            p.body["generationConfig"]["thinkingConfig"]["thinkingBudget"],
            8192
        );
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::Google,
            "https://generativelanguage.googleapis.com",
            "k",
            &r,
        );
        assert!(p.body["generationConfig"].get("thinkingConfig").is_none());
    }

    #[test]
    fn knob_deepseek_type_with_effort_ladder() {
        let mut r = req("deepseek-v4-pro");
        r.tier = ReasoningTier::Medium;
        let p = prepare(Provider::DeepSeek, "https://api.deepseek.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "enabled");
        assert_eq!(p.body["reasoning_effort"], "high");
        assert!(p.body.get("temperature").is_none());
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::DeepSeek, "https://api.deepseek.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "disabled");
        assert!(p.body.get("reasoning_effort").is_none());
    }

    #[test]
    fn knob_kimi_effort_sends_reasoning_effort_and_no_thinking_object() {
        let r = req("kimi-k3");
        let p = prepare(Provider::Kimi, "https://api.moonshot.cn", "k", &r);
        assert_eq!(p.body["reasoning_effort"], "max");
        assert!(p.body.get("thinking").is_none());
        assert!(p.body.get("temperature").is_none());
    }

    #[test]
    fn knob_kimi_always_on_and_type() {
        let mut r = req("kimi-k2.7-code");
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Kimi, "https://api.moonshot.cn", "k", &r);
        assert!(
            p.body.get("thinking").is_none(),
            "k2.7-code must never receive disabled"
        );
        let p = prepare(Provider::Kimi, "https://api.moonshot.cn", "k", &r);
        assert!(p.body.get("reasoning_effort").is_none());
        let mut r = req("kimi-k2.6");
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::Kimi, "https://api.moonshot.cn", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "disabled");
    }

    #[test]
    fn knob_qwen_enable_thinking_keeps_temperature() {
        let mut r = req("qwen3.8-max");
        r.tier = ReasoningTier::High;
        let p = prepare(
            Provider::Qwen,
            "https://dashscope.aliyuncs.com/compatible-mode",
            "k",
            &r,
        );
        assert_eq!(p.body["enable_thinking"], true);
        assert!(p.body.get("temperature").is_some());
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::Qwen,
            "https://dashscope.aliyuncs.com/compatible-mode",
            "k",
            &r,
        );
        assert_eq!(p.body["enable_thinking"], false);
    }

    #[test]
    fn knob_glm_effort_and_type() {
        let mut r = req("glm-5.3");
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::Zhipu,
            "https://open.bigmodel.cn/api/paas",
            "k",
            &r,
        );
        assert_eq!(
            p.body["thinking"]["type"], "enabled",
            "GLM-5.3 cannot be disabled"
        );
        assert_eq!(p.body["reasoning_effort"], "low");
        assert!(p.url.ends_with("/v4/chat/completions"));
        let mut r = req("glm-5.2");
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::Zhipu,
            "https://open.bigmodel.cn/api/paas",
            "k",
            &r,
        );
        assert_eq!(p.body["thinking"]["type"], "disabled");
        assert!(p.body.get("reasoning_effort").is_none());
        let mut r = req("glm-4.7");
        r.tier = ReasoningTier::Low;
        let p = prepare(
            Provider::Zhipu,
            "https://open.bigmodel.cn/api/paas",
            "k",
            &r,
        );
        assert_eq!(
            p.body["thinking"]["type"], "enabled",
            "GLM-4.7 is forced on"
        );
    }

    /// An id the table does not know inherits its family's knob.
    #[test]
    fn unknown_ids_follow_their_family() {
        let r = req("gpt-99-hypothetical");
        let p = prepare(Provider::OpenAI, "https://api.openai.com", "k", &r);
        assert_eq!(p.body["reasoning"]["effort"], "high");
        let r = req("kimi-k3-preview-2099");
        let p = prepare(Provider::Kimi, "https://api.moonshot.cn", "k", &r);
        assert_eq!(p.body["reasoning_effort"], "max");
        let r = req("claude-opus-4-8-20990101");
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "adaptive");
    }

    /// OpenAI reasoning capture is restricted to incremental `.delta` events so
    /// the aggregate `.done` event can't re-emit the full summary text.
    #[test]
    fn openai_reasoning_only_captured_on_delta_events() {
        let mut usage = Usage::default();
        let delta = json!({ "type": "response.reasoning_summary_text.delta", "delta": "step " });
        let done =
            json!({ "type": "response.reasoning_summary_text.done", "text": "step step step" });
        let d = parse_event(Provider::OpenAI, &delta, &mut usage);
        let f = parse_event(Provider::OpenAI, &done, &mut usage);
        assert_eq!(d.thinking, "step ");
        assert!(
            f.thinking.is_empty(),
            "the aggregate .done event must not re-emit reasoning"
        );
    }
}
