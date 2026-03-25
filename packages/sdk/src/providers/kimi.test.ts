import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@socratic-council/shared";
import type { StreamHandlers, StreamRequest, Transport, TransportResponse } from "../transport.js";
import { KimiProvider } from "./kimi.js";

function createAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "kate",
    name: "Kate",
    provider: "kimi",
    model: "moonshot-v1-8k",
    systemPrompt: "System prompt",
    temperature: 0.7,
    maxTokens: 2048,
    ...overrides,
  };
}

function createTransport(options: {
  request?: (request: Parameters<Transport["request"]>[0]) => Promise<TransportResponse>;
  stream?: (request: StreamRequest, handlers: StreamHandlers) => Promise<void>;
}): Transport {
  return {
    request:
      options.request ??
      (async () => ({
        status: 200,
        headers: {},
        body: "{}",
      })),
    stream:
      options.stream ??
      (async (_request, handlers) => {
        handlers.onDone();
      }),
  };
}

describe("KimiProvider", () => {
  it("builds raw image inputs for vision models", () => {
    const provider = new KimiProvider("test-key");
    const request = (provider as unknown as {
      buildRequestBody: (...args: unknown[]) => Record<string, unknown>;
    }).buildRequestBody(
      createAgent({ model: "moonshot-v1-8k-vision-preview" }),
      [
        {
          role: "user" as const,
          content: "Inspect this chart",
          attachments: [
            {
              id: "att_1",
              kind: "image" as const,
              name: "chart.jpg",
              mimeType: "image/jpeg",
              data: "ZmFrZQ==",
            },
          ],
        },
      ],
      {},
      false,
    );

    const message = (request.messages as Array<{ content: unknown }>)[0];
    expect(Array.isArray(message?.content)).toBe(true);
    expect(message?.content).toEqual([
      { type: "text", text: "Inspect this chart" },
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,ZmFrZQ==" },
      },
    ]);
  });

  it("rejects non-stream responses that contain reasoning without final content", async () => {
    const provider = new KimiProvider(
      "test-key",
      {
        transport: createTransport({
          request: async () => ({
            status: 200,
            headers: {},
            body: JSON.stringify({
              choices: [
                {
                  message: {
                    content: "",
                    reasoning_content: "private reasoning",
                  },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
            }),
          }),
        }),
      },
    );

    await expect(
      provider.complete(createAgent(), [{ role: "user", content: "Hello" }]),
    ).rejects.toThrow("reasoning but no final content");
  });

  it("rejects streamed responses that never produce final content", async () => {
    const provider = new KimiProvider(
      "test-key",
      {
        transport: createTransport({
          stream: async (_request, handlers) => {
            handlers.onChunk(
              `data: ${JSON.stringify({
                choices: [
                  {
                    delta: { reasoning_content: "thinking only" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 10, completion_tokens: 5 },
              })}\n\n`,
            );
            handlers.onDone();
          },
        }),
      },
    );

    const onChunk = vi.fn();
    await expect(
      provider.completeStream(createAgent(), [{ role: "user", content: "Hello" }], onChunk),
    ).rejects.toThrow("without final content");
    expect(onChunk).toHaveBeenCalledWith({ content: "", thinking: "thinking only", done: false });
  });
});
