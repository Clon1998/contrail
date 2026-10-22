import { describe, expect, it } from "vitest";
import { matchWords } from "./search";

describe("matchWords", () => {
  const keywords = ["222233334444", "eu-central-1"];

  it("matches substrings of name, account ID and region, case-insensitively", () => {
    expect(matchWords("demo-staging", "STAG", keywords)).toBe(1);
    expect(matchWords("demo-staging", "33334", keywords)).toBe(1);
    expect(matchWords("demo-staging", "central", keywords)).toBe(1);
    expect(matchWords("demo-staging", "", keywords)).toBe(1);
  });

  it("requires every word and doesn't match scattered characters", () => {
    expect(matchWords("demo-staging", "staging central", keywords)).toBe(1);
    expect(matchWords("demo-staging", "staging west", keywords)).toBe(0);
    // Fuzzy matching would accept this (2…3…4 appear in order in the account ID).
    expect(matchWords("demo-staging", "234", keywords)).toBe(0);
  });
});
