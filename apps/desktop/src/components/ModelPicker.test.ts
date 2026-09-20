import { catalogModelsForProvider, type EngineCatalogRow } from "@socratic-council/shared";
import { describe, expect, it } from "vitest";

import { autoPreview } from "./ModelPicker";

const row = (id: string, cls: EngineCatalogRow["class"]): EngineCatalogRow => ({
  id,
  provider: "openai",
  name: id,
  class: cls,
  contextWindow: 1,
  maxOutput: 1,
  inputCostPer1m: 1,
  cachedInputCostPer1m: null,
  outputCostPer1m: 2,
  tools: true,
  vision: false,
  thinking: true,
  catalogued: true,
});

describe("autoPreview", () => {
  const available = catalogModelsForProvider("openai");
  const rows = [
    row("gpt-6-astra", "flagship"),
    row("gpt-5.6-sol", "balanced"),
    row("gpt-5.6-luna", "fast"),
  ];

  it("prefers the engine catalog's class column", () => {
    expect(autoPreview("openai", "high", available, undefined, rows)).toBe("gpt-6-astra");
    expect(autoPreview("openai", "medium", available, "auto", rows)).toBe("gpt-5.6-sol");
    expect(autoPreview("openai", "low", available, undefined, rows)).toBe("gpt-5.6-luna");
  });

  it("honours an explicit selection and falls back to the shared resolver without rows", () => {
    expect(autoPreview("openai", "low", available, "gpt-5.6-terra", rows)).toBe("gpt-5.6-terra");
    expect(autoPreview("openai", "high", available, undefined, undefined)).toBe("gpt-6-astra");
  });
});
