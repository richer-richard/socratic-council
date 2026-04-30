/**
 * Live argument map (schema v2) for the debate.
 *
 * Maintains a directed graph of structured fragments extracted incrementally
 * from the transcript. After each council message the caller runs
 * `updateArgumentMap(previous, fragments, source)` — the extractor is a
 * provider-agnostic completion function (Gemini 3.x by default) that returns
 * a fragment list, and the merger appends or merges them into the live graph.
 *
 * v2 (April 2026 rewrite, supersedes the 3-kind v1 schema):
 *
 *   - 9-kind node taxonomy:
 *       claim, premise, evidence, rebuttal, concession, question,
 *       assumption, definition, proposal.
 *   - 10-relation edge vocabulary:
 *       supports, rebuts, concedes, restates, refines, agrees,
 *       contradicts, depends-on, answers, addresses.
 *   - Multi-source provenance — a claim asserted by two agents merges into
 *     one node with two ArgNodeSource entries (and the new wording is added
 *     to `aliases`), instead of becoming two unrelated nodes.
 *   - Per-node `stance` polarity along an axis, `strength`, `status`
 *     (active|withdrawn|superseded), and `verification` verdict.
 *   - Per-edge `id`, `confidence` (0..1), and one-line `rationale`.
 *   - Top-level `axis`, `clusters`, `orphans`, `consolidationVersion`,
 *     `schemaVersion: 2`. Used by the consolidation pass (Phase 2) and the
 *     react-flow Graph view (Phase 3).
 *
 * Old v1 sessions migrate losslessly via `migrateArgGraphV1ToV2()`.
 *
 * The merging heuristic uses a simple bag-of-words cosine — sufficient to
 * catch "same claim, different wording" across speakers without pulling in
 * an embedding model (Salton, 1971).
 */

// ----------------------------------------------------------------------------
// Schema
// ----------------------------------------------------------------------------

export type ArgNodeKind =
  | "claim"
  | "premise"
  | "evidence"
  | "rebuttal"
  | "concession"
  | "question"
  | "assumption"
  | "definition"
  | "proposal";

export type ArgEdgeRelation =
  | "supports"
  | "rebuts"
  | "concedes"
  | "restates"
  | "refines"
  | "agrees"
  | "contradicts"
  | "depends-on"
  | "answers"
  | "addresses";

export type ArgNodeStatus = "active" | "withdrawn" | "superseded";

export interface ArgNodeSource {
  messageId: string;
  agentId: string;
  timestamp: number;
  /** Char offsets into the source message content (optional). */
  span?: { start: number; end: number };
  /** Verbatim quote from the source message (optional). */
  quote?: string;
}

export interface ArgNodeStance {
  /** Axis name (e.g. "central planning ↔ market"). */
  axis: string;
  /** -1..+1. -1 fully aligned with the FIRST pole, +1 with the SECOND. */
  polarity: number;
}

export interface ArgNodeVerification {
  verdict: "true" | "false" | "uncertain";
  /** 0..1 confidence in the verdict. */
  confidence: number;
  evidenceUrl?: string;
}

export interface ArgNode {
  id: string;
  kind: ArgNodeKind;
  /** Canonical text after merge. Earlier wordings live in `aliases`. */
  text: string;
  aliases: string[];
  /** Multi-source provenance — populated in order of first-seen. */
  sources: ArgNodeSource[];
  /** 0..1 — how load-bearing this node is. Bumped on every merging source. */
  strength: number;
  status: ArgNodeStatus;
  stance?: ArgNodeStance;
  supersededBy?: string;
  verification?: ArgNodeVerification;
  influencedBy?: { whisperId: string };
  /**
   * Compat shim — always equal to `sources[0].messageId` /
   * `sources[0].agentId`. Lets the existing (Phase 1+2) Chat.tsx and
   * ArgumentMapPanel keep reading `node.sourceMessageId` directly. The
   * Phase 3 panel rewrite reads `sources[]` and these fields can be
   * dropped at that point.
   */
  sourceMessageId: string;
  sourceAgentId: string;
}

export interface ArgEdge {
  id: string;
  from: string;
  to: string;
  relation: ArgEdgeRelation;
  /** 0..1 — extractor's or consolidator's confidence in this relation. */
  confidence: number;
  /** Optional one-line rationale shown on hover. */
  rationale?: string;
}

export interface ArgGraphAxis {
  name: string;
  poles: [string, string];
}

export interface ArgGraphCluster {
  id: string;
  label: string;
  nodeIds: string[];
}

export interface ArgGraph {
  nodes: ArgNode[];
  edges: ArgEdge[];
  /** Inferred debate axis (Phase 2 consolidator fills this in). */
  axis?: ArgGraphAxis;
  /** Camp clustering (Phase 2). */
  clusters: ArgGraphCluster[];
  /** Anchored fragments (premise/evidence/rebuttal/concession) that couldn't
   *  resolve to an existing claim id. The consolidation pass (Phase 2) tries
   *  to anchor them; otherwise they are dropped. They are NEVER promoted to
   *  free-standing claims (v1 behavior). */
  orphans: ArgNode[];
  /** Last message id incorporated, so re-runs can skip. */
  lastMessageId: string | null;
  /** Bumped each successful consolidation pass. UI uses this to memoize
   *  expensive layouts (dagre, betweenness centrality). */
  consolidationVersion: number;
  /** Pinned Graph-view positions per node id (Phase 3). */
  layoutOverrides?: Record<string, { x: number; y: number }>;
  schemaVersion: 2;
}

