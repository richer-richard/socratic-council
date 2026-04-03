import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig, AgentId, ProviderCredentials } from "@socratic-council/shared";
import { DEFAULT_AGENTS } from "@socratic-council/shared";
import {
  TransportFailure,
  type StreamHandlers,
  type StreamRequest,
  type Transport,
} from "@socratic-council/sdk";
import { Council } from "./council.js";

function createSingleAgent(agent: AgentConfig) {
  return {
    [agent.id]: agent,
  } as Record<AgentId, AgentConfig>;
}

function createDeepSeekAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    ...DEFAULT_AGENTS.douglas,
    provider: "deepseek",
    model: "deepseek-reasoner",
    ...overrides,
  };
}

function createDeepSeekTransport(
  handler: (request: StreamRequest, handlers: StreamHandlers) => Promise<void> | void,
): Transport {
  return {
    request: vi.fn(async () => {
      throw new Error("Unexpected buffered request");
    }),
    stream: async (request, handlers) => {
      await handler(request, handlers);
    },
  };
}

function emitDeepSeekResponse(handlers: StreamHandlers, content: string) {
  handlers.onChunk(
    `data: ${JSON.stringify({
      choices: [{ delta: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    })}\n\n`,
  );
  handlers.onDone();
}

describe("Council", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pauses without completing and can resume to finish", async () => {
    vi.useFakeTimers();
    let streamCalls = 0;
    const agent = createDeepSeekAgent();
    const council = new Council(
      { deepseek: { apiKey: "test-key" } } satisfies ProviderCredentials,
      { autoMode: true, maxTurns: 1 },
      createSingleAgent(agent),
      {
        transport: createDeepSeekTransport(async (request, handlers) => {
          streamCalls += 1;
          if (streamCalls === 1) {
            if (request.signal?.aborted) {
              handlers.onError(new TransportFailure("ABORTED", "Request aborted"));
              return;
            }
            request.signal?.addEventListener(
              "abort",
              () => handlers.onError(new TransportFailure("ABORTED", "Request aborted")),
              { once: true },
            );
            return;
          }

          emitDeepSeekResponse(handlers, "Resumed response");
        }),
      },
    );

    const events: string[] = [];
    council.onEvent((event) => {
      events.push(event.type);
      if (event.type === "turn_started" && streamCalls === 0) {
        council.pause();
      }
    });

    const startPromise = council.start("Pause semantics");
    await vi.runAllTimersAsync();
    await startPromise;

    expect(council.getState().status).toBe("paused");
    expect(council.getState().currentTurn).toBe(0);
    expect(events).toContain("council_paused");
    expect(events).not.toContain("council_completed");

    const resumePromise = council.resume();
    await vi.runAllTimersAsync();
    await resumePromise;

    const state = council.getState();
    expect(state.status).toBe("completed");
    expect(state.currentTurn).toBe(1);
    expect(state.messages.at(-1)?.content).toBe("Resumed response");
    expect(events.filter((event) => event === "council_completed")).toHaveLength(1);
  });

  it("does not advance the turn when the provider is missing", async () => {
    const agent = createDeepSeekAgent({ provider: "anthropic" });
    const council = new Council({}, { autoMode: true, maxTurns: 1 }, createSingleAgent(agent));

    await council.start("Missing provider");

    const state = council.getState();
    expect(state.status).toBe("completed");
    expect(state.currentTurn).toBe(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.agentId).toBe("system");
  });

  it("returns immutable state snapshots", async () => {
    const agent = createDeepSeekAgent();
    const council = new Council(
      { deepseek: { apiKey: "test-key" } } satisfies ProviderCredentials,
      { autoMode: false },
      createSingleAgent(agent),
    );

    council.addUserMessage("Original message");
    const snapshot = council.getState();
    snapshot.messages.push({
      id: "mutated",
      agentId: "user",
      content: "Should not leak",
      timestamp: Date.now(),
    });

    expect(council.getState().messages).toHaveLength(1);
    expect(council.getState().messages[0]?.content).toBe("Original message");
  });

  it("rejects invalid imports and normalizes running imports to paused", () => {
    const agent = createDeepSeekAgent();
    const council = new Council(
      { deepseek: { apiKey: "test-key" } } satisfies ProviderCredentials,
      { autoMode: false },
      createSingleAgent(agent),
    );

    expect(() => council.importState('{"id":"bad"}')).toThrow("Invalid council state payload");

    council.importState(
      JSON.stringify({
        id: "imported",
        config: {
          topic: "Imported",
          maxTurns: 5,
          biddingTimeout: 1000,
          budgetLimit: 2,
          autoMode: true,
        },
        agents: [agent],
        messages: [
          { id: "m1", agentId: "system", content: "Imported topic", timestamp: Date.now() },
        ],
        currentTurn: 2,
        totalCost: 1.25,
        status: "running",
      }),
    );

    const state = council.getState();
    expect(state.id).toBe("imported");
    expect(state.status).toBe("paused");
    expect(state.currentTurn).toBe(2);
  });
});
