# Provider Contract Sheet (Socratic Council)

Updated: 2026-03-05

This sheet records the API contracts used for provider request builders and stream parsers.
When docs and existing behavior conflict, docs win.

## OpenAI (Responses API, GPT-5 family)
- Endpoint: `POST /v1/responses`
- Streaming events to parse:
  - `response.output_text.delta`
  - `response.output_text.done`
  - `response.reasoning_summary_text.delta`
  - `response.reasoning_summary_text.done`
  - `response.reasoning_summary_part.done`
  - `response.completed`
- Usage fields:
  - `usage.input_tokens`
  - `usage.output_tokens`
  - `usage.output_tokens_details.reasoning_tokens`
- Parameter compatibility:
  - GPT-5 family reasoning uses `reasoning.effort`
  - GPT-5.x rejects `temperature`/`top_p` when reasoning is active (except `none`-style cases)
- Prompt caching:
  - `prompt_cache_key` can be set on repeated prefixes to improve cache hit rate
  - `prompt_cache_retention` defaults to in-memory retention for supported models
- Reasoning summary:
  - `reasoning.summary = "auto"` to request best available summary depth.

Sources:
- https://platform.openai.com/docs/api-reference/responses-streaming/response/reasoning_summary_text/done
- https://platform.openai.com/docs/guides/streaming-responses
- https://platform.openai.com/docs/guides/latest-model
- https://platform.openai.com/docs/guides/reasoning

## Anthropic (Messages API, Claude 4.x)
- Endpoint: `POST /v1/messages`
- Streaming events to parse:
  - `content_block_start`
  - `content_block_delta` (`text_delta`, `thinking_delta`, `signature_delta`)
  - `message_delta` (includes `delta.stop_reason` and usage)
- Usage fields:
  - `usage.input_tokens`
  - `usage.output_tokens`
- Thinking constraints:
  - Must satisfy `max_tokens > thinking.budget_tokens`
  - Thinking mode is not compatible with `temperature` / `top_k` overrides
  - Adaptive thinking is supported for newer models (used for Opus 4.6 path)
- Prompt caching:
  - Stable prompt prefixes can be marked with `cache_control: { type: "ephemeral" }` on cacheable content blocks

Sources:
- https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- https://docs.anthropic.com/claude/reference/messages-streaming
- https://docs.anthropic.com/en/api/handling-stop-reasons

## Gemini (Google Generative Language API)
- Endpoint pattern:
  - `.../models/{model}:generateContent`
  - `.../models/{model}:streamGenerateContent?alt=sse`
- Thought output config:
  - `generationConfig.thinkingConfig.includeThoughts = true`
  - `generationConfig.thinkingConfig.thinkingBudget`
- Parsing:
  - Thought summary appears in `parts` with `thought: true`
- Usage fields:
  - `usageMetadata.promptTokenCount`
  - `usageMetadata.candidatesTokenCount`
  - `usageMetadata.thoughtsTokenCount`

Sources:
- https://ai.google.dev/gemini-api/docs/thinking
- https://ai.google.dev/api/rest/generativelanguage
- https://ai.google.dev/gemini-api/docs/text-generation

## DeepSeek
- Endpoint: OpenAI-compatible `POST /v1/chat/completions`
- Thinking output:
  - `message.reasoning_content`
  - streaming `delta.reasoning_content`
- Usage reasoning tokens:
  - `usage.completion_tokens_details.reasoning_tokens`
- Compatibility:
  - `deepseek-reasoner` has unsupported params (temperature/top_p/etc.) per docs.

Sources:
- https://api-docs.deepseek.com/guides/reasoning_model
- https://api-docs.deepseek.com/api/create-chat-completion

## Qwen (Alibaba DashScope compatible-mode, CN)
- Base URL: `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Endpoint: `POST /chat/completions`
- Thinking output:
  - `enable_thinking: true`
  - streaming `delta.reasoning_content`
- Usage fields:
  - `usage.prompt_tokens`
  - `usage.completion_tokens`

Sources:
- https://help.aliyun.com/zh/model-studio/use-qwen-by-calling-api
- https://help.aliyun.com/zh/model-studio/user-guide/streaming

## MiniMax (Anthropic-compatible, CN)
- Base URL: `https://api.minimaxi.com/anthropic`
- Endpoint: `POST /v1/messages`
- Canonical model ID:
  - `MiniMax-M2.5` (lowercase alias `minimax-m2.5` normalized internally)
- Compatibility:
  - Anthropic-compatible request/stream shapes are supported
  - Keep thinking budget below `max_tokens` for safety

Sources:
- https://platform.minimaxi.com/docs/api-reference/text-anthropic-api
- https://platform.minimaxi.com/docs/guides/text-ai-coding-tools
- https://platform.minimaxi.com/docs/api-reference/api-overview

## Kimi (Moonshot, OpenAI-compatible)
- Base URL: `https://api.moonshot.cn/v1`
- Endpoint: `POST /chat/completions`
- Thinking output:
  - `reasoning_content` appears in message/delta for thinking-capable models
- Current integration status:
  - Existing integration kept stable; no protocol regression changes in this revision.

Sources:
- https://platform.moonshot.cn/blog/posts/kimi-thinking
- https://platform.moonshot.cn/blog/posts/kimi-api-quick-start-guide