export function emptyGraph(): ArgGraph {
  return {
    nodes: [],
    edges: [],
    clusters: [],
    orphans: [],
    lastMessageId: null,
    consolidationVersion: 0,
    schemaVersion: 2,
  };
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const NODE_KINDS: readonly ArgNodeKind[] = [
  "claim",
  "premise",
  "evidence",
  "rebuttal",
  "concession",
  "question",
  "assumption",
  "definition",
  "proposal",
];

const EDGE_RELATIONS: readonly ArgEdgeRelation[] = [
  "supports",
  "rebuts",
  "concedes",
  "restates",
  "refines",
  "agrees",
  "contradicts",
  "depends-on",
  "answers",
  "addresses",
];

/** Fragments whose semantics imply a single primary anchor on a claim. */
const ANCHORED_KINDS: ReadonlySet<ArgNodeKind> = new Set([
  "evidence",
  "rebuttal",
  "concession",
  "premise",
]);

/** When an anchored fragment lands, generate this implicit edge. */
const ANCHOR_RELATION: Record<string, ArgEdgeRelation> = {
  evidence: "supports",
  rebuttal: "rebuts",
  concession: "concedes",
  premise: "depends-on",
};

const KIND_ID_PREFIX: Record<ArgNodeKind, string> = {
  claim: "c",
  premise: "p",
  evidence: "e",
  rebuttal: "r",
  concession: "x",
  question: "q",
  assumption: "a",
  definition: "d",
  proposal: "po",
};

/** Hard cap on fragments returned per message — keeps cost predictable. */
const MAX_FRAGMENTS = 16;

/** Cosine threshold for "same claim, different wording" merge. Above this,
 *  two claims collapse into one multi-sourced node. */
const MERGE_COSINE_THRESHOLD = 0.85;

// ----------------------------------------------------------------------------
// Extractor contract
// ----------------------------------------------------------------------------

export interface ExtractInput {
  topic: string;
  messageId: string;
  agentName: string;
  agentId: string;
  messageText: string;
  /** Council agent display names so the model can resolve "George said …"
   *  to a known agent. */
  priorAgentNames: string[];
  /** Up to ~16 most recent claims with id, text, and (optional) polarity. */
  priorClaims: Array<{ id: string; text: string; polarity?: number }>;
  /** Inferred debate axis, if known (Phase 2). */
  axis?: ArgGraphAxis;
  /** Existing cluster labels so the model can echo them. */
  clusterLabels?: string[];
  /** Open question nodes — emitted nodes can answer or address one. */
  openQuestions?: Array<{ id: string; text: string }>;
}

export interface ExtractedNodeFragment {
  kind: ArgNodeKind;
  text: string;
  /** Required for evidence / rebuttal / concession / premise — must be the
   *  EXACT id of an existing claim. Anchorless fragments become orphans. */
  targetClaim?: string;
  /** Optional stance polarity along the axis, -1..+1. */
  polarity?: number;
  /** Optional load-bearing-ness, 0..1. */
  strength?: number;
}

export interface ExtractedEdgeFragment {
  kind: "edge";
  /** Existing node id. */
  from: string;
  /** Existing node id. */
  to: string;
  relation: ArgEdgeRelation;
  /** 0..1. */
  confidence: number;
  rationale?: string;
}

export type ExtractedFragment = ExtractedNodeFragment | ExtractedEdgeFragment;

export type ExtractorCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

// ----------------------------------------------------------------------------
// Prompt
// ----------------------------------------------------------------------------

const SYSTEM_PROMPT = `You extract structured argument-map fragments from a single message in a multi-agent debate.

Output a JSON array of UP TO 16 fragments. Each element is either a node-fragment or an edge-fragment. No prose. No markdown. No code fences.

NODE KINDS — pick the most precise; fall back to "claim" only when nothing tighter fits:
  "claim"       — a stance, position, criterion, or framing the speaker commits to (one sentence).
  "premise"     — a sub-statement the speaker uses to reach a claim. Anchors to that claim.
  "evidence"    — a concrete example, number, citation, named case, or study. Anchors to the claim it backs.
  "rebuttal"    — explicit pushback against a prior claim. Anchors to the claim it rebuts.
  "concession"  — explicit acknowledgement that a counter-point has merit. Anchors to the conceded claim.
  "question"    — an open question raised but not yet answered.
  "assumption"  — an unstated belief the argument depends on, surfaced explicitly.
  "definition"  — a clarification of what a key term means in this debate.
  "proposal"    — a concrete suggested action or course of action.

NODE FRAGMENT SHAPE:
  {
    "kind": "<one of the above>",
    "text": "<one-sentence summary, ≤240 chars>",
    "targetClaim": "<exact existing claim id, e.g. c_3>",   // REQUIRED for evidence|rebuttal|concession|premise
    "polarity": <number in [-1, 1] along the named axis>,    // OPTIONAL
    "strength": <number in [0, 1]>                            // OPTIONAL
  }

EDGE FRAGMENT — a peer relation between TWO existing nodes:
  {
    "kind": "edge",
    "from": "<existing node id>",
    "to":   "<existing node id>",
    "relation": "<one of the relations below>",
    "confidence": <0..1>,
    "rationale": "<one short line>"
  }

EDGE RELATIONS:
  "supports"     — backing evidence for a claim.
  "rebuts"       — a rebuttal contradicts a claim.
  "concedes"     — a concession yields ground to a claim.
  "restates"     — same proposition, different wording.
  "refines"      — a sharper / more careful version of an earlier claim.
  "agrees"       — peer agreement (different speaker, same direction).
  "contradicts"  — logical incompatibility between two claims.
  "depends-on"   — one claim presupposes another.
  "answers"      — this fragment resolves an open question.
  "addresses"    — this fragment engages a question without fully resolving it.

CRITICAL RULES:
  1. targetClaim and edge from/to MUST be EXACT existing ids listed in the user prompt (e.g. "c_3"). Do NOT paraphrase. Do NOT invent ids. Anchorless evidence becomes an orphan, not a free-standing claim.
  2. Prefer a node-fragment for new content; emit an edge-fragment only when both endpoints already exist and you want to record a peer relationship between them.
  3. If a debate axis is named in the user prompt, use it for polarity. -1 = aligned with pole 0, +1 = aligned with pole 1. Omit polarity if uncertain.
  4. Substantive messages typically yield 2–5 fragments. Reframings, sharp distinctions, proposed criteria, and clear concessions all count — extract them.
  5. Return [] only for greetings, jokes, or off-topic chitchat. If the message advances the debate at all, extract at least one fragment.
  6. Output STRICT JSON. The array length must be ≤ 16.`;

export function buildExtractPrompt(input: ExtractInput): {
  system: string;
  user: string;
} {
  const lines: string[] = [`Topic: ${input.topic}`];

  if (input.axis) {
    lines.push("");
    lines.push(`Debate axis: ${input.axis.name}`);
    lines.push(`  Pole 0 (polarity = -1): ${input.axis.poles[0]}`);
    lines.push(`  Pole 1 (polarity = +1): ${input.axis.poles[1]}`);
  }

  if (input.clusterLabels && input.clusterLabels.length > 0) {
    lines.push("");
    lines.push(
      `Current camps: ${input.clusterLabels.map((l) => `"${l}"`).join(", ")}`,
    );
  }

  lines.push("");
  lines.push("EXISTING CLAIMS (reference these by id; do NOT paraphrase):");
  if (input.priorClaims.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const c of input.priorClaims) {
      const polarity =
        typeof c.polarity === "number"
          ? ` [polarity=${c.polarity.toFixed(2)}]`
          : "";
      lines.push(`- [${c.id}] ${c.text}${polarity}`);
    }
  }

  if (input.openQuestions && input.openQuestions.length > 0) {
    lines.push("");
    lines.push(
      "OPEN QUESTIONS (an emitted node can answer or address one of these):",
    );
    for (const q of input.openQuestions) {
      lines.push(`- [${q.id}] ${q.text}`);
    }
  }

  lines.push("");
  lines.push(`MESSAGE (from ${input.agentName}, id=${input.messageId}):`);
  lines.push(input.messageText.trim());
  lines.push("");
  lines.push("Return the JSON array of fragments now.");

  return { system: SYSTEM_PROMPT, user: lines.join("\n") };
}

// ----------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------

const NODE_KIND_SET: ReadonlySet<string> = new Set(NODE_KINDS);
const EDGE_RELATION_SET: ReadonlySet<string> = new Set(EDGE_RELATIONS);

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

