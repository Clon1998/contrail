import { describe, expect, it } from "vitest";
import { parseAnsi } from "./ansi";

describe("parseAnsi", () => {
  it("splits coloured text into segments and resets", () => {
    expect(parseAnsi("\u001b[2m2026\u001b[0;39m \u001b[32m INFO\u001b[0;39m ok")).toEqual([
      { text: "2026", dim: true },
      { text: " " },
      { text: " INFO", color: "text-green-500" },
      { text: " ok" },
    ]);
  });

  it("keeps plain text as one segment and skips 256 colours", () => {
    expect(parseAnsi("plain")).toEqual([{ text: "plain" }]);
    expect(parseAnsi("\u001b[1;38;5;208mhot\u001b[0m")).toEqual([{ text: "hot", bold: true }]);
  });
});
