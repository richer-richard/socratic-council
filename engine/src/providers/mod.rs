//! Provider HTTP clients. One streaming entry point dispatches per provider;
//! request shapes, headers, SSE framing, and the reasoning-tier → effort knob
//! are ported from the desktop TypeScript SDK.

pub mod scan;
pub mod sse;

use crate::error::{Error, Result};
use crate::types::ThinkingBlock;
use crate::types::{
    ChatMessage, CompletionChunk, CompletionOutcome, CompletionRequest, Provider, ReasoningTier,
    Role, StopReason, ToolCall, Usage,
};
use futures_util::StreamExt;
use serde_json::{json, Value};
use sse::SseDecoder;

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

use crate::catalog::{api_family, model_row, ApiFamily, ThinkingKnob};

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

fn bearer(api_key: &str) -> Vec<(String, String)> {
    vec![("Authorization".into(), format!("Bearer {api_key}"))]
}

fn args_string(call: &ToolCall) -> String {
    serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into())
}

/// Responses API `input` items: text turns, echoed `function_call` items for
/// assistant tool requests, and `function_call_output` items for results.
fn responses_input(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages {
        match m.role {
            Role::System => {}
            Role::User => out.push(json!({ "role": "user", "content": m.content })),
            Role::Assistant => {
                if !m.content.is_empty() {
                    out.push(json!({ "role": "assistant", "content": m.content }));
                }
                for c in &m.tool_calls {
                    out.push(json!({
                        "type": "function_call",
                        "call_id": c.id,
                        "name": c.name,
                        "arguments": args_string(c),
                    }));
                }
            }
            Role::Tool => out.push(json!({
                "type": "function_call_output",
                "call_id": m.tool_call_id.clone().unwrap_or_default(),
                "output": m.content,
            })),
        }
    }
    out
}

/// Messages API turns: assistant `tool_use` blocks, and every run of tool
/// results folded into one user turn of `tool_result` blocks (the API
/// requires all results for a turn in the next user message).
fn messages_turns(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        match m.role {
            Role::System => {}
            Role::User => out.push(json!({ "role": "user", "content": m.content })),
            Role::Assistant => {
                if m.tool_calls.is_empty() {
                    out.push(json!({ "role": "assistant", "content": m.content }));
                } else {
                    let mut blocks = Vec::new();
                    // With thinking on, the API checks that the assistant turn
                    // carrying tool calls starts with the (signed) reasoning it
                    // produced; replay it verbatim.
                    for b in &m.thinking_blocks {
                        blocks.push(serde_json::to_value(b).unwrap_or_default());
                    }
                    if !m.content.trim().is_empty() {
                        blocks.push(json!({ "type": "text", "text": m.content }));
                    }
                    for c in &m.tool_calls {
                        blocks.push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments }));
                    }
                    out.push(json!({ "role": "assistant", "content": blocks }));
                }
            }
            Role::Tool => {
                let block = json!({
                    "type": "tool_result",
                    "tool_use_id": m.tool_call_id.clone().unwrap_or_default(),
                    "content": m.content,
                });
                let merged = match out.last_mut() {
                    Some(last)
                        if last["role"] == "user"
                            && last["content"].is_array()
                            && last["content"][0]["type"] == "tool_result" =>
                    {
                        last["content"].as_array_mut().unwrap().push(block.clone());
                        true
                    }
                    _ => false,
                };
                if !merged {
                    out.push(json!({ "role": "user", "content": [block] }));
                }
            }
        }
    }
    out
}

/// Gemini `contents`: model turns carry `functionCall` parts (with their
/// thought signatures), tool results become `functionResponse` parts in one
/// user turn per run of results.
fn gemini_contents(messages: &[ChatMessage]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        match m.role {
            Role::System => {}
            Role::User => out.push(json!({ "role": "user", "parts": [{ "text": m.content }] })),
            Role::Assistant => {
                let mut parts = Vec::new();
                if !m.content.trim().is_empty() || m.tool_calls.is_empty() {
                    parts.push(json!({ "text": m.content }));
                }
                for c in &m.tool_calls {
                    let mut part =
                        json!({ "functionCall": { "name": c.name, "args": c.arguments } });
                    if let Some(sig) = &c.signature {
                        part["thoughtSignature"] = json!(sig);
                    }
                    parts.push(part);
                }
                out.push(json!({ "role": "model", "parts": parts }));
            }
            Role::Tool => {
                let part = json!({
                    "functionResponse": {
                        "name": m.tool_name.clone().unwrap_or_default(),
                        "response": { "result": m.content },
                    }
                });
                let merged = match out.last_mut() {
                    Some(last)
                        if last["role"] == "user"
                            && last["parts"][0].get("functionResponse").is_some() =>
                    {
                        last["parts"].as_array_mut().unwrap().push(part.clone());
                        true
                    }
                    _ => false,
                };
                if !merged {
                    out.push(json!({ "role": "user", "parts": [part] }));
                }
            }
        }
    }
    out
}

