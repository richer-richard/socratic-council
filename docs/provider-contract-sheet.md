# Provider Contract Sheet (Socratic Council)

Updated: 2026-09-19. Every row below was read from the provider's published
docs on that date with `curl` (WebFetch stalls on these hosts). When docs and
existing behaviour conflict, docs win. The Rust table that encodes this sheet
is `engine/src/catalog/rows.rs` (`catalog_rows`, `family_contract`); the request
builders in `cli/src/providers/mod.rs` read the contract from it.

Prices are USD per million tokens at the standard tier. CNY list prices are
converted at 7.1 CNY/USD. "cached" is the prompt-cache read (hit) price;
"write" is the cache write price where the provider bills it separately.

## OpenAI (Responses API)

- Endpoint: `POST /v1/responses`; `instructions` carries the system prompt.
- Reasoning: `reasoning.effort`. gpt-6-astra accepts low|medium|high|xhigh|max
  (no `none`); gpt-5.6 and gpt-5.5 accept none|low|medium|high|xhigh(|max on
  5.6). The engine sends low|medium|high for its three tiers. Reasoning models
  take no `temperature`.
- Tools: `tools: [{type: "function", name, description, parameters, strict}]`;
  the response `output` carries `function_call` items with `call_id`; results
  go back as `{type: "function_call_output", call_id, output}` input items.
  Streaming: `response.output_item.added` (item.type function_call),
  `response.function_call_arguments.delta`, `response.function_call_arguments.done`,
  `response.output_item.done`.
- Caching: automatic on stable prefixes; `prompt_cache_key` optional on 5.6+
  (routing is automatic), useful before 5.6. `usage.input_tokens_details.cached_tokens`.
- Prompts over 272K input tokens bill at 2x input and 1.5x output.

| id                      | class                  | ctx / max out | input            | cached              | write | output          |
| ----------------------- | ---------------------- | ------------- | ---------------- | ------------------- | ----- | --------------- |
| gpt-6-astra             | flagship               | 1.05M / 128K  | 10               | 1                   | 12.5  | 50              |
| gpt-5.6-sol             | flagship               | 1.05M / 128K  | 4                | 0.4                 | 5     | 20              |
| gpt-5.6-terra           | balanced               | 1.05M / 128K  | 2                | 0.2                 | 2.5   | 12              |
| gpt-5.6-luna            | fast                   | 1.05M / 128K  | 0.2              | 0.02                | 0.25  | 1.2             |
| gpt-5.5                 | flagship               | 1.05M / 128K  | 5                | 0.5                 |       | 30              |
| gpt-5.5-pro             | flagship               | 1.05M / 128K  | 30               |                     |       | 180             |
| gpt-5.4 / -mini / -nano | balanced / fast / fast | 1.05M / 128K  | 2.5 / 0.75 / 0.2 | 0.25 / 0.075 / 0.02 |       | 15 / 4.5 / 1.25 |
| gpt-5.3-codex, gpt-5.2  | balanced               | 400K / 128K   | 1.75             | 0.175               |       | 14              |
| gpt-5.2-pro             | flagship               | 400K / 128K   | 21               |                     |       | 168             |
| gpt-5.1                 | balanced               | 400K / 128K   | 1.25             | 0.125               |       | 10              |

Sources: developers.openai.com/api/docs/pricing, .../models/gpt-6-astra,
.../models/gpt-5.6-sol, -terra, -luna, .../models/gpt-5.5, .../models/gpt-5.4,
.../guides/function-calling, .../guides/prompt-caching.

## Anthropic (Messages API)

- Endpoint: `POST /v1/messages`, `anthropic-version: 2023-06-01`.
- Thinking is per generation and non-monotonic:
  - Fable 5.1 / Fable 5 / Mythos: adaptive, always on; `thinking.type: disabled`
    is rejected. Depth via `output_config.effort` (low|medium|high|xhigh|max;
    high = default).
  - Opus 5 / Sonnet 5: adaptive, on by default, `thinking.type: disabled`
    accepted.
  - Opus 4.8 / 4.7 / 4.6, Sonnet 4.6: off until `thinking: {type: adaptive}`.
    Extended budgets are rejected on 4.7+ (400) and deprecated on 4.6.
  - Opus 4.5, Sonnet 4.5, Haiku 4.5 and earlier: `thinking.type: enabled` +
    `budget_tokens` (< max_tokens).
  - `display: "summarized"` is required to receive thinking text on 4.7+/5.x
    (the default is `omitted`). No sampling parameters with thinking on; the
    5.x and 4.7+ rows never send a temperature.