export function parseExtractResponse(raw: string | null): ExtractedFragment[] {
  if (!raw) return [];
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = trimmed.match(/\[[\s\S]*\]/);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ExtractedFragment[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_FRAGMENTS) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;

    if (kind === "edge") {
      const from = typeof rec.from === "string" ? rec.from.trim() : "";
      const to = typeof rec.to === "string" ? rec.to.trim() : "";
      const relation = rec.relation;
      if (!from || !to) continue;
      if (typeof relation !== "string" || !EDGE_RELATION_SET.has(relation)) {
        continue;
      }
      const confidence =
        typeof rec.confidence === "number" ? clamp(rec.confidence, 0, 1) : 0.5;
      const rationale =
        typeof rec.rationale === "string" && rec.rationale.trim().length > 0
          ? rec.rationale.trim().slice(0, 200)
          : undefined;
      out.push({
        kind: "edge",
        from,
        to,
        relation: relation as ArgEdgeRelation,
        confidence,
        ...(rationale ? { rationale } : {}),
      });
      continue;
    }

    if (typeof kind !== "string" || !NODE_KIND_SET.has(kind)) continue;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (text.length === 0) continue;
    const targetClaim =
      typeof rec.targetClaim === "string" && rec.targetClaim.trim().length > 0
        ? rec.targetClaim.trim().slice(0, 240)
        : undefined;
    const polarity =
      typeof rec.polarity === "number" ? clamp(rec.polarity, -1, 1) : undefined;
    const strength =
      typeof rec.strength === "number" ? clamp(rec.strength, 0, 1) : undefined;
    out.push({
      kind: kind as ArgNodeKind,
      text: text.slice(0, 240),
      ...(targetClaim ? { targetClaim } : {}),
      ...(polarity !== undefined ? { polarity } : {}),
      ...(strength !== undefined ? { strength } : {}),
    });
  }
  return out;
}

// ----------------------------------------------------------------------------
// Merger
// ----------------------------------------------------------------------------

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/**
 * Bag-of-words cosine similarity (Salton, 1971). Cheap, dependency-free, and
 * good enough to catch "Nuclear is the safest source per TWh." vs. "Nuclear
 * power is the safest source per terawatt hour." as a near-duplicate.
 */
