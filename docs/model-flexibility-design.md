# Model Flexibility — Auto choice, capability scanning, reasoning tiers

> Status: design (June 2026). Implements the "stop hand-bumping model IDs"
> upgrade. Supersedes the per-character `LOCKED_MODELS` lock.

## Problem

Today every character is pinned to one hardcoded model id via
`LOCKED_MODELS` (`apps/desktop/src/stores/config.ts:118`). `config.models`
is dead — `sanitizeModels()` and `updateModel()` both reset to the lock
(`config.ts:261,593`). When a provider ships a newer flagship the ids must
be edited by hand in `MODEL_REGISTRY`, `LOCKED_MODELS`, the per-provider
zod enums, and the moderator/extractor pickers in `Chat.tsx`. That manual
bump is the pain point (and the source of the "fabricated model id"
regressions — see `git log`).

## Goals

1. **Auto model choice** — by default each provider/tier resolves to the
   best _currently available_ model, so a new flagship is used the moment
   it is discovered, without code edits.
2. **Capability scanning** — call each provider's _own_ list-models
   endpoint (Chinese endpoints for Chinese providers) with the user's key,
   so the picker shows what the key can actually use.
3. **Reasoning tiers** — in Settings, assign a model to each reasoning
   level (Low / Medium / High) per provider, and have the level also drive
   the provider's reasoning-effort knob.

Non-negotiable (per user memory _No fabricated model IDs_): never invent a
model id. Auto picks only from **scanned** ids or the **existing** catalog.

## Concepts

```ts
type ReasoningTier = "low" | "medium" | "high"; // council-wide levels
type ModelSelection = string; // a model id, or "auto"

interface ProviderModelConfig {
  tiers: Record<ReasoningTier, ModelSelection>;
}

interface AppConfig {
  // …existing…
  modelSelection: Partial<Record<Provider, ProviderModelConfig>>; // NEW
  agentTiers: Partial<Record<AgentId, ReasoningTier>>; // NEW, default "high"
  councilTier: ReasoningTier; // default "high" — debate turns
  utilityTier: ReasoningTier; // default "low"  — bidding/argmap/etc.
}
```

Default for every provider: `{ low: "auto", medium: "auto", high: "auto" }`.
With everything on Auto the app behaves like today (Auto picks the catalog
flagship, which equals the old lock) but upgrades itself after a scan.

### Discovered models

New service `apps/desktop/src/services/modelScan.ts`:

```ts
interface DiscoveredModel {
  id: string; provider: Provider; displayName?: string; created?: number;
  source: "scanned" | "catalog";
  // enriched from MODEL_REGISTRY when the id matches:
  contextWindow?: number; supportsThinking?: boolean; pricing?: ModelInfo["pricing"];
}
scanProviderModels(provider, credential, proxy): Promise<DiscoveredModel[]>
getCachedModels(provider): DiscoveredModel[]      // localStorage: socratic-council-models:<provider>
listAvailableModels(provider): DiscoveredModel[]  // cached scan ∪ catalog, deduped, ranked
```

Scan endpoints (GET, through the existing Tauri transport so proxy +
allowlist apply — all hosts already allowlisted in `allowlist.rs:29`):

| Provider  | Method | URL (base = credential.baseUrl ?? default)            | Parse                             |
| --------- | ------ | ----------------------------------------------------- | --------------------------------- |
| openai    | GET    | `<base>/v1/models`                                    | `data[].id`                       |
| anthropic | GET    | `<base>/v1/models` (x-api-key + anthropic-version)    | `data[].id`,`display_name`        |
| google    | GET    | `<base>/v1beta/models` (x-goog-api-key)               | `models[].name` → strip `models/` |
| deepseek  | GET    | `<base>/v1/models`                                    | `data[].id`                       |
| kimi      | GET    | `<base>/v1/models`                                    | `data[].id`                       |
| qwen      | GET    | `<base>/models` (base already `…/compatible-mode/v1`) | `data[].id`                       |
| zhipu     | GET    | `<base>/models` (base already `…/api/paas/v4`)        | `data[].id`                       |
| minimax   | —      | Anthropic-style endpoint, no list API                 | catalog only                      |

Every scan **degrades gracefully**: non-2xx / parse failure / empty →
return catalog for that provider and surface a soft warning. minimax always
returns catalog.

### Auto resolver (`packages/shared` so the CLI can reuse it)

```ts
rankModelCapability(m): number   // higher = more capable
rankModelSpeed(m): number        // higher = faster/cheaper
resolveModel(provider, tier, available, selection?): string
```

`resolveModel`:

1. If `selection` is a concrete id present in `available` → use it.
2. Else (Auto, or a stale id) rank `available`:
   - **high** → max capability (prefer `supportsThinking`, newest version,
     catalog rank).
   - **low** → max speed (markers: mini/flash/lite/nano/turbo/haiku/air/
     flash; lowest pricing).
   - **medium** → highest capability among non-top, else the top.
3. Fallback to `CATALOG_DEFAULT_MODELS[provider]` (renamed `LOCKED_MODELS`)
   when `available` is empty.

Ranking heuristic for arbitrary scanned ids: catalog order wins when known;
otherwise compare extracted numeric version tokens, then markers. Pure,
unit-tested, no fabricated ids.

### Reasoning effort from tier

Thread `reasoningTier?: ReasoningTier` through `CompletionOptions` →
`callProvider` → each provider's `buildRequestBody`. Mapping:

