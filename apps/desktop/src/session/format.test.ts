import { describe, expect, it } from "vitest";

import { usd } from "./format";

describe("usd", () => {
  it("keeps four places under a dime so a cheap run does not read as free", () => {
    expect(usd(0.003)).toBe("$0.0030");
    expect(usd(0.0745)).toBe("$0.0745");
  });

  it("prints cents from a dime up and one place from ten dollars", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.49)).toBe("$0.49");
    expect(usd(12.34)).toBe("$12.3");
  });
});
