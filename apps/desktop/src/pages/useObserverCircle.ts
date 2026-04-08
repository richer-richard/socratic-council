/**
 * useObserverCircle — Outer-circle observer agents that passively listen
 * to the Socratic Council discussion and send private advisory notes to
 * their inner-circle partners.
 */

import { useCallback, useRef, useState } from "react";
import {
  OBSERVER_CONFIG,
  OBSERVER_IDS,
  PARTNER_TO_OBSERVER,
} from "@socratic-council/shared";
import type {
  AgentId as CouncilAgentId,
  ObserverId,
} from "@socratic-council/shared";
import { callProvider, apiLogger } from "../services/api";
import type { ChatMessage as APIChatMessage } from "../services/api";
import type { Provider, ProviderCredential, ProxyConfig } from "../stores/config";
import type { ModeratorUsageSnapshot, ObserverNoteSnapshot } from "../services/sessions";
import { calculateMessageCost } from "../utils/cost";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObserverNote {
  id: string;
  observerId: ObserverId;
  observerName: string;
  partnerId: CouncilAgentId;
  partnerName: string;
  content: string;
  turnGenerated: number;
  timestamp: number;
  consumed: boolean;
  tokens?: { input: number; output: number; reasoning?: number };
  latencyMs?: number;
}

interface ChatMessage {
  id: string;
  agentId: string;
  content: string;
  displayName?: string;
  isStreaming?: boolean;
  error?: string;
  timestamp: number;
}