/// chat/completions messages, system prompt first; assistant `tool_calls`
/// and `role: tool` results as OpenAI documents them.
fn chat_messages(system: Option<&str>, messages: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(system) = system {
        if !system.trim().is_empty() {
            out.push(json!({ "role": "system", "content": system }));
        }
    }
    for m in messages {
        match m.role {
            Role::System => {}
            Role::User => out.push(json!({ "role": "user", "content": m.content })),
            Role::Assistant => {
                let mut v = json!({ "role": "assistant", "content": m.content });
                if !m.tool_calls.is_empty() {
                    v["tool_calls"] = Value::Array(
                        m.tool_calls
                            .iter()
                            .map(|c| {
                                json!({
                                    "id": c.id,
                                    "type": "function",
                                    "function": { "name": c.name, "arguments": args_string(c) },
                                })
                            })
                            .collect(),
                    );
                }
                out.push(v);
            }
            Role::Tool => out.push(json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            })),
        }
    }
    out
}

fn prepare(
    provider: Provider,
    base_url: &str,
    api_key: &str,
    req: &CompletionRequest,
) -> PreparedRequest {
    let row = model_row(provider, &req.model);
    let contract = row.contract;
    let tools_on = contract.tools && !req.tools.is_empty();
    match contract.api {
        ApiFamily::Responses => {
            let mut body = json!({
                "model": req.model,
                "input": responses_input(&req.messages),
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
            if tools_on {
                body["tools"] = Value::Array(
                    req.tools
                        .iter()
                        .map(|t| {
                            json!({
                                "type": "function",
                                "name": t.name,
                                "description": t.description,
                                "parameters": t.parameters,
                                "strict": false,
                            })
                        })
                        .collect(),
                );
            }
            if let Some(key) = &req.cache_key {
                body["prompt_cache_key"] = json!(key);
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
                "messages": messages_turns(&req.messages),
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
            if tools_on {
                body["tools"] = Value::Array(
                    req.tools
                        .iter()
                        .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.parameters }))
                        .collect(),
                );
            }
            // Automatic prompt caching (Claude only): one top-level marker caches
            // everything up to the last cacheable block and moves forward as the
            // conversation grows. MiniMax's Anthropic-shaped endpoint does not
            // document the field, so it is not sent there.
            if req.cache_key.is_some() && provider == Provider::Anthropic {
                body["cache_control"] = json!({ "type": "ephemeral" });
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
            let mut body =
                json!({ "contents": gemini_contents(&req.messages), "generationConfig": gen });
            if let Some(system) = &req.system {
                body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
            }
            if tools_on {
                // Gemini takes an OpenAPI subset: `additionalProperties` is
                // rejected with a 400, so it is stripped from every level.
                let decls: Vec<Value> = req
                    .tools
                    .iter()
                    .map(|t| {
                        json!({
                            "name": t.name,
                            "description": t.description,
                            "parameters": gemini_schema(&t.parameters),
                        })
                    })
                    .collect();
                body["tools"] = json!([{ "functionDeclarations": decls }]);
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
            let mut body = json!({
                "model": req.model,
                "messages": chat_messages(req.system.as_deref(), &req.messages),
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
            if tools_on {
                body["tools"] = Value::Array(
                    req.tools
                        .iter()
                        .map(|t| {
                            json!({
                                "type": "function",
                                "function": { "name": t.name, "description": t.description, "parameters": t.parameters },
                            })
                        })
                        .collect(),
                );
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

/// A JSON schema with the keys Gemini's OpenAPI subset rejects removed.
fn gemini_schema(v: &Value) -> Value {
    match v {
        Value::Object(o) => Value::Object(
            o.iter()
                .filter(|(k, _)| k.as_str() != "additionalProperties")
                .map(|(k, val)| (k.clone(), gemini_schema(val)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.iter().map(gemini_schema).collect()),
        other => other.clone(),
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

/// Collects streamed tool calls (argument fragments arrive over many events,
/// keyed by the provider's index) and the stop reason.
#[derive(Debug, Default)]
pub struct ToolAccumulator {
    calls: Vec<PendingCall>,
    stop: Option<StopReason>,
    /// Reasoning blocks (Messages API) in stream order.
    thinking: Vec<PendingThinking>,
}

#[derive(Debug)]
struct PendingThinking {
    index: u64,
    block: ThinkingBlock,
}

#[derive(Debug, Default)]
struct PendingCall {
    index: u64,
    id: String,
    name: String,
    args: String,
    signature: Option<String>,
}

impl ToolAccumulator {
    fn open(&mut self, index: u64, id: &str, name: &str, args: &str) {
        if let Some(c) = self.calls.iter_mut().find(|c| c.index == index) {
            if !id.is_empty() {
                c.id = id.to_string();
            }
            if !name.is_empty() {
                c.name = name.to_string();
            }
            c.args.push_str(args);
            return;
        }
        self.calls.push(PendingCall {
            index,
            id: id.to_string(),
            name: name.to_string(),
            args: args.to_string(),
            signature: None,
        });
    }
    fn append(&mut self, index: u64, fragment: &str) {
        match self.calls.iter_mut().find(|c| c.index == index) {
            Some(c) => c.args.push_str(fragment),
            None => self.open(index, "", "", fragment),
        }
    }
    /// Replace the argument buffer with the provider's authoritative full text.
    fn set_args(&mut self, index: u64, full: &str) {
        if let Some(c) = self.calls.iter_mut().find(|c| c.index == index) {
            c.args = full.to_string();
        }
    }
    fn push_whole(&mut self, name: &str, args: Value, signature: Option<String>) {
        let index = self.calls.len() as u64;
        self.calls.push(PendingCall {
            index,
            id: format!("call-{}", index + 1),
            name: name.to_string(),
            args: args.to_string(),
            signature,
        });
    }
    pub fn has_calls(&self) -> bool {
        !self.calls.is_empty()
    }
    /// A `thinking` block opened at `index`; its text and signature stream in.
    fn open_thinking(&mut self, index: u64) {
        if !self.thinking.iter().any(|t| t.index == index) {
            self.thinking.push(PendingThinking {
                index,
                block: ThinkingBlock::Thinking {
                    thinking: String::new(),
                    signature: String::new(),
                },
            });
        }
    }
    fn push_redacted(&mut self, index: u64, data: &str) {
        self.thinking.push(PendingThinking {
            index,
            block: ThinkingBlock::RedactedThinking {
                data: data.to_string(),
            },
        });
    }
    fn append_thinking(&mut self, index: u64, text: &str) {
        if let Some(PendingThinking {
            block: ThinkingBlock::Thinking { thinking, .. },
            ..
        }) = self.thinking.iter_mut().find(|t| t.index == index)
        {
            thinking.push_str(text);
        }
    }
    fn append_signature(&mut self, index: u64, sig: &str) {
        if let Some(PendingThinking {
            block: ThinkingBlock::Thinking { signature, .. },
            ..
        }) = self.thinking.iter_mut().find(|t| t.index == index)
        {
            signature.push_str(sig);
        }
    }
    /// The reasoning blocks the provider signed, in stream order. An unsigned
    /// block cannot be replayed (the API rejects it), so it is dropped.
    pub fn thinking_blocks(&self) -> Vec<ThinkingBlock> {
        let mut blocks: Vec<&PendingThinking> = self.thinking.iter().collect();
        blocks.sort_by_key(|t| t.index);
        blocks
            .into_iter()
            .filter(|t| match &t.block {
                ThinkingBlock::Thinking { signature, .. } => !signature.is_empty(),
                ThinkingBlock::RedactedThinking { .. } => true,
            })
            .map(|t| t.block.clone())
            .collect()
    }
    /// The finished calls; malformed argument text is kept under `_raw` so
    /// the tool layer can report it instead of guessing.
    pub fn finish(self) -> (Vec<ToolCall>, StopReason) {
        // A provider may report a plain stop even though it emitted calls
        // (Gemini finishes with STOP): the calls decide.
        let stop = match self.stop {
            Some(StopReason::MaxTokens) => StopReason::MaxTokens,
            _ if !self.calls.is_empty() => StopReason::ToolUse,
            Some(s) => s,
            None => StopReason::EndTurn,
        };
        let calls = self
            .calls
            .into_iter()
            .filter(|c| !c.name.is_empty())
            .map(|c| {
                let arguments = if c.args.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str::<Value>(&c.args)
                        .ok()
                        .filter(|v| v.is_object())
                        .unwrap_or_else(|| json!({ "_raw": c.args }))
                };
                ToolCall {
                    id: if c.id.is_empty() {
                        format!("call-{}", c.index + 1)
                    } else {
                        c.id
                    },
                    name: c.name,
                    arguments,
                    signature: c.signature,
                }
            })
            .collect();
        (calls, stop)
    }
}

/// Parse one SSE JSON payload into a chunk, updating `usage` and the tool
/// accumulator in place.
fn parse_event(
    provider: Provider,
    value: &Value,
    usage: &mut Usage,
    acc: &mut ToolAccumulator,
) -> CompletionChunk {
    let mut chunk = CompletionChunk::default();
    match api_family(provider) {
        ApiFamily::Responses => {
            let t = value["type"].as_str().unwrap_or("");
            let index = num(&value["output_index"]);
            if t == "response.output_text.delta" {
                chunk.content = value["delta"].as_str().unwrap_or("").to_string();
            } else if t.ends_with(".delta") && (t.contains("reasoning") || t.contains("summary")) {
                // Capture ONLY the incremental reasoning deltas. The Responses
                // API also emits aggregate `.done`/`.added` events carrying the
                // FULL summary text; matching those re-emitted the whole trace
                // 2-3× into the thinking panel.
                chunk.thinking = value["delta"].as_str().unwrap_or("").to_string();
            } else if t == "response.output_item.added" && value["item"]["type"] == "function_call"
            {
                let item = &value["item"];
                acc.open(
                    index,
                    item["call_id"].as_str().unwrap_or(""),
                    item["name"].as_str().unwrap_or(""),
                    item["arguments"].as_str().unwrap_or(""),
                );
            } else if t == "response.function_call_arguments.delta" {
                acc.append(index, value["delta"].as_str().unwrap_or(""));
            } else if t == "response.function_call_arguments.done" {
                if let Some(full) = value["arguments"].as_str() {
                    acc.set_args(index, full);
                }
            } else if t == "response.output_item.done" && value["item"]["type"] == "function_call" {
                let item = &value["item"];
                acc.open(
                    index,
                    item["call_id"].as_str().unwrap_or(""),
                    item["name"].as_str().unwrap_or(""),
                    "",
                );
                if let Some(full) = item["arguments"].as_str() {
                    acc.set_args(index, full);
                }
            } else if t == "response.completed" || t == "response.incomplete" {
                let u = &value["response"]["usage"];
                usage.input = num(&u["input_tokens"]);
                usage.output = num(&u["output_tokens"]);
                usage.reasoning = num(&u["output_tokens_details"]["reasoning_tokens"]);
                usage.cached_input = num(&u["input_tokens_details"]["cached_tokens"]);
                if value["response"]["incomplete_details"]["reason"] == "max_output_tokens" {
                    acc.stop = Some(StopReason::MaxTokens);
                }
            }
        }
        ApiFamily::Messages => {
            let t = value["type"].as_str().unwrap_or("");
            let index = num(&value["index"]);
            if t == "content_block_start" {
                let b = &value["content_block"];
                match b["type"].as_str() {
                    Some("tool_use") => acc.open(
                        index,
                        b["id"].as_str().unwrap_or(""),
                        b["name"].as_str().unwrap_or(""),
                        "",
                    ),
                    // Reasoning blocks are signed and must be replayed with
                    // the turn's tool calls: collect them as they stream.
                    Some("thinking") => acc.open_thinking(index),
                    Some("redacted_thinking") => {
                        acc.push_redacted(index, b["data"].as_str().unwrap_or(""))
                    }
                    _ => {}
                }
            } else if t == "content_block_delta" {
                let d = &value["delta"];
                if let Some(tk) = d["thinking"].as_str() {
                    chunk.thinking = tk.to_string();
                    acc.append_thinking(index, tk);
                } else if let Some(sig) = d["signature"].as_str() {
                    acc.append_signature(index, sig);
                } else if let Some(tx) = d["text"].as_str() {
                    chunk.content = tx.to_string();
                } else if d["type"] == "input_json_delta" {
                    acc.append(index, d["partial_json"].as_str().unwrap_or(""));
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
                match value["delta"]["stop_reason"].as_str() {
                    Some("tool_use") => acc.stop = Some(StopReason::ToolUse),
                    Some("max_tokens") => acc.stop = Some(StopReason::MaxTokens),
                    Some("end_turn") | Some("stop_sequence") => {
                        acc.stop = Some(StopReason::EndTurn)
                    }
                    _ => {}
                }
            } else if t == "message_start" {
                // Anthropic's `input_tokens` excludes the cached parts of the
                // prompt; `Usage::input` is the whole prompt, with the cache
                // read and write counts as subsets of it (the OpenAI shape).
                let u = &value["message"]["usage"];
                usage.cached_input = num(&u["cache_read_input_tokens"]);
                usage.cache_write = num(&u["cache_creation_input_tokens"]);
                usage.input = num(&u["input_tokens"]) + usage.cached_input + usage.cache_write;
            }
        }
        ApiFamily::Gemini => {
            if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                for p in parts {
                    if let Some(tx) = p["text"].as_str() {
                        if p["thought"].as_bool() == Some(true) {
                            chunk.thinking.push_str(tx);
                        } else {
                            chunk.content.push_str(tx);
                        }
                    }
                    if let Some(fc) = p.get("functionCall") {
                        let args = fc["args"].clone();
                        acc.push_whole(
                            fc["name"].as_str().unwrap_or(""),
                            if args.is_null() { json!({}) } else { args },
                            p["thoughtSignature"].as_str().map(|s| s.to_string()),
                        );
                    }
                }
            }
            match value["candidates"][0]["finishReason"].as_str() {
                Some("MAX_TOKENS") => acc.stop = Some(StopReason::MaxTokens),
                Some("STOP") if acc.stop.is_none() => acc.stop = Some(StopReason::EndTurn),
                _ => {}
            }
            let u = &value["usageMetadata"];
            if let Some(i) = u["promptTokenCount"].as_u64() {
                usage.input = i;
            }
            if let Some(o) = u["candidatesTokenCount"].as_u64() {
                usage.output = o;
            }
            if let Some(r) = u["thoughtsTokenCount"].as_u64() {
                usage.reasoning = r;
            }
            if let Some(c) = u["cachedContentTokenCount"].as_u64() {
                usage.cached_input = c;
            }
        }
        ApiFamily::ChatCompletions => {
            let choice = &value["choices"][0];
            let delta = &choice["delta"];
            if let Some(c) = delta["content"].as_str() {
                chunk.content = c.to_string();
            }
            if let Some(r) = delta["reasoning_content"].as_str() {
                chunk.thinking = r.to_string();
            }
            if let Some(calls) = delta["tool_calls"].as_array() {
                for (i, c) in calls.iter().enumerate() {
                    let index = c["index"].as_u64().unwrap_or(i as u64);
                    acc.open(
                        index,
                        c["id"].as_str().unwrap_or(""),
                        c["function"]["name"].as_str().unwrap_or(""),
                        c["function"]["arguments"].as_str().unwrap_or(""),
                    );
                }
            }
            match choice["finish_reason"].as_str() {
                Some("tool_calls") => acc.stop = Some(StopReason::ToolUse),
                Some("length") => acc.stop = Some(StopReason::MaxTokens),
                Some("stop") if acc.stop.is_none() => acc.stop = Some(StopReason::EndTurn),
                _ => {}
            }
            let u = &value["usage"];
            if u.is_object() {
                usage.input = num(&u["prompt_tokens"]);
                usage.output = num(&u["completion_tokens"]);
                if let Some(r) = u["completion_tokens_details"]["reasoning_tokens"].as_u64() {
                    usage.reasoning = r;
                }
                // OpenAI-compatible (Qwen, Kimi, Zhipu) report cache hits under
                // prompt_tokens_details; DeepSeek uses prompt_cache_hit_tokens.
                let cached = u["prompt_tokens_details"]["cached_tokens"]
                    .as_u64()
                    .or_else(|| u["prompt_cache_hit_tokens"].as_u64());
                if let Some(c) = cached {
                    usage.cached_input = c;
                }
                if let Some(w) = u["prompt_tokens_details"]["cache_creation_input_tokens"].as_u64()
                {
                    usage.cache_write = w;
                }
            }
        }
    }
    chunk
}

/// Stream a completion, invoking `on_chunk` for each live token, and return
/// everything it produced: usage (with cache hits), the full text and
/// thinking, any tool calls, and why it stopped. `on_chunk` is synchronous
/// (the orchestrator forwards into an unbounded channel), which keeps this
/// borrow-friendly and avoids extra tasks.
pub async fn stream_completion(
    http: &reqwest::Client,
    provider: Provider,
    base_url: &str,
    api_key: &str,
    req: &CompletionRequest,
    on_chunk: &mut (dyn FnMut(&CompletionChunk) + Send),
) -> Result<CompletionOutcome> {
    check_base_url(base_url).map_err(|e| Error::Config(format!("{}: {e}", provider.slug())))?;
    let prepared = prepare(provider, base_url, api_key, req);
    let mut builder = http.post(&prepared.url).json(&prepared.body);
    for (name, value) in &prepared.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }

    let resp = builder.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = read_capped(resp, ERROR_BODY_CAP).await.unwrap_or_default();
        return Err(Error::Provider {
            status: status.as_u16(),
            body,
        });
    }

    let mut stream = resp.bytes_stream();
    let mut total_bytes = 0usize;
    let mut decoder = SseDecoder::new();
    let mut usage = Usage::default();
    let mut acc = ToolAccumulator::default();
    let mut text = String::new();
    let mut thinking = String::new();
    // Carry incomplete UTF-8 sequences across network chunks so a multibyte
    // character (CJK/emoji) split on a chunk boundary isn't corrupted.
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(item) = stream.next().await {
        let bytes = item?;
        total_bytes += bytes.len();
        if total_bytes > MAX_STREAM_BYTES {
            return Err(Error::Other(format!(
                "the response stream exceeded {} MB",
                MAX_STREAM_BYTES / (1024 * 1024)
            )));
        }
        byte_buf.extend_from_slice(&bytes);
        let valid_len = match std::str::from_utf8(&byte_buf) {
            Ok(s) => s.len(),
            Err(e) => e.valid_up_to(),
        };
        if valid_len == 0 {
            continue;
        }
        // The prefix is valid UTF-8 by construction.
        let chunk_text: String = String::from_utf8_lossy(&byte_buf[..valid_len]).into_owned();
        byte_buf.drain(..valid_len);

        for payload in decoder.push(&chunk_text) {
            if payload == "[DONE]" {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(&payload) {
                // `SC_STREAM_DEBUG=1` prints only event *types* (never content)
                // — enough to see which reasoning/summary events a provider emits.
                if std::env::var_os("SC_STREAM_DEBUG").is_some() {
                    if let Some(t) = value["type"].as_str() {
                        // Block and delta kinds only — never content.
                        let kind = value["content_block"]["type"]
                            .as_str()
                            .or_else(|| value["delta"]["type"].as_str())
                            .unwrap_or("");
                        eprintln!("[stream:{}] {t} {kind}", provider.slug());
                    }
                }
                let chunk = parse_event(provider, &value, &mut usage, &mut acc);
                if !chunk.content.is_empty() || !chunk.thinking.is_empty() {
                    text.push_str(&chunk.content);
                    thinking.push_str(&chunk.thinking);
                    on_chunk(&chunk);
                }
            }
        }
    }

    let thinking_blocks = acc.thinking_blocks();
    let (tool_calls, stop) = acc.finish();
    Ok(CompletionOutcome {
        usage,
        text,
        thinking,
        thinking_blocks,
        tool_calls,
        stop,
    })
}

/// The most of an error body the engine keeps (enough to read the message).
pub const ERROR_BODY_CAP: usize = 64 * 1024;
/// The most of a non-streamed body (model lists, search pages) the engine reads.
pub const BODY_CAP: usize = 8 * 1024 * 1024;
/// The most a completion stream may deliver before the turn is abandoned.
pub const MAX_STREAM_BYTES: usize = 64 * 1024 * 1024;

/// Read at most `cap` bytes of a response body (lossy UTF-8); the rest of
/// the connection is dropped, so a hostile endpoint cannot fill memory.
pub async fn read_capped(
    resp: reqwest::Response,
    cap: usize,
) -> std::result::Result<String, reqwest::Error> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(item) = stream.next().await {
        let bytes = item?;
        let room = cap.saturating_sub(buf.len());
        if room == 0 {
            break;
        }
        buf.extend_from_slice(&bytes[..bytes.len().min(room)]);
        if buf.len() >= cap {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// The transport policy for a provider base URL: `https://` anywhere, or
/// `http://` only to this machine (a local gateway), and never credentials
/// in the URL. Keys ride in headers, so plaintext transport to a remote
/// host would expose them. The URL is never echoed back.
pub fn check_base_url(url: &str) -> std::result::Result<(), String> {
    let parsed =
        reqwest::Url::parse(url.trim()).map_err(|_| "base URL is not a valid URL".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("base URL must not embed credentials".into());
    }
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_matches(|c| c == '[' || c == ']');
    let local = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    match parsed.scheme() {
        "https" => Ok(()),
        "http" if local => Ok(()),
        "http" => Err("base URL must use https (http is only allowed for localhost)".into()),
        other => Err(format!(
            "base URL scheme {other:?} is not supported (use https)"
        )),
    }
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
            tools: Vec::new(),
            cache_key: None,
        }
    }

    fn spec() -> crate::types::ToolSpec {
        crate::types::ToolSpec {
            name: "web_search".into(),
            description: "Search the web".into(),
            parameters: json!({ "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] }),
        }
    }

    fn call(id: &str, q: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "web_search".into(),
            arguments: json!({ "query": q }),
            signature: None,
        }
    }

    fn tool_round_trip() -> Vec<ChatMessage> {
        vec![
            ChatMessage::user("debate this"),
            ChatMessage::assistant_with_calls(
                "",
                vec![call("c1", "rust 2026"), call("c2", "go 2026")],
            ),
            ChatMessage::tool("c1", "web_search", "rust: fine"),
            ChatMessage::tool("c2", "web_search", "go: fine"),
        ]
    }

    #[test]
    fn responses_request_encodes_tools_function_calls_and_prompt_cache_key() {
        let mut r = req("gpt-6-astra");
        r.tools = vec![spec()];
        r.cache_key = Some("sc-session-1".into());
        r.messages = tool_round_trip();
        let p = prepare(Provider::OpenAI, "https://api.openai.com", "k", &r);
        assert_eq!(p.body["tools"][0]["type"], "function");
        assert_eq!(p.body["tools"][0]["name"], "web_search");
        assert_eq!(p.body["tools"][0]["parameters"]["required"][0], "query");
        assert_eq!(p.body["prompt_cache_key"], "sc-session-1");
        let input = p.body["input"].as_array().unwrap();
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "c1");
        assert_eq!(input[1]["arguments"], "{\"query\":\"rust 2026\"}");
        assert_eq!(input[3]["type"], "function_call_output");
        assert_eq!(input[3]["call_id"], "c1");
        assert_eq!(input[3]["output"], "rust: fine");
        assert_eq!(input.len(), 5);
    }

    #[test]
    fn messages_request_encodes_tool_use_results_and_cache_control() {
        let mut r = req("claude-opus-5");
        r.tools = vec![spec()];
        r.cache_key = Some("sc-session-1".into());
        r.messages = tool_round_trip();
        let p = prepare(Provider::Anthropic, "https://api.anthropic.com", "k", &r);
        assert_eq!(p.body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(p.body["cache_control"]["type"], "ephemeral");
        let msgs = p.body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 3, "both tool results fold into one user turn");
        assert_eq!(msgs[1]["role"], "assistant");
        assert_eq!(msgs[1]["content"][0]["type"], "tool_use");
        assert_eq!(msgs[1]["content"][0]["id"], "c1");
        assert_eq!(msgs[1]["content"][0]["input"]["query"], "rust 2026");
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(msgs[2]["content"][0]["type"], "tool_result");
        assert_eq!(msgs[2]["content"][1]["tool_use_id"], "c2");
        // MiniMax rides the same shape but does not get the cache marker.
        let p = prepare(
            Provider::MiniMax,
            "https://api.minimaxi.com/anthropic",
            "k",
            &r,
        );
        assert!(p.body.get("cache_control").is_none());
        assert_eq!(p.body["tools"][0]["name"], "web_search");
    }

    #[test]
    fn gemini_request_encodes_function_declarations_and_responses() {
        let mut r = req("gemini-3.1-pro-preview");
        r.tools = vec![spec()];
        let mut msgs = tool_round_trip();
        msgs[1].tool_calls[0].signature = Some("sig-abc".into());
        r.messages = msgs;
        let p = prepare(
            Provider::Google,
            "https://generativelanguage.googleapis.com",
            "k",
            &r,
        );
        assert_eq!(
            p.body["tools"][0]["functionDeclarations"][0]["name"],
            "web_search"
        );
        let contents = p.body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 3);
        assert_eq!(contents[1]["role"], "model");
        assert_eq!(
            contents[1]["parts"][0]["functionCall"]["name"],
            "web_search"
        );
        assert_eq!(contents[1]["parts"][0]["thoughtSignature"], "sig-abc");
        assert_eq!(
            contents[2]["parts"][1]["functionResponse"]["name"],
            "web_search"
        );
        assert_eq!(
            contents[2]["parts"][1]["functionResponse"]["response"]["result"],
            "go: fine"
        );
    }

    #[test]
    fn chat_request_encodes_tool_calls_and_role_tool_results() {
        let mut r = req("deepseek-v4-pro");
        r.tools = vec![spec()];
        r.messages = tool_round_trip();
        let p = prepare(Provider::DeepSeek, "https://api.deepseek.com", "k", &r);
        assert_eq!(p.body["tools"][0]["function"]["name"], "web_search");
        let msgs = p.body["messages"].as_array().unwrap();
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[2]["role"], "assistant");
        assert_eq!(msgs[2]["tool_calls"][1]["id"], "c2");
        assert_eq!(
            msgs[2]["tool_calls"][1]["function"]["arguments"],
            "{\"query\":\"go 2026\"}"
        );
        assert_eq!(msgs[3]["role"], "tool");
        assert_eq!(msgs[3]["tool_call_id"], "c1");
        assert_eq!(msgs[4]["content"], "go: fine");
    }

    #[test]
    fn tools_are_omitted_when_none_are_offered() {
        for provider in Provider::ALL {
            let p = prepare(provider, "https://example.com", "k", &req("some-model"));
            assert!(p.body.get("tools").is_none(), "{provider:?}");
            assert!(p.body.get("prompt_cache_key").is_none(), "{provider:?}");
            assert!(p.body.get("cache_control").is_none(), "{provider:?}");
        }
    }

    #[test]
    fn responses_stream_accumulates_a_function_call() {
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        for ev in [
            json!({"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"web_search","arguments":""}}),
            json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"query\":\"ru"}),
            json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"st 2026\"}"}),
            json!({"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"call_1","name":"web_search","arguments":"{\"query\":\"rust 2026\"}"}}),
            json!({"type":"response.completed","response":{"usage":{"input_tokens":100,"output_tokens":10,"input_tokens_details":{"cached_tokens":60},"output_tokens_details":{"reasoning_tokens":3}}}}),
        ] {
            parse_event(Provider::OpenAI, &ev, &mut usage, &mut acc);
        }
        let (calls, stop) = acc.finish();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].id, "call_1");
        assert_eq!(calls[0].name, "web_search");
        assert_eq!(calls[0].arguments["query"], "rust 2026");
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(usage.cached_input, 60);
        assert_eq!(usage.reasoning, 3);
    }

    #[test]
    fn messages_stream_accumulates_tool_use_and_cache_reads() {
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        for ev in [
            json!({"type":"message_start","message":{"usage":{"input_tokens":500,"cache_read_input_tokens":300,"cache_creation_input_tokens":50}}}),
            json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"web_search","input":{}}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"San"}}),
            json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" Francisco\"}"}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":42}}),
        ] {
            let chunk = parse_event(Provider::Anthropic, &ev, &mut usage, &mut acc);
            if ev["type"] == "content_block_delta" && ev["index"] == 0 {
                assert_eq!(chunk.content, "Let me check.");
            }
        }
        let (calls, stop) = acc.finish();
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(calls[0].arguments["query"], "San Francisco");
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!(
            (
                usage.input,
                usage.cached_input,
                usage.cache_write,
                usage.output
            ),
            (850, 300, 50, 42)
        );
    }

    #[test]
    fn gemini_function_call_arrives_whole_with_its_signature() {
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        let ev = json!({
            "candidates":[{"content":{"parts":[
                {"text":"thinking...","thought":true},
                {"functionCall":{"name":"web_search","args":{"query":"rust 2026"}},"thoughtSignature":"sig-1"}
            ]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":12,"thoughtsTokenCount":30,"cachedContentTokenCount":20}
        });
        let chunk = parse_event(Provider::Google, &ev, &mut usage, &mut acc);
        assert_eq!(chunk.thinking, "thinking...");
        let (calls, stop) = acc.finish();
        assert_eq!(calls[0].name, "web_search");
        assert_eq!(calls[0].signature.as_deref(), Some("sig-1"));
        assert_eq!(calls[0].id, "call-1");
        assert_eq!(stop, StopReason::ToolUse, "a function call wins over STOP");
        assert_eq!(
            (
                usage.input,
                usage.output,
                usage.reasoning,
                usage.cached_input
            ),
            (80, 12, 30, 20)
        );
    }

    #[test]
    fn chat_completions_tool_call_deltas_by_index() {
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        for ev in [
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"web_search","arguments":""}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":\"x\"}"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"a.txt\"}"}}]}}]}),
            json!({"choices":[{"delta":{},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":20,"prompt_cache_hit_tokens":150,"completion_tokens_details":{"reasoning_tokens":5}}}),
        ] {
            parse_event(Provider::DeepSeek, &ev, &mut usage, &mut acc);
        }
        let (calls, stop) = acc.finish();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].id, "call_a");
        assert_eq!(calls[0].arguments["query"], "x");
        assert_eq!(calls[1].name, "read_file");
        assert_eq!(calls[1].arguments["path"], "a.txt");
        assert_eq!(stop, StopReason::ToolUse);
        assert_eq!((usage.cached_input, usage.reasoning), (150, 5));
        // Qwen / Kimi shape.
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        let ev = json!({"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":64}}});
        parse_event(Provider::Qwen, &ev, &mut usage, &mut acc);
        assert_eq!(usage.cached_input, 64);
    }

    #[test]
    fn malformed_tool_arguments_are_kept_raw_not_guessed() {
        let mut acc = ToolAccumulator::default();
        acc.open(0, "c1", "web_search", "{not json");
        let (calls, _) = acc.finish();
        assert_eq!(calls[0].arguments["_raw"], "{not json");
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
        let mut acc = ToolAccumulator::default();
        let d = parse_event(Provider::OpenAI, &delta, &mut usage, &mut acc);
        let f = parse_event(Provider::OpenAI, &done, &mut usage, &mut acc);
        assert_eq!(d.thinking, "step ");
        assert!(
            f.thinking.is_empty(),
            "the aggregate .done event must not re-emit reasoning"
        );
    }

    #[test]
    fn messages_thinking_blocks_are_collected_and_replayed_before_tool_calls() {
        let mut usage = Usage::default();
        let mut acc = ToolAccumulator::default();
        let events = [
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"weigh it"}}),
            json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig-9"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"opaque"}}),
            json!({"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"web_search","input":{}}}),
            json!({"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"rust\"}"}}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}),
        ];
        let mut shown = String::new();
        for ev in &events {
            shown.push_str(&parse_event(Provider::Anthropic, ev, &mut usage, &mut acc).thinking);
        }
        assert_eq!(shown, "weigh it");
        let blocks = acc.thinking_blocks();
        assert_eq!(
            blocks,
            vec![
                ThinkingBlock::Thinking {
                    thinking: "weigh it".into(),
                    signature: "sig-9".into()
                },
                ThinkingBlock::RedactedThinking {
                    data: "opaque".into()
                },
            ]
        );
        let (calls, stop) = acc.finish();
        assert_eq!(stop, StopReason::ToolUse);
        let turn = ChatMessage::assistant_with_calls("", calls).with_thinking_blocks(blocks);
        let turns = messages_turns(&[
            ChatMessage::user("q"),
            turn,
            ChatMessage::tool("t1", "web_search", "hit"),
        ]);
        let content = turns[1]["content"].as_array().unwrap();
        assert_eq!(content[0]["type"], "thinking");
        assert_eq!(content[0]["signature"], "sig-9");
        assert_eq!(content[1]["type"], "redacted_thinking");
        assert_eq!(content[2]["type"], "tool_use");
        assert_eq!(turns[2]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn unsigned_thinking_is_not_replayed() {
        let mut acc = ToolAccumulator::default();
        acc.open_thinking(0);
        acc.append_thinking(0, "unsigned");
        assert!(acc.thinking_blocks().is_empty());
    }

    #[test]
    fn base_urls_must_be_https_or_local() {
        assert!(check_base_url("https://api.openai.com/v1").is_ok());
        assert!(check_base_url("http://localhost:11434/v1").is_ok());
        assert!(check_base_url("http://127.0.0.1:8080").is_ok());
        assert!(check_base_url("http://[::1]:8080/v1").is_ok());
        assert!(check_base_url("http://api.example.com/v1").is_err());
        assert!(check_base_url("ftp://api.example.com").is_err());
        assert!(check_base_url("https://user:pw@api.example.com").is_err());
        assert!(check_base_url("not a url").is_err());
    }
}
