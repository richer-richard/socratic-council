/**
 * Live argument map for the debate (wave 2.6).
 *
 * Maintains a directed graph of claims, evidence, and rebuttals extracted
 * incrementally from the transcript. After each council message the caller
 * runs `updateArgumentMap(previous, newMessage, extract)` — the extractor
 * is a provider-agnostic completion function (Gemini 3.1 Flash in the
 * default wiring) that returns structured nodes, and the map merges them
 * in without duplicating existing claims.
 *
 * The UI panel (desktop-side, follow-up) renders this graph as a
 * node-link diagram. Clicking a node should navigate to the source message
 * identified by `sourceMessageId`.
 */

export type ArgNodeKind = "claim" | "evidence" | "rebuttal";

export interface ArgNode {
  id: string;
  kind: ArgNodeKind;
  text: string;
  sourceMessageId: string;
  sourceAgentId: string;
}

export interface ArgEdge {
  from: string; // node id
  to: string; // node id
  /** "supports" = evidence → claim; "rebuts" = rebuttal → claim. */
  relation: "supports" | "rebuts";
}

export interface ArgGraph {
  nodes: ArgNode[];
  edges: ArgEdge[];
  /** Last message id already incorporated — so re-runs can skip. */
  lastMessageId: string | null;
}

export function emptyGraph(): ArgGraph {
  return { nodes: [], edges: [], lastMessageId: null };
}

// --- Extractor contract ------------------------------------------------------

export interface ExtractInput {
  topic: string;
  messageId: string;
  agentName: string;
  agentId: string;
  messageText: string;
  /** The agent names already present in the debate — helps the extractor
      resolve "George's earlier point" to the right source agent. */
  priorAgentNames: string[];
  /** Most recent N claim texts so the extractor can link supports/rebuts. */
  priorClaims: Array<{ id: string; text: string }>;
}

export interface ExtractedFragment {
  kind: ArgNodeKind;
  text: string;
  /** When `kind === "evidence" | "rebuttal"`, id or quoted text of the claim it
      links to. When `kind === "claim"`, ignored. */
  targetClaim?: string;
}

export type ExtractorCompletionFn = (prompt: {
  system: string;
  user: string;
}) => Promise<string | null>;

const SYSTEM_PROMPT = `You extract structured argument-map fragments from a single message in a multi-agent debate.

Output a JSON array. Each element is one of:
  {"kind":"claim","text":"the stance, position, criterion, or framing the speaker commits to (one sentence)"}
  {"kind":"evidence","text":"a concrete example, number, citation, or case","targetClaim":"<exact existing claim id, e.g. c_0>"}
  {"kind":"rebuttal","text":"the counter-argument or pushback","targetClaim":"<exact existing claim id, e.g. c_0>"}

EXTRACTION DEPTH:
- A substantive message typically contains 2-5 distinct fragments. Extract them all — do not be lazy.
- Treat reframings, sharp distinctions, proposed criteria, agreements/refinements, and concessions as CLAIMS — they all stake a position.
- A claim phrased as a rhetorical question is still a claim. ("Doesn't enforcement matter?" → claim that enforcement matters.)
- Evidence is anything concrete: a price, a named law, a specific service, a statistic, a case.
- A rebuttal explicitly pushes back, denies, or proposes an alternative to a prior claim.

CRITICAL RULE for evidence and rebuttals:
- targetClaim MUST be the EXACT id of one of the EXISTING CLAIMS listed in the user message (e.g. "c_0", "c_3"). Do NOT paraphrase the claim's text. Do NOT invent ids. The system cannot resolve paraphrased targets and will drop them.
- If you cannot identify the precise existing claim id to anchor to, emit the fragment as a "claim" instead. Never invent a target.

WHEN TO RETURN []:
- ONLY for messages that are pure greetings, jokes, off-topic chitchat, or empty rhetorical filler. If the message advances the debate at all — even slightly — extract at least one fragment.

Output MUST be a JSON array, nothing else, no code fences.`;