- Tools: `tools: [{name, description, input_schema}]`; `tool_use` content
  blocks (streamed as `content_block_start` + `input_json_delta` partial JSON);
  results as `tool_result` blocks with `tool_use_id` in a user turn.
- Caching: a top-level `cache_control: {type: "ephemeral"}` enables automatic
  caching up to the last cacheable block; explicit per-block markers still
  work. Usage: `cache_read_input_tokens`, `cache_creation_input_tokens`.
  Reads 0.1x input (0.025x on Fable 5.1), 5-minute writes 1.25x.

| id                          | class    | ctx / max out | input | cached | write | output |
| --------------------------- | -------- | ------------- | ----- | ------ | ----- | ------ |
| claude-fable-5-1            | flagship | 1M / 128K     | 10    | 0.25   | 12.5  | 50     |
| claude-opus-5               | flagship | 1M / 128K     | 5     | 0.5    | 6.25  | 25     |
| claude-sonnet-5             | balanced | 1M / 128K     | 2     | 0.2    | 2.5   | 10     |
| claude-fable-5              | flagship | 1M / 128K     | 10    | 1      | 12.5  | 50     |
| claude-opus-4-8, -4-7, -4-6 | flagship | 1M / 128K     | 5     | 0.5    | 6.25  | 25     |
| claude-sonnet-4-6           | balanced | 1M / 64K      | 3     | 0.3    | 3.75  | 15     |
| claude-opus-4-5-20251101    | flagship | 200K / 64K    | 5     | 0.5    | 6.25  | 25     |
| claude-sonnet-4-5-20250929  | balanced | 200K / 64K    | 3     | 0.3    | 3.75  | 15     |
| claude-haiku-4-5-20251001   | fast     | 200K / 64K    | 1     | 0.1    | 1.25  | 5      |

Sources: platform.claude.com/docs/en/about-claude/pricing, .../models/overview,
.../build-with-claude/thinking, .../extended-thinking, .../effort,
.../prompt-caching, .../streaming, .../agents-and-tools/tool-use/overview.

## Google (Gemini API)

- Endpoint: `.../v1beta/models/{model}:streamGenerateContent?alt=sse`.
- Thinking: `generationConfig.thinkingConfig.thinkingLevel` on Gemini 3.x and
  2.5 Pro. Levels: 3.8 / 3.7 Flash and 3.1 Pro take low|medium|high; 3.6 /
  3.5 Flash, 3.5 Flash-Lite and 3 Flash Preview also take `minimal`; 3 Pro
  Preview takes low|high. The engine sends low|medium|high. 2.5 Flash family:
  `thinkingBudget`. `includeThoughts: true` returns thought summaries as parts
  with `thought: true`. Temperature is accepted alongside thinking.
- Tools: `tools: [{functionDeclarations: [{name, description, parameters}]}]`;
  `functionCall` parts arrive whole; results go back as `functionResponse`
  parts. Thought signatures ride on `functionCall` parts and must be echoed
  back unchanged on the next turn.
- Caching: implicit caching is on for 2.5 and newer (minimum 1,024 to 4,096
  tokens by model); `usageMetadata.cachedContentTokenCount`; no write charge.
- Usage: `promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount`.

| id                                       | class    | ctx / max out | input           | cached | output            |
| ---------------------------------------- | -------- | ------------- | --------------- | ------ | ----------------- |
| gemini-3.1-pro-preview                   | flagship | 1M / 64K      | 2 (4 over 200K) | 0.2    | 12 (18 over 200K) |
| gemini-3.8-flash, -3.7-flash, -3.6-flash | balanced | 1M / 64K      | 0.75            | 0.075  | 3.75              |
| gemini-3.5-flash                         | balanced | 1M / 64K      | 1.5             | 0.15   | 9                 |
| gemini-3.5-flash-lite                    | fast     | 1M / 64K      | 0.3             | 0.03   | 2.5               |
| gemini-3.1-flash-lite                    | fast     | 1M / 64K      | 0.25            | 0.025  | 1.5               |
| gemini-3-flash-preview                   | fast     | 1M / 64K      | 0.5             | 0.05   | 3                 |
| gemini-2.5-pro                           | flagship | 1M / 64K      | 1.25            | 0.125  | 10                |
| gemini-2.5-flash                         | balanced | 1M / 64K      | 0.3             | 0.03   | 2.5               |
| gemini-2.5-flash-lite                    | fast     | 1M / 64K      | 0.1             | 0.01   | 0.4               |

The 3.6 to 3.8 Flash rates are the prices through 2026-12-31; the page
schedules a doubling from 2027-01-01. gemini-3-pro-preview is listed on the
models page but absent from the pricing page: price unverified 2026-09-19,
kept at its previous value in the TypeScript registry only.

