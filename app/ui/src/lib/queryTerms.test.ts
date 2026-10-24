import { describe, expect, it } from "vitest";
import {
  fieldTerm,
  hasTerm,
  phraseTerm,
  replaceTerm,
  splitTerms,
  termValue,
  toggleTerm,
} from "./queryTerms";

describe("splitTerms", () => {
  it("splits at whitespace outside quotes and regexes", () => {
    expect(splitTerms(' timeout  "read timed out" /a b/ log.logger:"x y" -level:DEBUG ')).toEqual([
      "timeout",
      '"read timed out"',
      "/a b/",
      'log.logger:"x y"',
      "-level:DEBUG",
    ]);
  });

  it("keeps escaped quotes inside a quoted value", () => {
    expect(splitTerms('k:"say \\"hi\\" now" next')).toEqual(['k:"say \\"hi\\" now"', "next"]);
  });

  it("doesn't treat a slash inside a value as a regex", () => {
    expect(splitTerms("url:/api/v1 other")).toEqual(["url:/api/v1", "other"]);
  });
});

describe("terms by click", () => {
  it("quotes values the parser would split or misread", () => {
    expect(fieldTerm("log.logger", "com.example.Orders")).toBe("log.logger:com.example.Orders");
    expect(fieldTerm("pipeline.message", "Processing failed: x ")).toBe(
      'pipeline.message:"Processing failed: x "',
    );
    expect(fieldTerm("k", 'a "b"', true)).toBe('-k:"a \\"b\\""');
    expect(fieldTerm("k", "")).toBe('k:""');
    expect(phraseTerm('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("adds a term, removes it again, and drops its opposite", () => {
    const term = fieldTerm("process.thread.name", "main");
    const added = toggleTerm("timeout", term);
    expect(added).toBe("timeout process.thread.name:main");
    expect(hasTerm(added, "PROCESS.THREAD.NAME:MAIN")).toBe(true);
    expect(toggleTerm(added, term)).toBe("timeout");
    // Excluding the same value replaces the wanted one.
    expect(toggleTerm(added, `-${term}`)).toBe("timeout -process.thread.name:main");
  });

  it("keeps one term of a kind", () => {
    const query = "timeout state:FAILED topic:orders";
    expect(replaceTerm(query, "state:", "state:COMPLETED")).toBe(
      "timeout topic:orders state:COMPLETED",
    );
    expect(replaceTerm(query, "topic:", null)).toBe("timeout state:FAILED");
    expect(termValue(query, "state:")).toBe("FAILED");
    expect(termValue('topic:"a b"', "topic:")).toBe("a b");
    expect(termValue(query, "correlation:")).toBeNull();
  });
});