export function buildExtractPrompt(input: ExtractInput): { system: string; user: string } {
  const user = [
    `Topic: ${input.topic}`,
    "",
    "EXISTING CLAIMS (reference these by id or by quoted text):",
    ...(input.priorClaims.length === 0
      ? ["(none yet)"]
      : input.priorClaims.map((c) => `- [${c.id}] ${c.text}`)),
    "",
    `MESSAGE (from ${input.agentName}, id=${input.messageId}):`,
    input.messageText.trim(),
    "",
    "Return the JSON array of fragments now.",
  ].join("\n");
  return { system: SYSTEM_PROMPT, user };
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
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const kind = rec.kind;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    const targetClaim = typeof rec.targetClaim === "string" ? rec.targetClaim.trim() : undefined;
    if (text.length === 0) continue;
    if (kind === "claim" || kind === "evidence" || kind === "rebuttal") {
      out.push({ kind, text: text.slice(0, 240), targetClaim: targetClaim?.slice(0, 240) });
    }
  }
  return out;
}

function generateNodeId(existing: ArgGraph, prefix: string): string {
  let i = existing.nodes.length;
  while (true) {
    const candidate = `${prefix}_${i}`;
    if (!existing.nodes.some((n) => n.id === candidate)) return candidate;
    i += 1;
  }
}

function findClaimByReference(graph: ArgGraph, ref: string | undefined): ArgNode | null {
  if (!ref) return null;
  // First try id match (strip square brackets if present).
  const idCandidate = ref.replace(/^\[|\]$/g, "").trim();
  const byId = graph.nodes.find((n) => n.kind === "claim" && n.id === idCandidate);
  if (byId) return byId;
  // Fallback: case-insensitive substring match on claim text.
  const needle = ref.toLowerCase();
  return (
    graph.nodes.find(
      (n) =>
        n.kind === "claim" &&
        (n.text.toLowerCase().includes(needle) || needle.includes(n.text.toLowerCase())),
    ) ?? null
  );
}

export function updateArgumentMap(
  previous: ArgGraph,
  fragments: ExtractedFragment[],
  source: { messageId: string; agentId: string },
): ArgGraph {
  const next: ArgGraph = {
    nodes: [...previous.nodes],
    edges: [...previous.edges],
    lastMessageId: source.messageId,
  };

  for (const frag of fragments) {
    if (frag.kind === "claim") {
      // Skip if an identical claim already exists from this source — avoid
      // duplicating rewordings from the same speaker.
      const duplicate = next.nodes.some(
        (n) =>
          n.kind === "claim" &&
          n.sourceAgentId === source.agentId &&
          n.text.toLowerCase() === frag.text.toLowerCase(),
      );
      if (duplicate) continue;
      const id = generateNodeId(next, "c");
      next.nodes.push({
        id,
        kind: "claim",
        text: frag.text,
        sourceMessageId: source.messageId,
        sourceAgentId: source.agentId,
      });
    } else {
      const target = findClaimByReference(next, frag.targetClaim);
      if (!target) {
        // Can't anchor — promote to a free-standing claim so the content
        // survives in the UI instead of disappearing. The semantic label
        // (evidence/rebuttal) is lost, but losing the text entirely is worse.
        const duplicate = next.nodes.some(
          (n) =>
            n.kind === "claim" &&
            n.sourceAgentId === source.agentId &&
            n.text.toLowerCase() === frag.text.toLowerCase(),
        );
        if (duplicate) continue;
        const claimId = generateNodeId(next, "c");
        next.nodes.push({
          id: claimId,
          kind: "claim",
          text: frag.text,
          sourceMessageId: source.messageId,
          sourceAgentId: source.agentId,
        });
        continue;
      }
      const id = generateNodeId(next, frag.kind === "evidence" ? "e" : "r");
      next.nodes.push({
        id,
        kind: frag.kind,
        text: frag.text,
        sourceMessageId: source.messageId,
        sourceAgentId: source.agentId,
      });
      next.edges.push({
        from: id,
        to: target.id,
        relation: frag.kind === "evidence" ? "supports" : "rebuts",
      });
    }
  }

  return next;
}