export function bagOfWordsCosine(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.length === 0 || B.length === 0) return 0;
  const counts = new Map<string, [number, number]>();
  for (const w of A) {
    const cur = counts.get(w) ?? [0, 0];
    cur[0] += 1;
    counts.set(w, cur);
  }
  for (const w of B) {
    const cur = counts.get(w) ?? [0, 0];
    cur[1] += 1;
    counts.set(w, cur);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const pair of counts.values()) {
    const ca = pair[0];
    const cb = pair[1];
    dot += ca * cb;
    na += ca * ca;
    nb += cb * cb;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function generateNodeId(graph: ArgGraph, kind: ArgNodeKind): string {
  const prefix = KIND_ID_PREFIX[kind];
  const used = new Set(graph.nodes.map((n) => n.id).concat(graph.orphans.map((n) => n.id)));
  let i = graph.nodes.length;
  while (true) {
    const candidate = `${prefix}_${i}`;
    if (!used.has(candidate)) return candidate;
    i += 1;
  }
}

function generateEdgeId(graph: ArgGraph): string {
  const used = new Set(graph.edges.map((e) => e.id));
  let i = graph.edges.length;
  while (true) {
    const candidate = `ed_${i}`;
    if (!used.has(candidate)) return candidate;
    i += 1;
  }
}

function findClaimByReference(graph: ArgGraph, ref: string | undefined): ArgNode | null {
  if (!ref) return null;
  const idCandidate = ref.replace(/^\[|\]$/g, "").trim();
  const byId = graph.nodes.find((n) => n.kind === "claim" && n.id === idCandidate);
  if (byId) return byId;

  // v1's lenient substring match (Fix 5.13) — kept for backwards compat
  // with extractors that paraphrase the target. Only attaches when there's
  // exactly one reasonably-sized substring match.
  const needle = ref.toLowerCase();
  const candidates = graph.nodes.filter(
    (n) => n.kind === "claim" && n.text.toLowerCase().includes(needle),
  );
  if (candidates.length === 1) {
    const cand = candidates[0]!;
    const shorter = Math.min(cand.text.length, needle.length);
    const longer = Math.max(cand.text.length, needle.length);
    if (longer === 0 || shorter / longer >= 0.4) return cand;
  }
  return null;
}

/** Returns the existing claim node a new claim should merge into, or null. */
function findClaimMergeTarget(graph: ArgGraph, text: string): ArgNode | null {
  const lower = text.toLowerCase();
  const exact = graph.nodes.find(
    (n) =>
      n.kind === "claim" &&
      (n.text.toLowerCase() === lower ||
        n.aliases.some((a) => a.toLowerCase() === lower)),
  );
  if (exact) return exact;
  for (const n of graph.nodes) {
    if (n.kind !== "claim") continue;
    if (bagOfWordsCosine(n.text, text) >= MERGE_COSINE_THRESHOLD) return n;
    for (const alias of n.aliases) {
      if (bagOfWordsCosine(alias, text) >= MERGE_COSINE_THRESHOLD) return n;
    }
  }
  return null;
}

function makeNode(
  graph: ArgGraph,
  frag: ExtractedNodeFragment,
  source: { messageId: string; agentId: string; whisperId?: string },
  ts: number,
): ArgNode {
  const id = generateNodeId(graph, frag.kind);
  const node: ArgNode = {
    id,
    kind: frag.kind,
    text: frag.text,
    aliases: [],
    sources: [{ messageId: source.messageId, agentId: source.agentId, timestamp: ts }],
    strength: typeof frag.strength === "number" ? frag.strength : 0.5,
    status: "active",
    sourceMessageId: source.messageId,
    sourceAgentId: source.agentId,
  };
  if (typeof frag.polarity === "number") {
    node.stance = {
      axis: graph.axis?.name ?? "",
      polarity: frag.polarity,
    };
  }
  if (source.whisperId) {
    node.influencedBy = { whisperId: source.whisperId };
  }
  return node;
}

export function updateArgumentMap(
  previous: ArgGraph,
  fragments: ExtractedFragment[],
  source: {
    messageId: string;
    agentId: string;
    timestamp?: number;
    /** When set, every new node produced by this call is tagged with
     *  influencedBy.whisperId — Phase 4 of the argmap rewrite. */
    whisperId?: string;
  },
): ArgGraph {
  const next: ArgGraph = {
    ...previous,
    nodes: [...previous.nodes],
    edges: [...previous.edges],
    orphans: [...previous.orphans],
    clusters: [...previous.clusters],
    lastMessageId: source.messageId,
  };
  const ts = source.timestamp ?? Date.now();

  for (const frag of fragments) {
    if (frag.kind === "edge") {
      const fromExists = next.nodes.some((n) => n.id === frag.from);
      const toExists = next.nodes.some((n) => n.id === frag.to);
      if (!fromExists || !toExists) continue; // unknown endpoint → drop
      const dup = next.edges.find(
        (e) => e.from === frag.from && e.to === frag.to && e.relation === frag.relation,
      );
      if (dup) continue;
      next.edges.push({
        id: generateEdgeId(next),
        from: frag.from,
        to: frag.to,
        relation: frag.relation,
        confidence: frag.confidence,
        ...(frag.rationale ? { rationale: frag.rationale } : {}),
      });
      continue;
    }

    // Anchored kinds (evidence/rebuttal/concession/premise) need a target.
    if (ANCHORED_KINDS.has(frag.kind)) {
      const target = findClaimByReference(next, frag.targetClaim);
      if (!target) {
        // v2: stage as orphan instead of promoting to claim. The
        // consolidation pass (Phase 2) tries to anchor; otherwise dropped.
        next.orphans.push(makeNode(next, frag, source, ts));
        continue;
      }
      const node = makeNode(next, frag, source, ts);
      next.nodes.push(node);
      const relation = ANCHOR_RELATION[frag.kind] ?? "supports";
      next.edges.push({
        id: generateEdgeId(next),
        from: node.id,
        to: target.id,
        relation,
        confidence: 0.85,
      });
      continue;
    }

    // Standalone kinds — claim/question/assumption/definition/proposal.
    // Claims merge across speakers via cosine-similarity; other kinds
    // dedupe per-author by exact lowercase text.
    if (frag.kind === "claim") {
      const merge = findClaimMergeTarget(next, frag.text);
      if (merge) {
        const newSource: ArgNodeSource = {
          messageId: source.messageId,
          agentId: source.agentId,
          timestamp: ts,
        };
        const sourceDupe = merge.sources.some(
          (s) => s.messageId === newSource.messageId && s.agentId === newSource.agentId,
        );
        if (!sourceDupe) merge.sources.push(newSource);
        const aliasLower = frag.text.toLowerCase();
        const existsAsTextOrAlias =
          merge.text.toLowerCase() === aliasLower ||
          merge.aliases.some((a) => a.toLowerCase() === aliasLower);
        if (!existsAsTextOrAlias) merge.aliases.push(frag.text);
        // Each confirming source bumps strength a notch (caps at 1).
        merge.strength = Math.min(1, merge.strength + 0.1);
        if (typeof frag.polarity === "number") {
          merge.stance = {
            axis: next.axis?.name ?? merge.stance?.axis ?? "",
            polarity: frag.polarity,
          };
        }
        continue;
      }
      next.nodes.push(makeNode(next, frag, source, ts));
      continue;
    }

    // question / assumption / definition / proposal — per-author dedupe.
    const sameAuthorDupe = next.nodes.find(
      (n) =>
        n.kind === frag.kind &&
        n.sourceAgentId === source.agentId &&
        n.text.toLowerCase() === frag.text.toLowerCase(),
    );
    if (sameAuthorDupe) continue;
    next.nodes.push(makeNode(next, frag, source, ts));
  }

  return next;
}

// ----------------------------------------------------------------------------
// v1 → v2 migration
// ----------------------------------------------------------------------------

interface ArgGraphV1Node {
  id: string;
  kind: "claim" | "evidence" | "rebuttal";
  text: string;
  sourceMessageId: string;
  sourceAgentId: string;
}

interface ArgGraphV1Edge {
  from: string;
  to: string;
  relation: "supports" | "rebuts";
}

function isV1Node(raw: unknown): raw is ArgGraphV1Node {
  if (!raw || typeof raw !== "object") return false;
  const n = raw as Partial<ArgGraphV1Node>;
  return (
    typeof n.id === "string" &&
    n.id.length > 0 &&
    (n.kind === "claim" || n.kind === "evidence" || n.kind === "rebuttal") &&
    typeof n.text === "string" &&
    n.text.length > 0 &&
    typeof n.sourceMessageId === "string" &&
    typeof n.sourceAgentId === "string"
  );
}

function isV1Edge(raw: unknown): raw is ArgGraphV1Edge {
  if (!raw || typeof raw !== "object") return false;
  const e = raw as Partial<ArgGraphV1Edge>;
  return (
    typeof e.from === "string" &&
    typeof e.to === "string" &&
    (e.relation === "supports" || e.relation === "rebuts")
  );
}

/**
 * Lossless lift of a v1 graph blob to the v2 schema. Each v1 node maps to a
 * v2 node with strength 0.5, status "active", a single source with
 * timestamp 0, and empty aliases / no stance / no verification. v1 edges
 * map 1:1 with confidence 0.85 and a generated id. The result has empty
 * clusters / orphans / no axis and consolidationVersion 0.
 *
 * Returns an `emptyGraph()` when the input is missing or unrecognizable.
 */
export function migrateArgGraphV1ToV2(input: unknown): ArgGraph {
  if (!input || typeof input !== "object") return emptyGraph();
  const v1 = input as { nodes?: unknown; edges?: unknown; lastMessageId?: unknown };

  const v1Nodes = Array.isArray(v1.nodes) ? v1.nodes.filter(isV1Node) : [];
  const nodes: ArgNode[] = v1Nodes.map((n) => ({
    id: n.id,
    kind: n.kind,
    text: n.text,
    aliases: [],
    sources: [{ messageId: n.sourceMessageId, agentId: n.sourceAgentId, timestamp: 0 }],
    strength: 0.5,
    status: "active",
    sourceMessageId: n.sourceMessageId,
    sourceAgentId: n.sourceAgentId,
  }));

  const validIds = new Set(nodes.map((n) => n.id));
  const v1Edges = Array.isArray(v1.edges) ? v1.edges.filter(isV1Edge) : [];
  const edges: ArgEdge[] = v1Edges
    .filter((e) => validIds.has(e.from) && validIds.has(e.to))
    .map((e, i) => ({
      id: `ed_${i}`,
      from: e.from,
      to: e.to,
      relation: e.relation,
      confidence: 0.85,
    }));

  const lastMessageId =
    typeof v1.lastMessageId === "string" && v1.lastMessageId.length > 0
      ? v1.lastMessageId
      : null;

  return {
    nodes,
    edges,
    clusters: [],
    orphans: [],
    lastMessageId,
    consolidationVersion: 0,
    schemaVersion: 2,
  };
}

// ----------------------------------------------------------------------------
// Consolidation pass (Phase 2)
// ----------------------------------------------------------------------------
//
// `updateArgumentMap` runs once per message and only sees the current message
// + a short prior-claims list. That myopic view can't infer the debate axis,
// merge claims that two agents reached independently, or surface contradiction
// pairs across the whole graph.
//
// `consolidateArgGraph` is the global pass: one model call that returns a
// list of structural ops (set-axis, merge, set-stance, supersede, contradicts,
// set-clusters, anchor-orphan, drop-orphan), which are applied in order.
// Candidate contradicts edges are then NLI-confirmed via
// semanticConflictCheck before being added — this keeps false positives down
// in the same way the conflict engine uses NLI today.

import { semanticConflictCheck } from "./semanticConflict.js";

export interface ConsolidationInput {
  topic: string;
  graph: ArgGraph;
  recentMessages: Array<{
    id: string;
    agentId: string;
    agentName: string;
    content: string;
    timestamp: number;
  }>;
  knownAgentNames: string[];
  /** PREMISES list pulled from `summarizeOlderMessages`, if available. The
   *  consolidator surfaces these to the model so it reuses canonical
   *  premises from older turns instead of re-deriving them. */
  seedPremises?: string[];
}

export type ConsolidationCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

interface ConsolidationOps {
  axis?: ArgGraphAxis | null;
  stances: Array<{ id: string; polarity: number }>;
  merges: Array<{ canonical: string; duplicate: string }>;
  supersessions: Array<{ supersededId: string; byId: string }>;
  candidateContradicts: Array<{
    from: string;
    to: string;
    confidence: number;
    rationale?: string;
  }>;
  clusters: ArgGraphCluster[];
  orphanResolutions: Array<{
    orphanId: string;
    anchorClaimId: string | null;
  }>;
}

const CONSOLIDATION_SYSTEM_PROMPT = `You are the consolidator for a multi-agent debate's live argument map. Your job is to look at the WHOLE graph plus the most recent messages and propose a single batch of structural updates that make the graph more coherent.

You have access to:
  - the existing nodes (claim / premise / evidence / rebuttal / concession / question / assumption / definition / proposal) with ids and text,
  - the existing edges and their relations,
  - the current axis (or none),
  - the current clusters (or none),
  - any unanchored orphan fragments staged by the per-message extractor,
  - the recent transcript so you can pick up new framing,
  - optionally a PREMISES list summarized from older turns.

Output STRICT JSON — a single object — exactly matching this shape:

{
  "axis": { "name": "<short axis label>", "poles": ["<pole 0>", "<pole 1>"] } | null,
  "stances": [{ "id": "<existing claim id>", "polarity": <-1..1> }],
  "merges":  [{ "canonical": "<existing claim id>", "duplicate": "<other existing claim id>" }],
  "supersessions": [{ "supersededId": "<earlier claim id>", "byId": "<later claim id>" }],
  "candidateContradicts": [
    { "from": "<existing claim id>", "to": "<existing claim id>", "confidence": <0..1>, "rationale": "<one short line>" }
  ],
  "clusters": [{ "label": "<short camp name>", "nodeIds": ["<claim id>", "..."] }],
  "orphanResolutions": [
    { "orphanId": "<existing orphan id>", "anchorClaimId": "<existing claim id>" } |
    { "orphanId": "<existing orphan id>", "anchorClaimId": null }
  ]
}

RULES:
  1. Every id must be EXACT and EXISTING — no invention, no paraphrase.
  2. Set axis only if the debate clearly has one. 1 axis is preferred. If you can't infer one with confidence, return "axis": null.
  3. "merges" should ONLY pair claims that are semantically the same proposition (≥0.85 confidence). The "canonical" id stays; the "duplicate" id is removed and its sources merged into the canonical.
  4. "supersessions" should ONLY mark a strictly sharper restatement by the SAME author. Both ids must already exist as claims.
  5. "candidateContradicts" pairs are sent through a separate NLI confirmer; emit pairs you actually believe contradict — false positives there cost a model call to reject.
  6. "clusters" should partition the active claims into 2–4 named camps. Each cluster's label should be 1–4 words. Camp labels should reflect a position taken in the debate, not a topic name.
  7. "orphanResolutions" — for each orphan, either anchor it to an existing claim id (if it really is evidence/rebuttal/concession/premise for that claim) or set anchorClaimId to null (drop it).
  8. Already-merged or already-superseded nodes are FINAL. Do not re-propose changes to them.
  9. Output STRICT JSON only. No prose. No markdown. No code fences.
 10. If the graph is already in good shape, return all sections as empty arrays / null axis. The pass is idempotent.`;

function buildConsolidationUserPrompt(input: ConsolidationInput): string {
  const { graph } = input;
  const lines: string[] = [`Topic: ${input.topic}`];
  if (input.knownAgentNames.length > 0) {
    lines.push(`Agents: ${input.knownAgentNames.join(", ")}`);
  }
  if (graph.axis) {
    lines.push("");
    lines.push(`Current axis: ${graph.axis.name}`);
    lines.push(`  Pole 0 (-1): ${graph.axis.poles[0]}`);
    lines.push(`  Pole 1 (+1): ${graph.axis.poles[1]}`);
  }
  if (graph.clusters.length > 0) {
    lines.push("");
    lines.push("Current clusters:");
    for (const c of graph.clusters) {
      lines.push(`  ${c.id} ("${c.label}"): ${c.nodeIds.join(", ")}`);
    }
  }
  if (input.seedPremises && input.seedPremises.length > 0) {
    lines.push("");
    lines.push("PREMISES from older transcript (treat as established):");
    for (const p of input.seedPremises) lines.push(`- ${p}`);
  }

  lines.push("");
  lines.push("EXISTING NODES:");
  for (const n of graph.nodes) {
    const stance =
      n.stance && typeof n.stance.polarity === "number"
        ? ` polarity=${n.stance.polarity.toFixed(2)}`
        : "";
    const status = n.status === "active" ? "" : ` status=${n.status}`;
    lines.push(
      `  [${n.id}] kind=${n.kind} agent=${n.sourceAgentId}${stance}${status} :: ${n.text}`,
    );
  }

  if (graph.edges.length > 0) {
    lines.push("");
    lines.push("EXISTING EDGES:");
    for (const e of graph.edges) {
      lines.push(`  ${e.from} --${e.relation}--> ${e.to} (conf=${e.confidence.toFixed(2)})`);
    }
  }

  if (graph.orphans.length > 0) {
    lines.push("");
    lines.push("ORPHANS (unanchored fragments awaiting resolution):");
    for (const o of graph.orphans) {
      lines.push(`  [${o.id}] kind=${o.kind} agent=${o.sourceAgentId} :: ${o.text}`);
    }
  }

  if (input.recentMessages.length > 0) {
    lines.push("");
    lines.push("RECENT MESSAGES:");
    for (const m of input.recentMessages.slice(-12)) {
      const truncated = m.content.trim().slice(0, 360);
      lines.push(`  [${m.id}] ${m.agentName}: ${truncated}`);
    }
  }

  lines.push("");
  lines.push("Return the JSON consolidation object now.");
  return lines.join("\n");
}

export function buildConsolidationPrompt(input: ConsolidationInput): {
  system: string;
  user: string;
} {
  return {
    system: CONSOLIDATION_SYSTEM_PROMPT,
    user: buildConsolidationUserPrompt(input),
  };
}

/**
 * Coerce the model's raw consolidation output into a typed op set. Returns
 * null when the response can't be parsed at all (so the caller leaves the
 * graph untouched).
 */
export function parseConsolidationResponse(
  raw: string | null,
): ConsolidationOps | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const r = parsed as Record<string, unknown>;

  const ops: ConsolidationOps = {
    stances: [],
    merges: [],
    supersessions: [],
    candidateContradicts: [],
    clusters: [],
    orphanResolutions: [],
  };

  if (r.axis === null) {
    ops.axis = null;
  } else if (r.axis && typeof r.axis === "object") {
    const a = r.axis as Partial<ArgGraphAxis>;
    if (
      typeof a.name === "string" &&
      a.name.trim().length > 0 &&
      Array.isArray(a.poles) &&
      a.poles.length === 2 &&
      typeof a.poles[0] === "string" &&
      typeof a.poles[1] === "string"
    ) {
      ops.axis = {
        name: a.name.trim().slice(0, 80),
        poles: [a.poles[0].trim().slice(0, 60), a.poles[1].trim().slice(0, 60)],
      };
    }
  }

  if (Array.isArray(r.stances)) {
    for (const raw of r.stances) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.id !== "string" || typeof s.polarity !== "number") continue;
      ops.stances.push({ id: s.id.trim(), polarity: clamp(s.polarity, -1, 1) });
    }
  }

  if (Array.isArray(r.merges)) {
    for (const raw of r.merges) {
      if (!raw || typeof raw !== "object") continue;
      const m = raw as Record<string, unknown>;
      if (typeof m.canonical !== "string" || typeof m.duplicate !== "string") continue;
      const canonical = m.canonical.trim();
      const duplicate = m.duplicate.trim();
      if (!canonical || !duplicate || canonical === duplicate) continue;
      ops.merges.push({ canonical, duplicate });
    }
  }

  if (Array.isArray(r.supersessions)) {
    for (const raw of r.supersessions) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      if (typeof s.supersededId !== "string" || typeof s.byId !== "string") continue;
      const supersededId = s.supersededId.trim();
      const byId = s.byId.trim();
      if (!supersededId || !byId || supersededId === byId) continue;
      ops.supersessions.push({ supersededId, byId });
    }
  }

  if (Array.isArray(r.candidateContradicts)) {
    for (const raw of r.candidateContradicts) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.from !== "string" || typeof c.to !== "string") continue;
      const from = c.from.trim();
      const to = c.to.trim();
      if (!from || !to || from === to) continue;
      const confidence =
        typeof c.confidence === "number" ? clamp(c.confidence, 0, 1) : 0.5;
      const rationale =
        typeof c.rationale === "string" && c.rationale.trim().length > 0
          ? c.rationale.trim().slice(0, 200)
          : undefined;
      ops.candidateContradicts.push({
        from,
        to,
        confidence,
        ...(rationale ? { rationale } : {}),
      });
    }
  }

  if (Array.isArray(r.clusters)) {
    for (const raw of r.clusters) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.label !== "string") continue;
      const label = c.label.trim().slice(0, 60);
      if (!label) continue;
      if (!Array.isArray(c.nodeIds)) continue;
      const nodeIds = c.nodeIds.filter((id): id is string => typeof id === "string");
      if (nodeIds.length === 0) continue;
      const id =
        typeof c.id === "string" && c.id.trim().length > 0
          ? c.id.trim()
          : `cluster_${ops.clusters.length}`;
      ops.clusters.push({ id, label, nodeIds });
    }
  }

  if (Array.isArray(r.orphanResolutions)) {
    for (const raw of r.orphanResolutions) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.orphanId !== "string") continue;
      const orphanId = o.orphanId.trim();
      if (!orphanId) continue;
      const anchorClaimId =
        typeof o.anchorClaimId === "string" && o.anchorClaimId.trim().length > 0
          ? o.anchorClaimId.trim()
          : null;
      ops.orphanResolutions.push({ orphanId, anchorClaimId });
    }
  }

  return ops;
}

