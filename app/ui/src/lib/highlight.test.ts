import { describe, expect, it } from "vitest";
import { appendTerm, fieldTerm, highlightSegments } from "./highlight";

describe("highlightSegments", () => {
  it("marks case-insensitive occurrences", () => {
    expect(highlightSegments("Read Timeout after timeout", ["timeout"])).toEqual([
      { text: "Read ", match: false },
      { text: "Timeout", match: true },
      { text: " after ", match: false },
      { text: "timeout", match: true },
    ]);
  });

  it("prefers the longest term and handles none", () => {
    expect(highlightSegments("read timed out", ["time", "timed out"])).toEqual([
      { text: "read ", match: false },
      { text: "timed out", match: true },
    ]);
    expect(highlightSegments("plain", [])).toEqual([{ text: "plain", match: false }]);
  });
});

describe("query building", () => {
  it("quotes field values with spaces", () => {
    expect(fieldTerm("trace.id", "abc123")).toBe("trace.id:abc123");
    expect(fieldTerm("log.logger", 'a "b" c')).toBe('log.logger:"a \\"b\\" c"');
  });

  it("appends terms without duplicates", () => {
    expect(appendTerm("", "level:ERROR")).toBe("level:ERROR");
    expect(appendTerm("timeout ", "level:ERROR")).toBe("timeout level:ERROR");
    expect(appendTerm("timeout level:ERROR", "level:ERROR")).toBe("timeout level:ERROR");
  });
});
