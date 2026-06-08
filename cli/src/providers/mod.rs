//! Provider HTTP clients. One streaming entry point dispatches per provider;
//! request shapes, headers, SSE framing, and the reasoning-tier → effort knob
//! are ported from the desktop TypeScript SDK.

pub mod scan;
pub mod sse;

use crate::error::{Error, Result};
use crate::types::{ChatMessage, CompletionChunk, CompletionRequest, Provider, ReasoningTier, Role, Usage};
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

fn is_openai_reasoning(model: &str) -> bool {
    model.starts_with("gpt-5") || model.starts_with('o')
}

fn openai_effort(model: &str, tier: ReasoningTier) -> &'static str {
    match tier {
        ReasoningTier::Low => "low",
        ReasoningTier::Medium => "medium",
        ReasoningTier::High => {
            // xhigh only for the gpt-5 flagships; mini/nano speed variants and
            // the o-series take "high" (parity with the TS SDK).
            if model.starts_with("gpt-5") && !crate::catalog::is_speed_variant(model) {
                "xhigh"
            } else {
                "high"
            }
        }
    }
}

enum AntMode {
    Adaptive,
    Extended,
    None,
}

fn ant_profile(model: &str) -> (AntMode, bool) {
    // (mode, prohibits_sampling). The live API is authoritative and non-monotonic:
    // claude-opus-4-8 rejects `thinking.type.enabled` ("Use thinking.type.adaptive")
    // and rejects an explicit temperature — so 4.8, like 4.7, is adaptive-only.
    let m = model.to_ascii_lowercase();
    if m.contains("opus-4-8") || m.contains("opus-4-7") {
        (AntMode::Adaptive, true)
    } else if m.contains("opus-4-6") {
        (AntMode::Adaptive, false)
    } else if m.contains("minimax") {
        // MiniMax routes through this Anthropic-shaped branch and takes extended
        // thinking with an explicit `budget_tokens` (faithful to the app's
        // `minimax.ts`), NOT Claude's adaptive mode. Without this the reasoning
        // tier was silently dropped for Mary (every MiniMax id fell through to
        // `None`, so no thinking knob was ever sent).
        (AntMode::Extended, false)
    } else if m.contains("opus-4") || m.contains("sonnet-4") || m.contains("haiku-4") {
        (AntMode::Extended, false)
    } else {
        (AntMode::None, false)
    }
}

fn ant_thinking(model: &str, max_tokens: u32, tier: ReasoningTier) -> Option<Value> {
    let (mode, _) = ant_profile(model);
    match mode {
        AntMode::None => None,
        AntMode::Adaptive => {
            if tier == ReasoningTier::Low {
                None
            } else {
                Some(json!({ "type": "adaptive" }))
            }
        }
        AntMode::Extended => {
            if tier == ReasoningTier::Low {
                return None;
            }
            let cap: i64 = if tier == ReasoningTier::Medium { 4096 } else { 8192 };
            let budget = cap.min(max_tokens as i64 - 256);
            if budget >= 1024 {
                Some(json!({ "type": "enabled", "budget_tokens": budget }))
            } else {
                None
            }
        }
    }
}