/** Stable signature for "did anything actually change?" comparisons. */
function structuralFingerprint(graph: ArgGraph): string {
  const nodeIds = graph.nodes.map((n) => `${n.id}:${n.kind}:${n.status}:${n.text}`).join("|");
  const aliases = graph.nodes.map((n) => n.aliases.join(",")).join("|");
  const sources = graph.nodes
    .map((n) => n.sources.map((s) => `${s.messageId}/${s.agentId}`).join(","))
    .join("|");
  const stances = graph.nodes
    .map((n) => (n.stance ? `${n.stance.axis}@${n.stance.polarity.toFixed(3)}` : ""))
    .join("|");
  const supers = graph.nodes.map((n) => n.supersededBy ?? "").join("|");
  const edges = graph.edges
    .map((e) => `${e.from}>${e.relation}>${e.to}@${e.confidence.toFixed(3)}`)
    .sort()
    .join("|");
  const orphans = graph.orphans.map((o) => `${o.id}:${o.kind}:${o.text}`).join("|");
  const clusters = graph.clusters.map((c) => `${c.label}:${c.nodeIds.slice().sort().join(",")}`).join("|");
  const axis = graph.axis ? `${graph.axis.name}|${graph.axis.poles.join("/")}` : "";
  return [nodeIds, aliases, sources, stances, supers, edges, orphans, clusters, axis].join("\n");
}