Sources: ai.google.dev/gemini-api/docs/pricing, .../docs/models, .../docs/thinking,
.../docs/function-calling, .../docs/caching.

## DeepSeek (OpenAI-compatible)

- Endpoint: `POST /v1/chat/completions` (an Anthropic-format endpoint also
  exists at `/anthropic`).
- Thinking: on by default; `thinking: {type: enabled|disabled}` toggles it,
  `reasoning_effort: low|high|max` sets depth (default high). Thinking mode
  ignores `temperature`, `presence_penalty`, `frequency_penalty`.
  Reasoning streams as `delta.reasoning_content`.
- Tools: standard `tools` / `tool_calls` / `role: tool`.
- Caching: automatic disk prefix cache; usage `prompt_cache_hit_tokens` and
  `prompt_cache_miss_tokens`.
- Prices are peak-hour (01:00 to 04:00 and 06:00 to 10:00 UTC on weekdays);
  off-peak is half.

| id                                           | class    | ctx / max out | input | cached | output |
| -------------------------------------------- | -------- | ------------- | ----- | ------ | ------ |
| deepseek-v4-pro (DeepSeek-V4-Pro-0813)       | flagship | 1M / 384K     | 1.32  | 0.044  | 3.96   |
| deepseek-flash (DeepSeek-V4.1-Flash, vision) | fast     | 1M / 384K     | 0.30  | 0.006  | 1.20   |

Sources: api-docs.deepseek.com/quick_start/pricing, .../guides/thinking_mode,
.../guides/kv_cache, .../guides/function_calling.

## Kimi / Moonshot (OpenAI-compatible, CN)

- Endpoint: `https://api.moonshot.cn/v1/chat/completions`.
- K3: always reasons; top-level `reasoning_effort: low|high|max` (default
  max); no `thinking` object; `max_completion_tokens` default 131072, max
  1048576; 1M context. K2.7-code: thinking always on (`disabled` is a 400),
  fixed temperature 1.0 (other values error). K2.6: `thinking: {type:
enabled|disabled}`, fixed temperature. The engine sends no temperature to
  any Kimi model.
- Tools: standard `tools` / `tool_calls` (streamed with `index`) / `role: tool`;
  with thinking on, `tool_choice` must be auto or none.
- Caching: automatic on prefixes above 256 tokens, no cache id needed; K3
  bills cache writes separately (5-minute TTL at the input price, 1-hour at 2x).

| id                       | class    | ctx       | input (CNY) | cached (CNY) | output (CNY) | USD in / cached / out |
| ------------------------ | -------- | --------- | ----------- | ------------ | ------------ | --------------------- |
| kimi-k3                  | flagship | 1,048,576 | 20          | 2            | 100          | 2.82 / 0.28 / 14.08   |
| kimi-k2.7-code           | balanced | 262,144   | 6.5         | 1.3          | 27           | 0.92 / 0.18 / 3.80    |
| kimi-k2.7-code-highspeed | fast     | 262,144   | 13          | 2.6          | 54           | 1.83 / 0.37 / 7.61    |
| kimi-k2.6                | balanced | 262,144   | 6.5         | 1.1          | 27           | 0.92 / 0.15 / 3.80    |

Sources: platform.moonshot.cn/docs/pricing/chat, .../guide/kimi-k3-quickstart,
.../guide/kimi-k2-7-code-quickstart, .../guide/kimi-k2-6-quickstart,
.../guide/use-kimi-api-to-complete-tool-calls.

## Qwen / Alibaba Model Studio (OpenAI-compatible, CN)

- Endpoint: `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`.
- Thinking: `enable_thinking` (via `extra_body` in the OpenAI SDK); reasoning
  streams as `delta.reasoning_content`. Temperature is accepted.
- Tools: standard `tools` / `tool_calls` / `role: tool`.
- Caching: implicit caching is automatic and cannot be disabled (hits bill at
  20% of input); explicit caching bills creation at 125% and hits at 10%.
  Usage: `prompt_tokens_details.cached_tokens`
  (and `cache_creation_input_tokens` for explicit caches).
- Prices below are the Beijing region, first tier (0 to 1M input tokens
  unless noted), CNY per 1M.

