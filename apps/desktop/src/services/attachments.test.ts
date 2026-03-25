import { describe, expect, it } from "vitest";

import {
  createComposerAttachments,
  getAttachmentTransportMode,
  getProviderAttachmentSupport,
  type SessionAttachment,
} from "./attachments";

function createAttachment(kind: SessionAttachment["kind"]): SessionAttachment {
  return {
    id: "att_1",
    name: kind === "pdf" ? "paper.pdf" : "image.jpg",
    mimeType: kind === "pdf" ? "application/pdf" : "image/jpeg",
    size: 1024,
    kind,
    source: "file-picker",
    addedAt: Date.now(),
    width: kind === "image" ? 1200 : null,
    height: kind === "image" ? 800 : null,
    fallbackText: "Extracted notes",
  };
}

describe("attachment transport support", () => {
  it("keeps raw image upload for supported Gemini models", () => {
    const support = getProviderAttachmentSupport("google", "gemini-3.1-pro-preview");
    expect(support.images).toBe("raw");
  });

  it("forces PDF attachments onto fallback mode for GPT-5.4", () => {
    const mode = getAttachmentTransportMode("openai", "gpt-5.4", createAttachment("pdf"));
    expect(mode).toBe("fallback");
  });

  it("forces PDF attachments onto fallback mode for Gemini pro", () => {
    const mode = getAttachmentTransportMode("google", "gemini-3.1-pro-preview", createAttachment("pdf"));
    expect(mode).toBe("fallback");
  });

  it("keeps raw image upload for Kimi vision models", () => {
    const support = getProviderAttachmentSupport("kimi", "moonshot-v1-8k-vision-preview");
    expect(support.images).toBe("raw");
    expect(support.pdf).toBe("fallback");
  });

  it("compacts oversized text uploads into a smaller local blob", async () => {
    const originalText = `${"Large attachment body.\n".repeat(160000)}Final line.`;
    const file = new File([originalText], "notes.txt", { type: "text/plain" });

    const [attachment] = await createComposerAttachments([file], "file-picker");

    expect(attachment).toBeDefined();
    expect(attachment.kind).toBe("text");
    expect(attachment.size).toBe(file.size);
    expect(attachment.blob.size).toBeLessThan(file.size);
    expect(attachment.searchable).toBe(true);
    expect(attachment.fallbackText).toContain('Extracted notes from "notes.txt"');
  });
});