function redirectEdgesAfterMerge(
  edges: ArgEdge[],
  duplicateId: string,
  canonicalId: string,
): { edges: ArgEdge[]; changed: boolean } {
  let changed = false;
  const seen = new Set<string>();
  const next: ArgEdge[] = [];
  for (const e of edges) {
    let from = e.from;
    let to = e.to;
    if (from === duplicateId) {
      from = canonicalId;
      changed = true;
    }
    if (to === duplicateId) {
      to = canonicalId;
      changed = true;
    }
    if (from === to) {
      changed = true; // self-loop produced by collapsing — drop
      continue;
    }
    const sig = `${from}>${e.relation}>${to}`;
    if (seen.has(sig)) {
      changed = true; // duplicate after collapse — drop
      continue;
    }
    seen.add(sig);
    next.push({ ...e, from, to });
  }
  return { edges: next, changed };
}

/**
 * Drive a global consolidation pass over the live argument graph. One model
 * call returns the proposed structural ops; this function applies them in
 * order and (for contradicts edges) confirms each via NLI before emitting it.
 *
 * Returns the same graph reference (===) when the model failed or proposed
 * no real change. On any structural change, returns a new graph with
 * consolidationVersion bumped by 1. Idempotent — re-running with no new
 * messages is a no-op.
 */