interface ObserverCircleConfig {
  topic: string;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  configRef: React.MutableRefObject<{
    credentials: Partial<Record<Provider, ProviderCredential>>;
    models: Partial<Record<Provider, string>>;
    proxy: { type: string; host?: string; port?: number };
    preferences: { observersEnabled?: boolean };
  }>;
  abortRef: React.MutableRefObject<boolean>;
  buildAttachmentContext: (
    provider: Provider,
    model: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => { rawAttachments: any[]; attachmentText: string };
  agentConfig: Record<string, { name: string; provider: Provider }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OBSERVER_CONTEXT = 16;
const OBSERVER_INTERVAL = 3; // every N inner-circle turns

function buildObserverSystemPrompt(observerName: string, partnerName: string): string {
  return `You are ${observerName}, the outer-circle partner of ${partnerName} in the Socratic Council.

You are a silent observer. You do NOT speak in the discussion.
Your role is to send a brief private note to ${partnerName} with tactical advice.

In your note:
- Identify one blind spot or weakness in ${partnerName}'s recent arguments, OR suggest one specific counterpoint, question, or evidence they should raise.
- Keep it under 80 words. Be direct and actionable.
- Do NOT address other agents. Your note is private to ${partnerName}.
- Write only the note itself — no greeting, no sign-off.`;
}

const isCouncilAgent = (id: string): id is CouncilAgentId =>
  ["george", "cathy", "grace", "douglas", "kate", "quinn", "mary", "zara"].includes(id);

const isModeratorMessage = (msg: ChatMessage): boolean =>
  msg.agentId === "system" && msg.displayName === "Moderator";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useObserverCircle({
  topic,
  messagesRef,
  configRef,
  abortRef,
  buildAttachmentContext,
  agentConfig,
}: ObserverCircleConfig) {
  const observerNotesRef = useRef<ObserverNote[]>([]);
  const observerPassInFlightRef = useRef(false);
  const [observerUsage, setObserverUsage] = useState<ModeratorUsageSnapshot>({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedUSD: 0,
    pricingAvailable: false,
  });

  const getProxy = useCallback((): ProxyConfig | undefined => {
    const p = configRef.current.proxy;
    if (p.type !== "none" && p.host && (p.port ?? 0) > 0) {
      return p as ProxyConfig;
    }
    return undefined;
  }, [configRef]);

  // Build the conversation history an observer sees (all messages as "user" role)
  const buildObserverHistory = useCallback(
    (observerId: ObserverId): APIChatMessage[] | null => {
      const cfg = OBSERVER_CONFIG[observerId];
      const currentConfig = configRef.current;
      const credential = currentConfig.credentials[cfg.provider];
      const model = currentConfig.models[cfg.provider];
      if (!credential?.apiKey || !model) return null;

      const partnerConfig = agentConfig[cfg.partnerId];
      if (!partnerConfig) return null;

      const { rawAttachments, attachmentText } = buildAttachmentContext(cfg.provider, model);

      const history: APIChatMessage[] = [
        {
          role: "system",
          content: buildObserverSystemPrompt(cfg.name, partnerConfig.name),
        },
        {
          role: "user",
          content: [`Discussion topic: "${topic}"`, attachmentText].filter(Boolean).join("\n\n"),
          ...(attachmentText ? { cacheControl: "ephemeral" as const } : {}),
          ...(rawAttachments.length > 0 ? { attachments: rawAttachments } : {}),
        },
      ];

      // Add recent conversation — all as "user" role since observer is a reader
      const contextMessages = messagesRef.current
        .filter(
          (m) =>
            (isCouncilAgent(m.agentId) || isModeratorMessage(m)) &&
            !m.isStreaming &&
            !m.error &&
            (m.content ?? "").trim().length > 0 &&
            !m.content.includes("[No response received]"),
        )
        .slice(-MAX_OBSERVER_CONTEXT);

      for (const msg of contextMessages) {
        const speaker = isCouncilAgent(msg.agentId)
          ? (agentConfig[msg.agentId]?.name ?? msg.agentId)
          : "Moderator";
        history.push({
          role: "user",
          content: `${speaker} (id: ${msg.id}): ${msg.content}`,
        });
      }

      // Final instruction
      history.push({
        role: "user",
        content: `Write a short private note (under 80 words) to ${partnerConfig.name}. Focus on the most useful tactical advice right now.`,
      });

      return history;
    },
    [topic, messagesRef, configRef, buildAttachmentContext, agentConfig],
  );

  // Generate a single observer note
  const generateObserverNote = useCallback(
    async (observerId: ObserverId, turn: number): Promise<ObserverNote | null> => {
      const cfg = OBSERVER_CONFIG[observerId];
      const currentConfig = configRef.current;
      const credential = currentConfig.credentials[cfg.provider];
      const model = currentConfig.models[cfg.provider];
      if (!credential?.apiKey || !model) return null;

      const history = buildObserverHistory(observerId);
      if (!history) return null;

      const proxy = getProxy();
      const partnerConfig = agentConfig[cfg.partnerId];

      try {
        const result = await callProvider(
          cfg.provider,
          credential,
          model,
          history,
          () => {}, // no streaming UI needed for observers
          proxy,
          {
            requestTimeoutMs: 60000,
            idleTimeoutMs: 30000,
          },
        );

        if (!result.success || !result.content?.trim()) return null;

        const content = result.content.trim().slice(0, 500); // safety cap
        const note: ObserverNote = {
          id: `obs_${Date.now()}_${observerId}_${Math.random().toString(36).slice(2, 7)}`,
          observerId,
          observerName: cfg.name,
          partnerId: cfg.partnerId,
          partnerName: partnerConfig?.name ?? cfg.partnerId,
          content,
          turnGenerated: turn,
          timestamp: Date.now(),
          consumed: false,
          tokens: result.tokens,
          latencyMs: result.latencyMs,
        };

        // Update cost tracking
        const cost = calculateMessageCost(model, result.tokens);
        setObserverUsage((prev) => ({
          inputTokens: prev.inputTokens + (result.tokens.input ?? 0),
          outputTokens: prev.outputTokens + (result.tokens.output ?? 0),
          reasoningTokens: prev.reasoningTokens + (result.tokens.reasoning ?? 0),
          estimatedUSD: prev.estimatedUSD + (cost ?? 0),
          pricingAvailable: prev.pricingAvailable || cost != null,
        }));

        return note;
      } catch (error) {
        apiLogger.log(
          "warn",
          cfg.provider,
          `Observer ${cfg.name} note generation failed`,
          { error: error instanceof Error ? error.message : String(error) },
        );
        return null;
      }
    },
    [buildObserverHistory, configRef, getProxy, agentConfig],
  );

  // Run a full observer pass — all 8 in parallel
  const runObserverPass = useCallback(
    (
      turn: number,
      addMessages: (msgs: ChatMessage[]) => void,
    ) => {
      if (observerPassInFlightRef.current) return;
      if (abortRef.current) return;

      const currentConfig = configRef.current;
      const configuredObservers = OBSERVER_IDS.filter((id) => {
        const cfg = OBSERVER_CONFIG[id];
        const cred = currentConfig.credentials[cfg.provider];
        return cred?.apiKey && currentConfig.models[cfg.provider];
      });

      if (configuredObservers.length === 0) return;

      observerPassInFlightRef.current = true;

      Promise.allSettled(
        configuredObservers.map((id) => generateObserverNote(id, turn)),
      ).then((results) => {
        observerPassInFlightRef.current = false;
        if (abortRef.current) return;

        const newNotes: ObserverNote[] = [];
        const newMessages: ChatMessage[] = [];

        for (const result of results) {
          if (result.status !== "fulfilled" || !result.value) continue;
          const note = result.value;
          newNotes.push(note);
          newMessages.push({
            id: `msg_${Date.now()}_observer_${note.observerId}_${Math.random().toString(36).slice(2, 5)}`,
            agentId: "system",
            displayName: `${note.observerName} → ${note.partnerName}`,
            content: note.content,
            timestamp: Date.now(),
            observerNote: {
              observerId: note.observerId,
              observerName: note.observerName,
              partnerId: note.partnerId,
              partnerName: note.partnerName,
            },
          } as ChatMessage & { observerNote: ObserverNoteSnapshot });
        }

        if (newNotes.length > 0) {
          observerNotesRef.current = [...observerNotesRef.current, ...newNotes];
          addMessages(newMessages);
        }
      });
    },
    [abortRef, configRef, generateObserverNote],
  );

  // Get the latest unconsumed note for an inner-circle agent
  const getLatestNoteFor = useCallback(
    (agentId: CouncilAgentId): ObserverNote | null => {
      const observerId = PARTNER_TO_OBSERVER[agentId];
      if (!observerId) return null;

      const notes = observerNotesRef.current;
      for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i]!;
        if (note.observerId === observerId && !note.consumed) {
          note.consumed = true;
          return note;
        }
      }
      return null;
    },
    [],
  );

  // Check if it's time for an observer pass
  const shouldRunObserverPass = useCallback(
    (turn: number): boolean => {
      if (!configRef.current.preferences.observersEnabled) return false;
      return turn > 0 && turn % OBSERVER_INTERVAL === 0;
    },
    [configRef],
  );

  return {
    observerNotesRef,
    observerUsage,
    runObserverPass,
    getLatestNoteFor,
    shouldRunObserverPass,
    OBSERVER_INTERVAL,
  };
}