fn google_budget(tier: ReasoningTier) -> i64 {
    match tier {
        ReasoningTier::Low => 0,
        ReasoningTier::Medium => 8192,
        ReasoningTier::High => 24576,
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

fn prepare(provider: Provider, base_url: &str, api_key: &str, req: &CompletionRequest) -> PreparedRequest {
    match provider {
        Provider::OpenAI => {
            let mut body = json!({
                "model": req.model,
                "input": non_system(&req.messages),
                "max_output_tokens": req.max_tokens,
                "stream": true,
            });
            if let Some(system) = &req.system {
                body["instructions"] = json!(system);
            }
            if is_openai_reasoning(&req.model) {
                body["reasoning"] = json!({ "effort": openai_effort(&req.model, req.tier), "summary": "auto" });
            } else {
                body["temperature"] = json!(req.temperature);
            }
            PreparedRequest {
                url: ensure_path(base_url, "v1", "responses"),
                headers: bearer(api_key),
                body,
            }
        }
        Provider::Anthropic | Provider::MiniMax => {
            let mut body = json!({
                "model": req.model,
                "messages": non_system(&req.messages),
                "max_tokens": req.max_tokens,
                "stream": true,
            });
            if let Some(system) = &req.system {
                body["system"] = json!(system);
            }
            let thinking = ant_thinking(&req.model, req.max_tokens, req.tier);
            let (_, prohibits) = ant_profile(&req.model);
            if let Some(t) = thinking {
                body["thinking"] = t;
            } else if !prohibits {
                body["temperature"] = json!(req.temperature.min(1.0));
            }
            let headers = vec![
                ("x-api-key".into(), api_key.to_string()),
                ("anthropic-version".into(), "2023-06-01".into()),
            ];
            // Anthropic: `<base>/v1/messages`. MiniMax base already ends with
            // `/anthropic`, so this yields `<base>/anthropic/v1/messages`.
            PreparedRequest { url: ensure_path(base_url, "v1", "messages"), headers, body }
        }
        Provider::Google => {
            let system = req.system.clone();
            let contents: Vec<Value> = req
                .messages
                .iter()
                .filter(|m| m.role != Role::System)
                .map(|m| {
                    let role = if m.role == Role::Assistant { "model" } else { "user" };
                    json!({ "role": role, "parts": [{ "text": m.content }] })
                })
                .collect();
            let mut gen = json!({
                "temperature": req.temperature,
                "maxOutputTokens": req.max_tokens,
            });
            if req.model.contains("pro") {
                let budget = google_budget(req.tier);
                if budget > 0 {
                    gen["thinkingConfig"] = json!({ "thinkingBudget": budget, "includeThoughts": true });
                }
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
        // OpenAI-compatible chat-completions providers.
        Provider::DeepSeek | Provider::Kimi | Provider::Qwen | Provider::Zhipu => {
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
                "temperature": req.temperature,
                "stream": true,
                "stream_options": { "include_usage": true },
            });
            if provider == Provider::Qwen {
                body["enable_thinking"] = json!(req.tier != ReasoningTier::Low);
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
        return Err(Error::Provider { status: status.as_u16(), body });
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
        for provider in [Provider::DeepSeek, Provider::Kimi, Provider::Qwen, Provider::Zhipu] {
            let p = prepare(provider, "https://example.com", "k", &req("chat"));
            let msgs = p.body["messages"].as_array().expect("messages array");
            assert_eq!(msgs[0]["role"], "system", "{provider:?} should lead with system");
            assert!(msgs[0]["content"].as_str().unwrap().contains("Douglas"));
        }
    }

    /// Regression: MiniMax must receive an extended-thinking budget at the high
    /// tier (its reasoning knob was previously dropped — `ant_profile` only knew
    /// Claude ids), and no temperature alongside the thinking block.
    #[test]
    fn minimax_high_tier_gets_extended_thinking_budget() {
        let mut r = req("MiniMax-M2.7-highspeed");
        r.max_tokens = 2048;
        r.tier = ReasoningTier::High;
        let p = prepare(Provider::MiniMax, "https://api.minimaxi.com/anthropic", "k", &r);
        assert_eq!(p.body["thinking"]["type"], "enabled");
        assert!(p.body["thinking"]["budget_tokens"].as_i64().unwrap() >= 1024);
        assert!(p.body.get("temperature").is_none());
    }

    /// At the low tier MiniMax skips extended thinking and keeps a temperature.
    #[test]
    fn minimax_low_tier_skips_thinking_keeps_temperature() {
        let mut r = req("MiniMax-M2.7-highspeed");
        r.tier = ReasoningTier::Low;
        let p = prepare(Provider::MiniMax, "https://api.minimaxi.com/anthropic", "k", &r);
        assert!(p.body.get("thinking").is_none());
        assert!(p.body.get("temperature").is_some());
    }

    /// OpenAI reasoning capture is restricted to incremental `.delta` events so
    /// the aggregate `.done` event can't re-emit the full summary text.
    #[test]
    fn openai_reasoning_only_captured_on_delta_events() {
        let mut usage = Usage::default();
        let delta = json!({ "type": "response.reasoning_summary_text.delta", "delta": "step " });
        let done = json!({ "type": "response.reasoning_summary_text.done", "text": "step step step" });
        let d = parse_event(Provider::OpenAI, &delta, &mut usage);
        let f = parse_event(Provider::OpenAI, &done, &mut usage);
        assert_eq!(d.thinking, "step ");
        assert!(f.thinking.is_empty(), "the aggregate .done event must not re-emit reasoning");
    }
}