export async function consolidateArgGraph(
  input: ConsolidationInput,
  complete: ConsolidationCompletionFn,
): Promise<ArgGraph> {
  const prompt = buildConsolidationPrompt(input);
  let raw: string | null = null;
  try {
    raw = await complete(prompt);
  } catch {
    return input.graph;
  }
  const ops = parseConsolidationResponse(raw);
  if (!ops) return input.graph;

  const before = structuralFingerprint(input.graph);

  // Work on a deep-enough copy. Nodes and orphans get mutated in place for
  // strength/aliases/stance/sources updates, so we clone them too.
  const cloneNode = (n: ArgNode): ArgNode => ({
    ...n,
    aliases: [...n.aliases],
    sources: n.sources.map((s) => ({ ...s })),
    ...(n.stance ? { stance: { ...n.stance } } : {}),
    ...(n.verification ? { verification: { ...n.verification } } : {}),
    ...(n.influencedBy ? { influencedBy: { ...n.influencedBy } } : {}),
  });
  let nodes = input.graph.nodes.map(cloneNode);
  let edges = input.graph.edges.map((e) => ({ ...e }));
  let orphans = input.graph.orphans.map(cloneNode);
  let clusters = input.graph.clusters.map((c) => ({ ...c, nodeIds: [...c.nodeIds] }));
  let axis: ArgGraphAxis | undefined = input.graph.axis
    ? { ...input.graph.axis, poles: [...input.graph.axis.poles] }
    : undefined;

  // Fix B6: collision-checking edge id generator. Previously the
  // consolidator minted ids as `ed_${edges.length}`, which collides after
  // any merge/redirect that drops edges since `edges.length` is no longer
  // monotonic. Using the same probe-from-length pattern as `generateEdgeId`
  // but operating on the in-progress edges array.
  const nextEdgeId = (): string => {
    const used = new Set(edges.map((e) => e.id));
    let i = edges.length;
    while (true) {
      const candidate = `ed_${i}`;
      if (!used.has(candidate)) return candidate;
      i += 1;
    }
  };

  // Fix B7: defensive node id generator for orphan promotion. Re-mints the
  // id only when it would collide with an already-promoted node — the
  // common case (no collision) keeps the orphan's original id so the
  // structuralFingerprint stays stable across passes.
  const ensureUniqueNodeId = (id: string, kind: ArgNodeKind): string => {
    if (!nodes.some((n) => n.id === id) && !orphans.some((n) => n.id === id && n.id !== id)) {
      return id;
    }
    if (!nodes.some((n) => n.id === id)) return id;
    const prefix = KIND_ID_PREFIX[kind];
    const used = new Set(nodes.map((n) => n.id).concat(orphans.map((n) => n.id)));
    let i = nodes.length;
    while (true) {
      const candidate = `${prefix}_${i}`;
      if (!used.has(candidate)) return candidate;
      i += 1;
    }
  };

  // 1. Axis.
  if (ops.axis === null) {
    axis = undefined;
  } else if (ops.axis) {
    axis = ops.axis;
  }

  // 2. Stances.
  for (const s of ops.stances) {
    const node = nodes.find((n) => n.id === s.id);
    if (!node || node.kind !== "claim") continue;
    node.stance = {
      axis: axis?.name ?? node.stance?.axis ?? "",
      polarity: s.polarity,
    };
  }

  // 3. Merges. Apply transitively — if A merges into B and B merges into C,
  //    end up with everything in C.
  const idMap = new Map<string, string>();
  const resolveId = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (idMap.has(cur)) {
      if (seen.has(cur)) break; // cycle guard
      seen.add(cur);
      cur = idMap.get(cur)!;
    }
    return cur;
  };
  for (const m of ops.merges) {
    const canonicalId = resolveId(m.canonical);
    const duplicateId = resolveId(m.duplicate);
    if (canonicalId === duplicateId) continue;
    const canonical = nodes.find((n) => n.id === canonicalId);
    const duplicate = nodes.find((n) => n.id === duplicateId);
    if (!canonical || !duplicate) continue;
    if (canonical.kind !== "claim" || duplicate.kind !== "claim") continue;

    // Move sources + alias text from duplicate into canonical.
    for (const s of duplicate.sources) {
      const dupe = canonical.sources.some(
        (cs) => cs.messageId === s.messageId && cs.agentId === s.agentId,
      );
      if (!dupe) canonical.sources.push(s);
    }
    const dupAliasLower = duplicate.text.toLowerCase();
    if (
      canonical.text.toLowerCase() !== dupAliasLower &&
      !canonical.aliases.some((a) => a.toLowerCase() === dupAliasLower)
    ) {
      canonical.aliases.push(duplicate.text);
    }
    for (const alias of duplicate.aliases) {
      const aliasLower = alias.toLowerCase();
      if (
        canonical.text.toLowerCase() !== aliasLower &&
        !canonical.aliases.some((a) => a.toLowerCase() === aliasLower)
      ) {
        canonical.aliases.push(alias);
      }
    }
    canonical.strength = Math.min(1, canonical.strength + 0.1);

    // Drop the duplicate node, redirect edges.
    nodes = nodes.filter((n) => n.id !== duplicateId);
    const redir = redirectEdgesAfterMerge(edges, duplicateId, canonicalId);
    edges = redir.edges;
    idMap.set(duplicateId, canonicalId);
    // Re-point any cluster references.
    clusters = clusters.map((c) => ({
      ...c,
      nodeIds: c.nodeIds.map((id) => (id === duplicateId ? canonicalId : id)),
    }));
  }

  // 4. Supersessions.
  for (const s of ops.supersessions) {
    const supersededId = resolveId(s.supersededId);
    const byId = resolveId(s.byId);
    if (supersededId === byId) continue;
    const earlier = nodes.find((n) => n.id === supersededId);
    const later = nodes.find((n) => n.id === byId);
    if (!earlier || !later) continue;
    if (earlier.kind !== "claim" || later.kind !== "claim") continue;
    if (earlier.status === "superseded" && earlier.supersededBy === byId) continue;
    earlier.status = "superseded";
    earlier.supersededBy = byId;
  }

  // 5. Contradicts edges — confirm each via NLI before emitting.
  const validIds = new Set(nodes.map((n) => n.id));
  for (const c of ops.candidateContradicts) {
    const from = resolveId(c.from);
    const to = resolveId(c.to);
    if (from === to) continue;
    if (!validIds.has(from) || !validIds.has(to)) continue;
    const dup = edges.find(
      (e) => e.from === from && e.to === to && e.relation === "contradicts",
    );
    if (dup) continue;
    const fromNode = nodes.find((n) => n.id === from)!;
    const toNode = nodes.find((n) => n.id === to)!;
    const verdict = await semanticConflictCheck(
      {
        topic: input.topic,
        agentAName: fromNode.sourceAgentId,
        agentAMessage: fromNode.text,
        agentBName: toNode.sourceAgentId,
        agentBMessage: toNode.text,
      },
      complete,
    );
    if (!verdict || verdict.verdict !== "contradicts") continue;
    if (verdict.confidence < 0.5) continue;
    const id = nextEdgeId();
    const edge: ArgEdge = {
      id,
      from,
      to,
      relation: "contradicts",
      confidence: Math.min(1, Math.max(c.confidence, verdict.confidence)),
    };
    if (c.rationale) edge.rationale = c.rationale;
    edges.push(edge);
  }

  // 6. Clusters.
  if (ops.clusters.length > 0) {
    clusters = ops.clusters
      .map((c, i) => ({
        id: c.id || `cluster_${i}`,
        label: c.label,
        nodeIds: c.nodeIds
          .map(resolveId)
          .filter((id) => validIds.has(id)),
      }))
      .filter((c) => c.nodeIds.length > 0);
  }

  // 7. Orphan resolutions.
  if (ops.orphanResolutions.length > 0) {
    const remaining: ArgNode[] = [];
    for (const orphan of orphans) {
      const op = ops.orphanResolutions.find((o) => o.orphanId === orphan.id);
      if (!op) {
        remaining.push(orphan);
        continue;
      }
      if (op.anchorClaimId === null) continue; // explicit drop
      const claimId = resolveId(op.anchorClaimId);
      const target = nodes.find((n) => n.id === claimId && n.kind === "claim");
      if (!target) {
        // Couldn't resolve — keep the orphan staged for next pass.
        remaining.push(orphan);
        continue;
      }
      // Promote the orphan into a real node + the appropriate edge.
      const anchored: ArgNode = { ...orphan, id: ensureUniqueNodeId(orphan.id, orphan.kind) };
      nodes.push(anchored);
      const relation = ANCHOR_RELATION[orphan.kind] ?? "supports";
      edges.push({
        id: nextEdgeId(),
        from: anchored.id,
        to: target.id,
        relation,
        confidence: 0.8,
      });
    }
    orphans = remaining;
  }

  const candidate: ArgGraph = {
    ...input.graph,
    nodes,
    edges,
    clusters,
    orphans,
    consolidationVersion: input.graph.consolidationVersion,
    schemaVersion: 2,
    ...(axis ? { axis } : {}),
  };
  if (!axis) {
    delete (candidate as { axis?: ArgGraphAxis }).axis;
  }

  const after = structuralFingerprint(candidate);
  if (before === after) {
    return input.graph;
  }
  candidate.consolidationVersion = input.graph.consolidationVersion + 1;
  return candidate;
}