| Provider            | low                                        | medium    | high                       |
| ------------------- | ------------------------------------------ | --------- | -------------------------- |
| openai              | effort `low`                               | `medium`  | `xhigh` (gpt-5.x) / `high` |
| anthropic           | per-model profile (see below)              |           |                            |
| google              | thinkingBudget 0 (omit)                    | 8192      | 24576                      |
| qwen                | enable_thinking=false                      | true      | true                       |
| minimax             | omit                                       | budget≈8k | budget≈32k                 |
| deepseek/kimi/zhipu | model-driven (Auto picks reasoner vs chat) |           |                            |

Additive: when no tier is passed, current hardcoded behavior is unchanged,
so existing tests stay green.

### Anthropic per-model thinking profile (wire carefully)

Thinking config differs **per Claude model generation** and is NOT
monotonic — adaptive was added then removed:

| Model match                                 | mode       | prohibitsSampling | notes                                                                               |
| ------------------------------------------- | ---------- | ----------------- | ----------------------------------------------------------------------------------- |
| `opus-4-8`                                  | `extended` | false             | **4.8 reverted adaptive** → extended `budget_tokens` again; sampling params allowed |
| `opus-4-7`                                  | `adaptive` | true              | adaptive is the ONLY thinking-on mode; temp/top_p/top_k → 400                       |
| `opus-4-6`                                  | `adaptive` | false             | adaptive introduced here                                                            |
| `opus-4`/`sonnet-4`/`haiku-4` (4.5, 4.1, 4) | `extended` | false             | `{type:"enabled", budget_tokens}`                                                   |
| `claude-3*` / other                         | `none`     | false             | no thinking field ever                                                              |

```ts
interface AnthropicThinkingProfile {
  mode: "adaptive" | "extended" | "none";
  prohibitsSampling: boolean;
}
function anthropicThinkingProfile(model: string): AnthropicThinkingProfile;
```

Tier → request:

- **adaptive**: `low` → omit thinking; `medium`/`high` → `{type:"adaptive"}`.
- **extended**: `low` → omit; `medium` → `{type:"enabled", budget_tokens: min(4096, maxTokens-256)}`;
  `high` → `{type:"enabled", budget_tokens: min(8192, maxTokens-256)}`. Skip if budget < 1024.
- **none**: never send thinking.
- Sampling: only set `temperature` when thinking is omitted **and**
  `!prohibitsSampling`.

This replaces the buggy `supportsAdaptiveThinking()` (`anthropic.ts:121`)
which currently returns true for 4.8. The profile table is the single
source of truth and is unit-tested per model id.

## Wiring (resolution points found in scan)

- `Chat.tsx` agent turns read `config.models[provider]` → switch to
  `resolveModel(provider, agentTier, available, sel)`.
- `pickModeratorRuntime` / `pickFinalSummaryRuntime` / `pickExtractorRuntime`
  (`Chat.tsx:2886-2963`) hardcode Gemini ids → resolve via
  `resolveModel(provider, utilityTier, …)`.
- `useObserverCircle.ts:210` and `deepResearch.ts` pass an explicit model →
  resolve through the same helper.
- `config.models` stays as a **derived** convenience map
  (`= high-tier resolved per provider`) so nothing downstream breaks during
  migration.

## Settings UI (Models tab redraw)

Replace the read-only "Locked" cards with, per provider card:

```
┌ 🔷 George · OpenAI ───────────────────────────── [⟳ Scan models] ┐
│  42 models available · scanned 2m ago                            │
│                                                                  │
│  Low     [ Auto ▾ ]   → gpt-5-nano                               │
│  Medium  [ Auto ▾ ]   → gpt-5-mini                               │
│  High    [ Auto ▾ ]   → gpt-5.5            ← debate default      │
│                                                                  │
│  Debate this character at:  ( Low ) ( Med ) (•High)              │
└──────────────────────────────────────────────────────────────────┘
```

- **Scan models** button → `scanProviderModels`; shows spinner, count, and
  "scanned Xm ago"; disabled until the key is verified + `vaultReady`.
- Each tier row: a searchable dropdown whose options are
  `[Auto] + listAvailableModels(provider)`; the resolved id is shown to the
  right (so "Auto → gpt-5.5" is visible).
- Per-character segmented control sets `agentTiers[agent]`.
- A top strip: global "Reasoning level for debate" (councilTier) and
  "Background tasks" (utilityTier) selectors, plus one **Auto-pick newest
  for all providers** button.
- Cinematic-dark palette, gold accent `#F5C542`, reuse `Dropdown` +
  `settings-card`. New options dropdown supports type-to-filter for long
  scanned lists.

## Migration & persistence

- `loadConfig` builds `modelSelection`/`agentTiers`/tiers with defaults;
  legacy `models` is ignored (already dead). `saveConfig` persists the new
  fields (non-secret). Scanned model lists live in their own localStorage
  keys, never in the encrypted blob.
- `ModelId` union relaxed to `ModelId | (string & {})` on `AgentConfig.model`
  and `AgentConfigSchema.model` → `z.string()` so scanned ids typecheck.
  Providers already `as`-cast, so runtime is unaffected.

## Tests

- `resolveModel` ranking (catalog + synthetic scanned ids, every tier).
- `modelScan` parsers per provider (fixture payloads), graceful fallback.
- reasoning-tier → knob mapping per provider buildRequestBody.
- config migration/defaults.
- Keep all 323 existing tests green; `pnpm typecheck` clean.
