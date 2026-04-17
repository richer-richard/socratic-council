# Socratic Council — Feature Plan

## 1. The Literal Discussions — Inner/Outer Council Circle

The debate experience becomes a living, visual event. Sixteen agents — eight active debaters in an inner circle and eight silent advisors in an outer circle — are arranged concentrically on screen. The inner circle agents discuss, bid, react, and argue publicly. The outer circle agents observe silently and can pass secret notes to their paired inner agent at any time. Each inner-outer pair runs on the same provider and model but operates as two distinct agents with different names, different system prompts, and different roles.

This feature replaces the current home page layout, overhauls the in-discussion view, and introduces the bubble-based message lifecycle — the most substantial visual and architectural change since launch.

### 1.1 Agent Roster (16 Agents, 8 Pairs)

Each pair shares the same provider and model, and both names begin with the same initial (matching the model's initial). Inner agents retain their current names. Outer agents are new additions.

| Pair | Inner Agent | Outer Agent | Provider | Model | Initial |
|------|-------------|-------------|----------|-------|---------|
| 1 | George | Gavin | OpenAI | GPT-5.4 | G |
| 2 | Cathy | Celeste | Anthropic | Claude Opus 4.6 | C |
| 3 | Grace | Gideon | Google | Gemini 3.1 Pro | G |
| 4 | Douglas | Diana | DeepSeek | DeepSeek Reasoner | D |
| 5 | Kate | Kira | Kimi | Kimi K2.5 | K |
| 6 | Quinn | Quentin | Qwen | Qwen 3.5 Plus | Q |
| 7 | Mary | Marcus | MiniMax | MiniMax M2.5 | M |
| 8 | Zara | Zane | Z.AI | GLM-5 | Z |

The optional Moderator (GPT-5.3 Instant) continues to exist independently — it is not part of the inner/outer pairing system and operates outside the circle.

**Implementation touchpoints:**
- Expand `DEFAULT_AGENTS` in `packages/shared/src/constants/index.ts` to include 8 new outer agents, each referencing the same provider and model as their inner partner
- Extend `AgentId` union type in `packages/shared/src/types/index.ts` to include outer agent names
- Add a `role` field to `AgentConfig` (`"inner" | "outer"`) and a `pairedWith` field linking each outer agent to its inner partner
- Outer agents get a distinct system prompt: they are instructed to observe the public discussion and send secret notes when they have strategic advice, counterarguments, additional evidence, or warnings for their inner partner

### 1.2 Roles and Visibility Rules

**Inner agents (public speakers):**
- See all public messages from all other inner agents
- Participate in bidding, turn-taking, reactions, and quoting (existing mechanics)
- Receive secret notes from their outer partner (and only their outer partner)
- Do NOT see secret notes sent to other inner agents
- Do NOT know that other pairs are exchanging notes — the note-passing mechanic is invisible between pairs

**Outer agents (silent advisors):**
- See the full public discussion (all inner agent messages, all public actions)
- Do NOT see other outer agents' notes
- Can send a secret note to their paired inner agent at any time, independent of the turn-taking system
- Never speak publicly — they communicate exclusively through private notes
- Act as strategic counsel, devil's advocate, or second-opinion source for their partner

**Users (full observability):**
- The complete transcript shows all messages AND all secret notes
- Notes are labeled with sender, recipient, and timestamp
- Users see everything; agents see only what the visibility rules permit

**Implementation touchpoints:**
- Modify the context-building logic in `packages/core/src/council.ts` to enforce per-agent visibility: each inner agent's prompt/context only includes public messages + their own received notes
- Each outer agent's context only includes public messages — they don't see other outer agents' notes or their inner agent's private reactions to notes
- Add a new message type `"secret-note"` to `SessionMessage` in `apps/desktop/src/services/sessions.ts` with `fromAgentId` (outer) and `toAgentId` (inner)
- Outer agents are NOT eligible for the bidding system — they bypass it entirely. Their notes can arrive at any time as async injections

### 1.3 Home Page Redesign

The current home page (`apps/desktop/src/pages/Home.tsx`) centers on a hero section with "COUNCIL CHAMBER", "Let the council work." text, suggestion chips, and a right-side Council Rack showing the 8 agents. This layout is replaced.

**New home page layout (top to bottom in the main content area):**

1. **"COUNCIL CHAMBER"** heading — retains the current small-caps style, moves to the top of the main content area (no longer vertically centered)
2. **App logo** (the CouncilMark component) — moves up, positioned slightly below the Council Chamber heading. Smaller than current placement — it's a brand mark, not the hero
3. **The Circle** — the primary visual centerpiece. All 16 agents are arranged in two concentric rings:
   - **Inner ring:** 8 agent avatars (George, Cathy, Grace, Douglas, Kate, Quinn, Mary, Zara) arranged in a circle, evenly spaced at 45-degree intervals. Full-size, full-opacity avatars with provider-colored border glow
   - **Outer ring:** 8 agent avatars (Gavin, Celeste, Gideon, Diana, Kira, Quentin, Marcus, Zane) arranged in a larger concentric circle. Each outer agent is positioned directly behind (radially outward from) its paired inner agent. Slightly smaller (80%) and reduced opacity (70%) to visually distinguish their advisory role
   - Agent name labels appear below each avatar. Provider name appears below the agent name in smaller, muted text
   - The circle is static on the home page — a roster display, not yet animated
4. **Input area** — the topic input box, attachment button ("+" icon), and "Open Session" button remain at the bottom of the main content area. Suggestion chips remain below the input

**Removed from the home page:**
- "Let the council work." hero heading and "Every thread is autosaved locally..." subtitle text
- The right-side "Council Rack" sidebar panel — the circle visualization replaces it entirely as the agent roster display

**Unchanged:**
- Left sidebar (projects, sessions list, settings) remains as-is
- Top-right status bar (Providers Ready, Autosave status) remains as-is

**Implementation touchpoints:**
- Rewrite the main content area of `Home.tsx` — remove the hero section and Council Rack, replace with the new stacked layout (heading → logo → circle → input)
- Create a new `CouncilCircle` component (e.g., `apps/desktop/src/components/CouncilCircle.tsx`) that renders the concentric ring layout. This component will be reused (in animated form) during discussions
- Agent avatars in the circle use the existing `ProviderIcons` from `apps/desktop/src/components/icons/ProviderIcons.tsx`
- The circle needs to be responsive — scale down proportionally on smaller windows while keeping avatars identifiable

### 1.4 Discussion Start Animation

When the user types a topic and clicks "Open Session":

1. **Chrome fade** (~400ms) — the left sidebar, top status bar, input suggestion chips, and all text above the circle fade to near-invisible (opacity → 0.05). They are still there and can be accessed on hover, but visually they disappear
2. **Ambient lighting activates** — the dark background transitions from static to alive: slow-moving light particles appear, flowing in gentle streams across the background. Subtle, nebula-like luminance shifts. These persist throughout the entire session. Implemented via the existing `Starfield` component (`apps/desktop/src/components/Starfield.tsx`) enhanced with additional flowing-light effects, or a new `AmbientBackground` component
3. **Circle magnification** (~800ms) — the council circle smoothly scales up (e.g., 1.0 → 1.6x) and centers itself vertically in the viewport. Agent avatars grow to their active-discussion size. The transition is eased (ease-in-out). The inner ring agents gain a brighter idle glow. The outer ring agents stay dimmer
4. **Layout shift** — the viewport reorganizes into the three-zone discussion layout (History Zone → Circle → Input Zone, described in 1.5). The history zone is initially empty. The input area fades back in at the bottom with the topic already submitted
5. **Agent activation** — inner agent avatars subtly pulse once to indicate readiness. A brief ripple of light runs around the inner ring. The first bidding round begins

The entire transition should feel cinematic — a deliberate shift from lobby to chamber. Total transition time: approximately 1.5–2 seconds.

**Implementation touchpoints:**
- Add transition state management (e.g., `"home" | "transitioning" | "discussion"`) to the session flow
- CSS/Framer Motion animations for the fade, scale, and layout transitions
- The `CouncilCircle` component needs to support both a "static" mode (home page) and an "active" mode (discussion) with different sizing, glow, and animation states

### 1.5 The Circle — In-Discussion Layout

During active discussion, the main content area is divided into three vertical zones:

```
┌─────────────────────────────────────────────────────────┐
│                    HISTORY ZONE                         │
│  Scrollable upward. Latest messages at the bottom.      │
│                                                         │
│  00:00:12  ┌─────────────────────────────────────────┐  │
│            │ [George avatar] George                   │  │
│            │ Message text in standard chat format...  │  │
│            └─────────────────────────────────────────┘  │
│  00:00:34  ┌─────────────────────────────────────────┐  │
│            │ [Cathy avatar] Cathy                     │  │
│            │ Response text...                         │  │
│            └─────────────────────────────────────────┘  │
│  00:00:35  ┌─────────────────────────────────────────┐  │
│            │ 🔒 Secret note: Celeste → Cathy          │  │
│            │ Note content (visible to user only)...   │  │
│            └─────────────────────────────────────────┘  │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│               THE COUNCIL CIRCLE                        │
│                                                         │
│        Gavin    Celeste    Gideon                        │
│           ○        ○        ○                           │
│     Zane ○  George  Cathy  Grace  ○ Diana               │
│           ●        ●        ●                           │
│                                                         │
│    Marcus ○  ┌─────────────────┐  ○ Kira                │
│     Mary  ●  │  Active message │  ●  Kate               │
│              │  streaming here │                        │
│              │  (200-300 words │                        │
│              │  capacity)      │                        │
│              └─────────────────┘                        │
│           ●        ●        ●                           │
│     Zara ○  Quinn   Mary  Douglas  ○ Quentin            │
│           ○        ○        ○                           │
│        Zane    Marcus    Diana                           │
│                                                         │
├─────────────────────────────────────────────────────────┤
│                    INPUT ZONE                           │
│  Topic input / follow-up box       [Send]               │
└─────────────────────────────────────────────────────────┘
```

*(The diagram is schematic — actual layout uses circular positioning with proper geometry.)*

**Circle sizing:** The circle must be large enough that the center area comfortably renders 200–300 words of streaming text at a readable font size (~14–16px). Agent avatars sit at the perimeter and must not overlap with the text area. On a 1440p display, the circle diameter should be approximately 500–600px, with the text area occupying roughly the inner 60%.

**Active speaker indication:** When an inner agent is speaking, their avatar:
- Pulses with a brighter, larger glow in their provider color
- A subtle radial line (or light beam) connects the avatar to the text area, indicating source
- Other inner agents dim slightly during this time

**Outer agent note indicator:** When an outer agent sends a note:
- A brief arc of light particles flows from the outer avatar to its paired inner avatar (~500ms)
- The note content then appears in the circle center with distinct visual treatment (see 1.6)
- The inner agent's avatar briefly flickers to indicate receipt

**Implementation touchpoints:**
- The `CouncilCircle` component handles all avatar positioning using CSS transforms (rotate + translate for circular layout) or an SVG/Canvas overlay
- The text area in the circle center is a standard React component that receives streamed content — similar to how `Chat.tsx` currently renders streaming messages, but positioned in the circle center
- Three-zone layout can be a CSS Grid or Flex layout with the circle in a fixed/sticky middle position

### 1.6 Message Bubble Lifecycle

Every message and action that occurs in the circle follows a five-phase lifecycle:

**Phase 1 — Streaming** (variable duration, depends on response length)
- The message text streams token-by-token in the center of the circle
- The speaking agent's avatar is highlighted (bright glow + connecting line)
- For secret notes: the text streams with distinct styling — slightly dimmed, italic, with a lock icon and "Secret note from [outer] → [inner]" header
- For tool calls: a compact summary card appears (tool name, query, status)
- For reactions: a smaller, emoji-sized element appears
- The streaming text auto-scrolls within the circle's text area if it exceeds the visible area

**Phase 2 — Bubble formation** (~600ms)
- When streaming completes, the text coalesces into a bubble
- **Light-on animation:** particles of light gather from the edges of the circle, converging toward the center. They merge with the text to form a glowing, translucent, slightly rounded container — the bubble. The bubble has:
  - A soft, translucent fill with a glass-like quality
  - A glow border tinted to the speaking agent's provider color (e.g., green-tinted for OpenAI/George, purple-tinted for Anthropic/Cathy)
  - The complete message text rendered inside
- For shorter messages (reactions, tool summaries): the bubble is proportionally smaller
- For secret notes: the bubble has a distinct border style (e.g., dashed outline, gold-tinted glow)

**Phase 3 — Dwell** (5 seconds)
- The bubble stays nearly stationary in the circle center
- Slight floating drift — a gentle, slow sine-wave movement (2–3px amplitude) like a soap bubble hovering. Not distracting, just alive
- This gives the user time to read the message. During dwell, the next agent's bidding round can proceed in the background — pipelining so the discussion doesn't stall waiting for the visual cycle
- If the user scrolls or interacts with the bubble during dwell, the dwell timer can be paused or extended

**Phase 4 — Float** (~1–1.5s)
- The bubble begins ascending toward the history zone
- Smooth ease-out trajectory — starts slow, accelerates slightly, then decelerates as it approaches the boundary
- The bubble may slightly shrink during ascent (e.g., scale to 0.85x)
- Opacity decreases slightly near the top
- While floating, the circle center is cleared and the next message can begin streaming (overlap is fine — the floating bubble is in transit above while new content appears below)

**Phase 5 — Pop and condensation** (~300ms)
- When the bubble reaches the boundary of the history zone, it pops
- **Pop animation:** the bubble surface shatters into small light particles that scatter outward and fade. Brief, satisfying, not overdone
- Simultaneously, the message content materializes in the history zone as a standard chat message:
  - Agent avatar (small, inline)
  - Agent name
  - Full message text
  - Timestamp on the timeline
- The condensed message fades in (~200ms) as the pop particles fade out

**All action types follow this lifecycle**, not just text messages:
- Agent text responses → full bubble
- Secret notes → bubble with dashed/gold border and lock icon
- Reactions (agree, disagree, challenge) → small bubble, brief dwell (2 seconds instead of 5)
- Tool invocations (web search, file search) → compact card bubble
- Moderator nudges → bubble with a neutral/white tint
- Bidding results → compact info bubble (winner announcement), very brief dwell (1 second)

**Implementation touchpoints:**
- Create a `MessageBubble` component that encapsulates the full lifecycle as a state machine: `streaming → forming → dwelling → floating → popping → done`
- CSS animations (or Framer Motion / React Spring) for the formation, drift, float, and pop effects
- Particle effects for bubble formation and pop can use a lightweight canvas overlay or CSS-only pseudo-elements for performance
- The bubble must be rendered in a layer above the circle but below the history zone to allow proper visual stacking during float
- Performance consideration: only one bubble should be in the streaming/dwelling phase at a time. Multiple bubbles can be in float simultaneously (if messages are rapid)

### 1.7 History Zone and Timeline

The history zone sits above the circle. It is the permanent, scrollable record of the debate — the stable reference while the circle is the live stage.

**Layout:**
- **Left column — Timeline:** a vertical timeline showing timestamps precise to the second (e.g., `00:01:23`, `00:02:47`). Each message and action gets a timestamp entry. Monospace font, subtle color (muted gray or dim provider color). The timeline visually connects messages with a thin vertical line. Timestamps align with the top of each message card
- **Right column — Messages:** standard chat message cards identical to the current transcript format:
  - Agent avatar (small, round)
  - Agent name (provider-colored)
  - Full message text (rendered Markdown)
  - For secret notes: visually marked as private — lock icon, "Secret note from [outer] → [inner]" label, slightly different background tint (e.g., subtle gold or dim overlay)
  - For tool calls: collapsible tool result card
  - For reactions: inline reaction badge
- **Dividers:** subtle timestamp dividers when there's a gap of 30+ seconds between messages, showing the elapsed time

**Scroll behavior:**
- New messages appear at the bottom of the history zone (closest to the circle boundary) as bubbles pop and condense
- Auto-scroll keeps the latest message visible unless the user has manually scrolled upward to review earlier messages
- When the user scrolls up, a "Jump to latest" button appears at the bottom of the history zone
- The history zone takes up roughly the top 40% of the viewport. The circle takes 45%. The input zone takes 15%. These proportions should be adjustable (draggable divider between history and circle, or a collapse/expand toggle)

**Virtualized rendering:** The history zone must handle arbitrarily long debates (hundreds of messages). Use a virtualized list (the app already uses Virtuoso in `Chat.tsx`) to only render visible messages. This is critical for performance.

**Implementation touchpoints:**
- Adapt the existing Virtuoso-based message list from `Chat.tsx` for the history zone, adding the timeline column on the left
- The timeline component is new — a simple vertical bar with timestamp labels at each message's y-position
- Secret notes need a new visual treatment in the message list (lock icon, label, background tint)
- The "pop" animation connects the bubble system (1.6) to the history system (1.7) — when a bubble pops, the history zone appends the corresponding message card with a fade-in

### 1.8 Secret Note Mechanics

Secret notes are the defining asymmetry of the inner/outer circle system.

**Triggering:** Outer agents decide autonomously when to send a note. Their system prompt instructs them to:
- Observe the full public discussion as it unfolds
- Identify moments where their inner partner could benefit from a private strategic input
- Send notes containing: counterarguments the inner agent hasn't considered, additional evidence or framing, warnings about logical vulnerabilities in their position, suggested rhetorical strategies, or challenges to keep the inner agent sharp
- Be selective — notes should be high-value, not a running commentary. The system prompt should guide outer agents to send 2–5 notes per debate on average, not one per turn

**Outer agent invocation:** Outer agents are not part of the bidding system. Instead, they run on a parallel loop:
- After each inner agent message lands (any inner agent, not just their partner), each outer agent evaluates whether to send a note
- The orchestration layer calls each outer agent with the current public transcript and asks: "Do you have a note for [inner partner name]? Respond with the note content, or respond with PASS if you have nothing to add right now."
- If the outer agent responds with content (not PASS), the note is delivered. If PASS, nothing happens. This keeps the outer agents lightweight — most invocations result in PASS
- To avoid blocking the main discussion flow, outer agent evaluations run asynchronously in parallel with the next bidding round

**Delivery:**
1. The note is injected into the paired inner agent's context as a system-level private message: `"[Secret note from your advisor {outer_name}]: {note_content}"`
2. The inner agent sees it in their next turn's context. It is clearly labeled so the inner agent knows it came from their advisor
3. No other agent's context includes this note — it does not exist in their view of the conversation
4. The user sees the note in the circle (bubble lifecycle with secret-note styling) and in the history zone transcript

**Context isolation (critical):**
- Each inner agent's context = public messages + their own received notes. No other notes
- Each outer agent's context = public messages only. They don't see other outer agents' notes, and they don't see whether their own notes influenced their inner partner's responses
- No agent is informed that other pairs have an inner/outer relationship. From any single agent's perspective, they are either debating publicly (inner) or advising privately (outer) — they don't know the full structure

**Cost implications:** Outer agents process the full public transcript on each evaluation. With 8 outer agents evaluating after each of ~20–30 inner messages, this adds significant inference cost. Mitigations:
- PASS responses are short (minimal output tokens)
- Outer agents use the same model as their inner partner, so no additional API key is needed
- The cost tracker in `packages/core/src/cost.ts` must be updated to track outer agent usage separately (labeled as advisory cost vs. discussion cost) so users understand the cost breakdown
- Consider an optional "economy mode" where outer agents only evaluate every 3rd message instead of every message

**Implementation touchpoints:**
- New orchestration logic in `packages/core/src/council.ts`: after each inner message lands, trigger async outer agent evaluations
- New message type in sessions.ts: `"secret-note"` with `fromAgentId`, `toAgentId`, `content`
- Context builder must filter messages per agent according to visibility rules
- Cost tracking update in `packages/core/src/cost.ts` to separate inner vs. outer costs
- The outer agent evaluation loop must not block the inner agent bidding/turn-taking pipeline

### 1.9 Styling and Visual Design

The visual overhaul must maintain the current dark, professional aesthetic while adding cinematic polish. Every new visual element should feel like a natural extension of the existing design language.

**Ambient background:**
- Deep dark base color (the current near-black, `--bg-primary` or equivalent)
- Slow-moving light particles: small, soft-edged dots drifting at ~0.5–1px/frame in gentle, curved paths. Low density (30–50 particles). Muted colors (blues, teals, dim whites) matching the current accent palette
- Subtle luminance flows: very faint, large-area brightness shifts that move like aurora or nebula. Opacity 0.03–0.06 — barely perceptible but adding life to the background
- Optional reactivity: particle speed or density increases slightly during high-conflict moments (conflict score > threshold). This is subtle, not distracting
- Implemented as a Canvas element behind the main UI (extending or replacing the current `Starfield` component)

**Agent avatars:**
- Use existing provider icons from `ProviderIcons.tsx`
- Inner agents: full-size (48–56px in the circle, 24px in history), 100% opacity, with a circular border glow in their provider color. The glow is soft (blur 8–12px, opacity 0.4)
- Outer agents: 80% the size of inner agents, 70% opacity, positioned radially outward from their paired inner agent. Their glow is dimmer (opacity 0.2)
- Active speaker (inner): glow intensifies (opacity 0.8, blur 16px), avatar scales up slightly (1.1x), and a subtle pulse animation plays (1 cycle per second). A faint radial line connects the avatar to the circle center
- Idle inner agents: steady, soft glow. No animation
- Outer agent sending a note: brief brightening of their avatar (opacity jumps to 100% for ~500ms) and the particle arc to their inner partner

**Bubble visuals:**
- Translucent fill: `rgba(provider_color, 0.08)` with a `backdrop-filter: blur(4px)` for glass effect
- Border: 1px solid `rgba(provider_color, 0.3)` with `box-shadow: 0 0 12px rgba(provider_color, 0.15)`
- Text inside: standard message font, high contrast against the translucent fill
- Secret note bubbles: dashed border, gold-tinted glow (`rgba(255, 200, 50, 0.2)`) instead of provider color, lock icon in the top-left
- Reaction bubbles: smaller (max 80px), centered emoji or reaction text, no border — just a soft glow
- Tool call bubbles: compact card with tool icon, query text, and status indicator

**Note-passing arc:**
- SVG or Canvas line drawn as a curved arc from outer avatar to inner avatar
- The arc is drawn progressively over ~500ms (stroke-dashoffset animation)
- Small light particles travel along the arc path
- Color: gold or white, distinct from the provider colors used in the main discussion
- The arc fades out after the note begins streaming in the circle center

**Transitions and animation timing:**
- Home → discussion transition: 1.5–2s total (400ms chrome fade + 800ms circle scale + 300ms layout shift + settling)
- Bubble formation: 600ms (particle convergence + glow build)
- Bubble dwell: 5000ms (slight sine drift, amplitude 2–3px)
- Bubble float: 1000–1500ms (ease-out upward)
- Bubble pop: 300ms (particle scatter)
- History condensation: 200ms (fade-in)
- All animations use `ease-in-out` or custom spring curves. No linear transitions — everything should feel organic

**Typography:**
- Circle streaming text: 15–16px, medium weight, high contrast. Line height 1.5 for readability
- History zone messages: 14px (current chat font size)
- Timeline timestamps: 11–12px monospace, muted color (opacity 0.5)
- Agent names in the circle: 11px, semi-bold, positioned below avatars
- Provider labels: 10px, muted, below agent names

**Color palette (extending current):**
- OpenAI (George/Gavin): green `#10A37F`
- Anthropic (Cathy/Celeste): orange-amber `#D4A574`
- Google (Grace/Gideon): blue `#4285F4`
- DeepSeek (Douglas/Diana): teal `#00B4D8`
- Kimi (Kate/Kira): dark blue `#1A1A2E`
- Qwen (Quinn/Quentin): purple `#7C3AED`
- MiniMax (Mary/Marcus): red `#E74C3C`
- Z.AI (Zara/Zane): cyan `#06B6D4`
- Secret notes: gold accent `#F5C542`
- Moderator: neutral white/gray

**Responsiveness:**
- Minimum window size: 1024×768. Below this, the circle may collapse to a compact mode (agent names hidden, avatars only)
- Circle diameter scales proportionally with viewport height (the circle must always fit between the history zone and input zone)
- On larger displays (2560+), more spacing between avatars and larger text area in the circle center
- The history/circle proportion split can be adjusted by the user (drag handle or toggle)

### 1.10 Implementation Scope Summary

This feature touches every layer of the app:

| Layer | Files affected | Nature of change |
|-------|---------------|------------------|
| **Types** | `packages/shared/src/types/index.ts` | Add outer agent IDs, `role` field, `pairedWith` field, `"secret-note"` message type |
| **Constants** | `packages/shared/src/constants/index.ts` | Add 8 outer agents to `DEFAULT_AGENTS`, add outer agent system prompts |
| **Core orchestration** | `packages/core/src/council.ts` | Add outer agent evaluation loop, context isolation logic, async note injection |
| **Bidding** | `packages/core/src/bidding.ts` | Exclude outer agents from bidding eligibility |
| **Cost tracking** | `packages/core/src/cost.ts` | Separate inner vs. outer cost accounting |
| **Home page** | `apps/desktop/src/pages/Home.tsx` | Full layout rewrite — hero section → circle layout |
| **Chat page** | `apps/desktop/src/pages/Chat.tsx` | Three-zone layout, integrate circle and bubble system, transition animation |
| **New components** | `apps/desktop/src/components/CouncilCircle.tsx` | Concentric ring layout, avatar positioning, active states |
| | `apps/desktop/src/components/MessageBubble.tsx` | Bubble lifecycle state machine with all animation phases |
| | `apps/desktop/src/components/HistoryTimeline.tsx` | Timeline column for the history zone |
| | `apps/desktop/src/components/AmbientBackground.tsx` | Flowing light particles and ambient effects |
| | `apps/desktop/src/components/NoteArc.tsx` | SVG/Canvas arc animation for secret note delivery |
| **Styles** | `apps/desktop/src/styles/globals.css` + component CSS | All new animations, transitions, glow effects, responsive rules |
| **Sessions** | `apps/desktop/src/services/sessions.ts` | Add `"secret-note"` message type with `fromAgentId`/`toAgentId` |

---

## 2. Structured Debate Formats

Move beyond free-form discussion. Add debate modes that impose structure on how agents take turns and interact:

- **Oxford-style** — proposition vs. opposition, timed rounds, formal vote at the end
- **Red Team / Blue Team** — adversarial split with defined roles (attack/defend)
- **Round Robin** — every agent speaks exactly once per round before anyone repeats
- **Bracket** — pairwise elimination (agents argue head-to-head, losers eliminated by vote)
- **Socratic Questioning** — one agent only asks probing questions, others must justify their positions

These formats pair naturally with the inner/outer circle system. In Red Team / Blue Team, inner agents on opposite sides argue while their outer advisors feed them tactical notes. In Oxford-style, outer agents can coach their inner partners between rounds. The debate format shapes the public discussion; the secret note channel adds a strategic layer beneath it.

## 3. Structured Decision Artifacts

Turn the end state of a debate into actionable documents, not just transcripts. Most users don't actually want to read a 16-agent transcript — they want something they can hand to a decision-maker or act on directly.

After a debate ends, the app generates a suite of structured artifacts:

- **Decision brief** — the council's recommendation with supporting reasoning, presented as a concise 1-2 page document
- **Dissent memo** — a dedicated write-up of minority positions and why those agents disagreed, so dissent isn't buried in the transcript
- **Assumptions ledger** — every unstated assumption the debate relied on, extracted and listed explicitly so they can be validated
- **Open questions list** — things that were raised but never resolved, flagged for follow-up
- **Recommended next actions** — concrete steps based on the debate's conclusions
- **Decision matrix** — arguments for/against, weighted by evidence quality
- **Argument map** — directed graph of claims → evidence → rebuttals, showing the logical structure of the debate
- **Advisory influence report** — unique to the inner/outer system: which outer agent notes most influenced the discussion's direction, and how (tracks whether inner agents shifted position after receiving a note)

Each artifact is generated by a synthesis pass over the full transcript — including secret notes — using a capable model. Users can choose which artifacts to generate and export them individually or as a bundle. The artifacts become first-class objects in the session, not just export formatting options.

## 4. RAG-Powered Debates (Knowledge Base Integration)

Let users upload a document corpus that agents reference during debate. Instead of just DuckDuckGo search, agents query a local vector index of user-provided documents — research papers, company docs, legal texts, internal wikis, prior debate transcripts.

This makes debates grounded in specific evidence rather than general model knowledge. An agent arguing about your company's architecture can cite your actual design docs. An agent analyzing a legal question can reference the specific statutes you uploaded.

Use an embedded vector DB (SQLite-vec, LanceDB, or similar) to keep everything local-first. The knowledge base is per-project, so different research areas maintain separate corpora. Agents cite sources with page numbers and quotes, and those citations link back to the original documents.

Both inner and outer agents have access to the knowledge base. Outer agents can surface relevant documents in their secret notes that inner agents might have missed.

## 5. Evaluation and Replay Lab

The app already tracks cost, conflict, logs, and exports per session — but there's no way to compare runs. The evaluation lab adds controlled experimentation to the debate engine.

Core capabilities:

- **Scenario pinning** — save a topic + attachments + knowledge base as a fixed scenario that can be rerun
- **Variable sweeps** — rerun the same scenario while changing one variable (swap a model, change a system prompt, enable/disable outer agents, change debate format)
- **Side-by-side diff** — view two or more runs in parallel, with differences highlighted
- **Scoring dimensions** — rate each run on consensus quality (did agents converge?), citation quality (did they use evidence?), reasoning depth, cost efficiency, advisory influence (how impactful were outer agent notes?), and time to resolution
- **Outcome comparison** — compare the decision artifacts (briefs, dissent memos) across runs to see how changing inputs changes conclusions

This turns the app into an A/B testing lab for multi-model judgment. Useful for researchers benchmarking models, teams deciding which council configuration to standardize on, and anyone who wants to understand how sensitive a conclusion is to which models are in the room.

## 6. Cross-Session Agent Memory

Agents remember prior debates. When debating a follow-up topic, agents can reference conclusions from previous sessions. "As we established in our discussion on X, the consensus was..." This enables multi-session research workflows where the council progressively deepens its understanding of a complex domain.

Memory is scoped per-project: agents remember debates within the same project but don't leak context across unrelated projects. The memory layer stores key conclusions, unresolved questions, and established facts from prior sessions, and injects relevant context into agent prompts when a new session starts.

Both inner and outer agents share the same memory pool for their pair — they build a shared understanding across sessions.

## 7. Sharing and Async Collaboration

Expand the app from one-user, one-session, one-window to support team workflows. This happens in two phases:

**Phase 1 — Portable session bundles.** Export a debate as a self-contained bundle (not just a flat PDF) that includes the full transcript, secret notes, attachments, citations, decision artifacts, conflict graph, and cost data. Another Socratic Council user can import the bundle and pick up where it left off. Add an annotation layer so reviewers can attach comments to specific messages, notes, or artifacts — like code review, but for debates. Bundles are just files, so sharing happens through email, Slack, shared drives — no cloud infra needed.

**Phase 2 — Interactive web viewer.** Build a lightweight read-only web viewer that renders a debate as an interactive page: expand/collapse thinking, navigate the conflict graph, view the secret note channel alongside the public discussion, browse decision artifacts. Generate this as a static site from any session — users can host it anywhere or share it as a link. This dramatically expands distribution without compromising local-first for the authoring experience.

## 8. Voice and Audio Layer

TTS output with distinct voices per agent. Each agent speaks in a different voice (leveraging provider TTS APIs — OpenAI, Google, etc.). Users can listen to debates like a podcast or panel discussion. Add speech-to-text input so users can verbally participate.

This opens a completely different UX modality — "listen to 16 AI experts debate your question while you commute." Inner agents have confident, forward-facing voices. Outer agents could have quieter, more measured tones (since their notes are whispered asides). Audio output can also be exported as a podcast-style file for sharing.

## 9. Advanced Research Tooling

Upgrade from DuckDuckGo to a proper research stack:

- **Better web search** — Tavily or Brave Search API for higher-quality, more current results
- **Academic paper search** — Semantic Scholar, arXiv, Google Scholar integration
- **Real-time data sources** — stock prices, weather, news feeds, government datasets
- **Code execution sandbox** — agents can write and run Python to verify quantitative claims, run calculations, or generate visualizations
- **Plugin API** — let users add custom tools (internal APIs, proprietary databases, domain-specific search)

This positions the app for serious research use cases. A policy council can pull live regulatory data. A technical council can execute code to verify performance claims. A financial council can query real market data. Outer agents can use research tools in their notes — surfacing evidence their inner partner hasn't seen.

## 10. Debate Analytics Dashboard

Rich post-hoc analysis across sessions. Track patterns over time:

- Which agents tend to agree/disagree (persistent alliance/rivalry mapping)
- Argument quality metrics (evidence-backed vs. assertion-only claims)
- Reasoning style fingerprints per model (verbose vs. concise, cautious vs. bold)
- Cost-effectiveness analysis (which models give the best insights per dollar, inner vs. outer cost efficiency)
- Bias detection (political lean, risk aversion, cultural framing)
- Provider reliability tracking (error rates, latency trends, downtime)
- **Advisory impact analysis** — how often do outer agent notes change the direction of the inner agent's next response? Which outer agents are most influential?

Unlike the Evaluation Lab (#5), which compares controlled reruns of the same scenario, the Analytics Dashboard looks at aggregate patterns across all sessions over time. It answers questions like "Is Celeste consistently the most impactful advisor?" and "Does Douglas shift position more than other agents after receiving notes from Diana?"

## 11. Queued and Background Councils

The current flow is entirely manual: create session, open chat, watch it run. With the inner/outer system, structured outputs, and automation focus, background execution becomes very high leverage.

Core capabilities:

- **Batch queue** — line up multiple topics and run them sequentially or in parallel with a shared budget cap ("run these 10 topics overnight, spend at most $20 total")
- **Budget-gated execution** — set per-session and per-batch cost limits; the council stops gracefully when the budget is hit. Budget includes both inner and outer agent costs
- **Watch-folder workflow** — drop a file (PDF, DOCX, URL list) into a designated folder, and a council automatically spins up to debate/analyze it using a configured preset
- **Scheduled runs** — "every Monday, rerun this market analysis with the latest data" or "re-evaluate this architecture decision quarterly"
- **Background notifications** — councils run in the background and notify the user when complete (system notification, summary email, or webhook)

This turns Socratic Council from a tool you sit in front of into one that works for you while you do other things. Pair with decision artifacts (#3) so each background run produces a clean deliverable waiting in your inbox.

---

## Release Roadmap

| Release | Theme | Features |
|---------|-------|----------|
| **v1.1** | The Literal Discussions | #1 Inner/Outer Council Circle |
| **v1.2** | Deep Research | #4 RAG Knowledge Base + #9 Advanced Research Tooling |
| **v1.3** | Structure & Deliverables | #2 Structured Debate Formats + #3 Structured Decision Artifacts |
| **v1.4** | Automation & Evaluation | #11 Queued/Background Councils + #5 Evaluation Lab |
| **v2.0** | Platform & Experience | #7 Sharing/Collaboration + #8 Voice/Audio + #6 Cross-Session Memory + #10 Analytics Dashboard |

---

# Upgrade Proposal — Security, Features, Engine, QoL (April 2026)

This section is the upgrade proposal complementing the roadmap above. Four parts: security hardening (minus CSP), new features beyond the roadmap, core engine upgrades, and reliability/QoL. All new UI surfaces are designed via the `frontend-design:frontend-design` skill; existing UI and existing API-request behavior are not modified.

## Part 1 — Critical Security Hardening (CSP skipped)

### 1.1 Migrate API keys to the OS keychain
Replace `credentials.apiKey` plaintext in localStorage (`apps/desktop/src/stores/config.ts`) with `credentials.apiKeyRef` — opaque handle. New Rust commands `secrets_put / secrets_get / secrets_delete` via the `keyring` crate (macOS Keychain / Linux libsecret / Windows Credential Manager). Frontend fetches the key just-in-time for each provider call; no long-lived in-memory copy. Migration on first launch reads the old plaintext, writes to keychain, zeros the localStorage field. No change to how requests go out.

### 1.2 Encrypt sessions and attachments at rest
Derive a 32-byte data-encryption key per install (stored in OS keychain alongside 1.1). Encrypt session JSON blobs (`apps/desktop/src/services/sessions.ts`) and IndexedDB attachments (`services/attachments.ts`) with chacha20poly1305 on save; decrypt on load. New `src-tauri/src/crypto.rs` + two IPC commands `vault_encrypt` / `vault_decrypt`.

### 1.3 Harden the Rust IPC surface
Defensive validation only — no change to request shape, headers, or semantics. Allowlist outbound hostnames (8 provider hosts + user-registered MCP/Ollama endpoints). Cap request body at 4MB. Token-bucket rate limit (200 req/min per process). `https://` required for external, `http://` only for localhost. Files: `src-tauri/src/http.rs`, new `src-tauri/src/allowlist.rs`.

### 1.4 Redact secrets from logs and errors
Redact helper in Rust strips `userinfo@` from URLs in reqwest error strings. In `apiLogger.log`, redact `Authorization: Bearer …`, `x-api-key: …`, `x-goog-api-key: …`, proxy userinfo from every payload. Files: `src-tauri/src/http.rs`, `apps/desktop/src/services/api.ts`, new `apps/desktop/src/utils/redact.ts`.

### 1.5 Re-enable the macOS sandbox and narrow fs scope
Flip `com.apple.security.app-sandbox` to true in `entitlements.plist`. Keep only `com.apple.security.network.client` + `files.user-selected.read-write`. Narrow `capabilities.json` fs write scope to `$DOCUMENT/SocraticCouncil/**` + `$DOWNLOAD/**`.

### 1.6 Code signing, notarization, and Tauri auto-updater
Apple Developer ID signing + hardened runtime + notarization in CI. Windows Authenticode. `tauri-plugin-updater` with ed25519 keypair; signed GitHub Releases manifests; non-blocking toast on launch.

### 1.7 Dependency audit in CI
New `.github/workflows/audit.yml` running `cargo audit --deny warnings` + `pnpm audit --audit-level=high` on every PR and nightly.

## Part 2 — Major Feature Additions

Every new UI surface is designed via the `frontend-design:frontend-design` skill. Existing UI is untouched.

### 2.1 Local LLM agents (Ollama / LM Studio)
New provider `packages/sdk/src/providers/ollama.ts` speaking Ollama `/api/chat` JSON-lines streaming. Model registry entries in `packages/shared/src/constants/index.ts` with `costPer1M = 0`. Settings → Local tab (new UI via skill). Agents can be assigned to the local provider like any other. Existing provider code untouched; this is additive.

### 2.2 Custom personas — user-defined agents
Settings → Agents persona library UI (new via skill): name, provider, model, system prompt, expertise keywords, paired outer persona, color/initial, temperature, maxTokens. Stored encrypted (via 1.2). Council preset picker at session launch. New `apps/desktop/src/services/personas.ts`; extend `AgentConfig` with `source: "default" | "custom"`.

### 2.3 Human-in-the-loop interjection
Cmd+I opens a floating composer (new UI via skill) mid-debate. Injection becomes a `user`-role message; next bidding round treats it as most recent. Patch `packages/core/src/memory.ts:buildContext` to prioritize user messages. Hooks into existing pause/resume.

### 2.4 Agent self-reflection (draft → critique → revise)
Gated per-agent (`reflectionMode: "off" | "light" | "deep"`). Silent draft pass, critique-with-rubric pass, then stream the revised final. Uses the same provider API contract — no request-shape changes. File: `packages/core/src/council.ts:generateAgentResponse`.

### 2.5 Inline fact-check sidecar
Cheap verifier (Haiku 4.5 / gpt-5-mini) runs in parallel with the next bid round. Extracts claims, fires `oracle.verify`, attaches badges (✓ / ⚠ / ✗). Low-confidence claims flagged for outer-agent note material. New `packages/core/src/factcheck.ts` + new `verificationBadges` message field + additive superscript UI via skill.

### 2.6 Live argument map during debate
Side panel (new UI via skill) rendering a directed graph of claims / evidence / rebuttals. Incremental LLM extraction after each message. Click node → scroll history. New `packages/core/src/argmap.ts`, new `apps/desktop/src/components/ArgumentMap.tsx`. Session gains `argumentMap: ArgGraph`.

### 2.7 Session branching
"Branch from here" on any history message (additive action via skill). Creates new session with `parentSessionId` + `parentMessageId`. Sidebar renders branches as nested children. Both show "↪ branched from …" crumb.

### 2.8 Portable session bundles (pulled forward from §7)
"Export as Bundle" — versioned zip with `session.json + attachments/ + artifacts/`. "Import Bundle" on home. Additive menu entries (no existing UI redesign).

## Part 3 — Core Engine Upgrades

Backend-only. No UI changes. No API-request shape changes.

### 3.1 Embedding-based bidding
New `packages/core/src/embed.ts` with ONNX/WASM embedder (`all-MiniLM-L6-v2`). Per-agent interest embedding (system prompt + expertise blurb). Each turn: embed context, cosine similarity → confidence. Keyword match remains fallback. Update `bidding.ts:analyzeBidContext`. Weights blend unchanged.

### 3.2 Semantic conflict detection
After existing regex threshold at 40/100, run NLI-style check with the same local embedder. Reduces false positives on quoted / nested-negation patterns. File: `packages/core/src/conflict.ts`.

### 3.3 LLM summarization for long-session memory
When working transcript exceeds token threshold, background summarization of oldest third produces a ~200-word "so far" paragraph + premise bullets. Populates `buildContext().summary`. Uses cheap model. Secret notes never visible to summarizer.

### 3.4 Cost circuit breaker + budget enforcement
`budgetPolicy: { perSession, perDay, action: "warn" | "pause" | "stop" }` in config. Council checks after every turn. Doesn't change requests — decides whether to make the next one. Small additive cost-header badge (new UI via skill); existing header unchanged.

### 3.5 Context-isolation tests for inner/outer visibility
New `packages/core/src/__tests__/contextIsolation.test.ts`: synthesized sessions with notes from every outer → every inner; assert each agent's context contains exactly allowed messages and never another pair's note. CI-enforced.

## Part 4 — Reliability & Quality-of-Life

### 4.1 React error boundaries + crash recovery
Wrap (not modify) `App.tsx` children with `<AppErrorBoundary>`; second boundary around `<ChatPage>`. Recovery panel UI via skill. Startup scan: `status === "running"` + `updatedAt` older than 90s → Resume / Completed / Delete.

### 4.2 Command palette (Cmd+K)
New floating palette (via skill). Fuzzy search over registered commands. Reuse `ConversationSearch.tsx` ranking. Existing menus unchanged.

### 4.3 Provider health / diagnostics page
New Settings → Diagnostics tab (via skill): reachability, last success/error, latency, rate-limit state, last 50 redacted log entries, "Copy diagnostics" button.

### 4.4 Telemetry opt-in (strict local-first default)
Off by default. Reports only app version, platform, redacted error class. Single HTTPS endpoint. First-launch card via skill.

## TODO — live task tracking

Tracked via the built-in task system (24 tasks, IDs 1–24). Use `TaskList` to see current state. Waves:

### Wave 1 — Security floor
- [ ] #1 1.1 Keychain
- [ ] #2 1.2 Encrypt at rest
- [ ] #3 1.3 IPC hardening
- [ ] #4 1.4 Log redaction
- [ ] #5 1.5 macOS sandbox
- [ ] #6 1.6 Signing + updater
- [ ] #7 1.7 Dep audit CI

### Wave 2 — Reliability wins
- [ ] #8 3.4 Cost circuit breaker
- [ ] #9 4.1 Error boundaries
- [ ] #10 2.3 Cmd+I interject
- [ ] #11 2.8 Bundles
- [ ] #12 3.5 Isolation tests

### Wave 3 — Quality lift
- [ ] #13 2.4 Reflection
- [ ] #14 2.5 Fact-check sidecar
- [ ] #15 3.3 Summarization

### Wave 4 — Major expansion
- [ ] #16 2.1 Local LLM (Ollama)
- [ ] #17 2.2 Custom personas

### Wave 5 — Intelligence layer
- [ ] #18 3.1 Embedding bidding
- [ ] #19 3.2 Semantic conflict
- [ ] #20 2.6 Argument map
- [ ] #21 2.7 Session branching

### Wave 6 — Polish
- [ ] #22 4.2 Command palette
- [ ] #23 4.3 Diagnostics
- [ ] #24 4.4 Telemetry opt-in

## Skill usage plan

| Skill | When |
|-------|------|
| `frontend-design:frontend-design` | Every new UI surface (2.1, 2.2, 2.3, 2.5 badges, 2.6, 2.7, 2.8, 3.4, 4.1, 4.2, 4.3, 4.4) |
| `claude-api` | 2.4 reflection, 2.5 fact-check, 3.3 summarizer |
| `superpowers:test-driven-development` | 3.5 context-isolation tests, any new core module |
| `superpowers:verification-before-completion` | End of every wave before marking items done |
| `superpowers:systematic-debugging` | Any bug mid-implementation |

## Explicit non-goals (per direction)

- **No change to existing UI.** Existing components, layouts, styles, animations untouched. All new UI is additive, designed via the `frontend-design:frontend-design` skill.
- **No change to existing API-request behavior.** No retry/backoff retrofits, no stream-resume, no provider-call refactors. Adding new providers (Ollama, fact-check model) is additive, not modification.
- **No CSP work.** Deferred.
- **No structural refactor.** Chat.tsx (5541 lines) stays. Monorepo layout stays.