| id                | class    | input (CNY)                        | output (CNY) | USD in / cached / out |
| ----------------- | -------- | ---------------------------------- | ------------ | --------------------- |
| qwen3.8-max       | flagship | 12                                 | 36           | 1.69 / 0.34 / 5.07    |
| qwen3.8-2.4t-a95b | flagship | 12                                 | 36           | 1.69 / 0.34 / 5.07    |
| qwen3.7-max       | flagship | 12                                 | 36           | 1.69 / 0.34 / 5.07    |
| qwen3.8-27b       | balanced | 3                                  | 12           | 0.42 / 0.08 / 1.69    |
| qwen3.7-plus      | balanced | 2 (list; 20% off for now)          | 8            | 0.28 / 0.06 / 1.13    |
| qwen3.8-flash     | fast     | 0.8                                | 2.7          | 0.11 / 0.02 / 0.38    |
| qwen3.7-flash     | fast     | 0.2 (≤32K; 0.6 to 256K; 1.2 to 1M) | 0.8          | 0.03 / 0.006 / 0.11   |

Sources: help.aliyun.com/zh/model-studio/models (pricing tab), .../deep-thinking,
.../qwen-function-calling, .../context-cache.

## MiniMax (Anthropic-compatible, CN)

- Endpoint: `https://api.minimaxi.com/anthropic/v1/messages`.
- Thinking: MiniMax-M3 is off unless `thinking: {type: adaptive}` is sent
  (`disabled` keeps it off). M2.x cannot be turned off; `disabled` is accepted
  and ignored. Thinking blocks must be returned unchanged in multi-turn use.
  `<think>` tags in text are stripped defensively.
- Tools: Messages-style `tools` / `tool_use` / `tool_result` on M3 and M2.x.
- Price: the M3 model page states the price is unchanged from M2.7; no
  per-token table was fetchable on 2026-09-19, so the M2.7 CNY list rates are
  kept and marked **unverified**: M3 and M2.7 2.1 / 8.4 CNY (0.30 / 1.18 USD),
  M2.7-highspeed 4.2 / 16.8 CNY (0.59 / 2.37 USD). M3: 1M context, 128K
  output; M2.7: 200K context.

Sources: platform.minimax.io/docs/api-reference/text-anthropic-api,
.../guides/models-intro, minimax.io/models/text/m3.

## Zhipu / Z.AI (OpenAI-compatible, CN)

- Endpoint: `https://open.bigmodel.cn/api/paas/v4/chat/completions`.
- Thinking: GLM-5.3 family is always on (`thinking.type: disabled` is no
  longer supported) with `reasoning_effort: low|high|max` (default max).
  GLM-5.2 and earlier: `thinking: {type: enabled|disabled}`; GLM-4.7 is forced
  on. Temperature accepted.
- Tools: standard `tools` / `tool_calls`; tool streaming (`tool_stream`) is on
  by default for GLM-5.3.
- Prices: CN platform, CNY per 1M; cache hits priced per model; cache
  storage free for now. (Z.AI international prices differ: GLM-5.3 1.4 /
  0.26 / 4.4 USD.)

| id             | class    | ctx / max out | input (CNY) | cached (CNY) | output (CNY) | USD in / cached / out           |
| -------------- | -------- | ------------- | ----------- | ------------ | ------------ | ------------------------------- |
| glm-5.3        | flagship | 1M / 128K     | 8           | 2            | 28           | 1.13 / 0.28 / 3.94              |
| glm-5.3-flashx | balanced | 1M / 128K     | 2           | 0.57         | 7            | 0.28 / 0.08 / 0.99              |
| glm-5.3-flash  | fast     | 1M / 128K     | 0.8         | 0.23         | 2.8          | 0.11 / 0.03 / 0.39              |
| glm-5.2        | flagship | 1M / 128K     | 8           | 2            | 28           | 1.13 / 0.28 / 3.94              |
| glm-5.1        | flagship | 200K / 128K   | 6 (<32K)    | 1.3          | 24           | 0.85 / 0.18 / 3.38              |
| glm-5-turbo    | balanced | 200K / 128K   | 5 (<32K)    | 1.2          | 22           | 0.70 / 0.17 / 3.10              |
| glm-5          | balanced | 200K / 128K   | 4 (<32K)    | 1            | 18           | 0.56 / 0.14 / 2.54              |
| glm-4.7        | balanced | 200K / 128K   | 4           | 0.8          | 16           | 0.56 / 0.11 / 2.25 (unverified) |

Sources: docs.bigmodel.cn/cn/guide/start/pricing, .../start/model-overview,
.../models/text/glm-5.3, docs.z.ai/guides/overview/pricing.

## Unknown ids

Ids the table does not know inherit their family's contract by prefix
(`family_contract` in `engine/src/catalog/rows.rs`) and stay unpriced; the
ledger reports them as an unpriced lower bound. Never guess a price.