// ----------------------------------------------------------------------------
// Phase 4 — fact-check overlay
// ----------------------------------------------------------------------------
//
// `factCheckMessage` (in factcheck.ts) produces a list of FactCheckBadge
// objects per council message. Phase 4 attaches each badge's verdict to
// the matching ArgNode (preferring evidence in the same message; falling
// back to the originating claim) so the Graph view can render ✓ / ✗ /
// uncertain marks without piping the badges through React state.

export type FactCheckMappableVerdict = "verified" | "unverified" | "contradicted";

export interface FactCheckMappableBadge {
  claim: string;
  verdict: FactCheckMappableVerdict;
  confidence: number;
  evidence?: string;
}

/**
 * Map a fact-check badge verdict to the argmap verification vocabulary.
 *   "verified"     → "true"
 *   "contradicted" → "false"
 *   "unverified"   → "uncertain"
 */
export function mapFactCheckVerdict(
  v: FactCheckMappableVerdict,
): "true" | "false" | "uncertain" {
  if (v === "verified") return "true";
  if (v === "contradicted") return "false";
  return "uncertain";
}

const FACT_CHECK_MATCH_THRESHOLD = 0.7;

/**
 * Apply a list of fact-check badges to the matching nodes in `graph`.
 * Match strategy:
 *   1. Within the same source message, prefer evidence-kind nodes whose
 *      text or aliases score ≥ FACT_CHECK_MATCH_THRESHOLD against the
 *      badge claim under bag-of-words cosine.
 *   2. Fall back to claim-kind nodes that originated in the same message.
 *   3. If no in-message match clears the threshold, the badge is dropped.
 *
 * Returns a new ArgGraph reference when any node was tagged, or the
 * original input reference otherwise. Idempotent — re-applying a badge
 * with the same verdict + confidence is a no-op.
 */
export function applyFactCheckBadgesToGraph(
  graph: ArgGraph,
  badges: readonly FactCheckMappableBadge[],
  messageId: string,
): ArgGraph {
  if (badges.length === 0) return graph;
  const inMessageEvidence = graph.nodes.filter(
    (n) =>
      n.kind === "evidence" &&
      n.sources.some((s) => s.messageId === messageId),
  );
  const inMessageClaims = graph.nodes.filter(
    (n) =>
      n.kind === "claim" &&
      n.sources.some((s) => s.messageId === messageId),
  );
  if (inMessageEvidence.length === 0 && inMessageClaims.length === 0) {
    return graph;
  }

  const findBest = (claimText: string): ArgNode | null => {
    let best: ArgNode | null = null;
    let bestScore = FACT_CHECK_MATCH_THRESHOLD;
    const score = (node: ArgNode): number => {
      let s = bagOfWordsCosine(node.text, claimText);
      for (const alias of node.aliases) {
        const aliasScore = bagOfWordsCosine(alias, claimText);
        if (aliasScore > s) s = aliasScore;
      }
      return s;
    };
    for (const ev of inMessageEvidence) {
      const s = score(ev);
      if (s >= bestScore) {
        best = ev;
        bestScore = s;
      }
    }
    if (best) return best;
    for (const cl of inMessageClaims) {
      const s = score(cl);
      if (s >= bestScore) {
        best = cl;
        bestScore = s;
      }
    }
    return best;
  };

  const updates = new Map<string, ArgNodeVerification>();
  for (const badge of badges) {
    const target = findBest(badge.claim);
    if (!target) continue;
    const verdict = mapFactCheckVerdict(badge.verdict);
    const confidence = clamp(badge.confidence, 0, 1);
    const next: ArgNodeVerification = {
      verdict,
      confidence,
      ...(badge.evidence ? { evidenceUrl: badge.evidence } : {}),
    };
    const existing = updates.get(target.id) ?? target.verification;
    if (
      existing &&
      existing.verdict === next.verdict &&
      existing.confidence === next.confidence &&
      existing.evidenceUrl === next.evidenceUrl
    ) {
      // No-op write — preserve in case later badges produce a write.
      updates.set(target.id, existing);
      continue;
    }
    updates.set(target.id, next);
  }

  if (updates.size === 0) return graph;
  let changed = false;
  const nextNodes = graph.nodes.map((n) => {
    const ver = updates.get(n.id);
    if (!ver) return n;
    if (
      n.verification &&
      n.verification.verdict === ver.verdict &&
      n.verification.confidence === ver.confidence &&
      n.verification.evidenceUrl === ver.evidenceUrl
    ) {
      return n;
    }
    changed = true;
    return { ...n, verification: ver };
  });
  if (!changed) return graph;
  return { ...graph, nodes: nextNodes };
}

/**
 * Pull the PREMISES bullets out of a `summarizeOlderMessages` summary so the
 * consolidator can seed them. Returns [] when no PREMISES section is found.
 */
export function extractPremisesFromSummary(summary: string | null | undefined): string[] {
  if (!summary) return [];
  const idx = summary.toUpperCase().indexOf("PREMISES");
  if (idx < 0) return [];
  const tail = summary.slice(idx);
  const lines = tail.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.length === 0) {
      if (out.length > 0) break;
      continue;
    }
    const m = line.match(/^[-*•]\s*(.+)$/);
    if (m) out.push(m[1]!.trim());
    else if (out.length > 0) break;
  }
  return out;
}

// ----------------------------------------------------------------------------
// Re-exports for tests / consumers that want raw constants
// ----------------------------------------------------------------------------

export const ARG_NODE_KINDS = NODE_KINDS;
export const ARG_EDGE_RELATIONS = EDGE_RELATIONS;
