import { describe, expect, it } from "vitest";
import { formatLogTime, stripAnsi } from "./logs";

describe("log helpers", () => {
  it("formats times with milliseconds in UTC", () => {
    expect(formatLogTime("2026-01-15T09:12:01.768108328Z", "utc")).toBe("09:12:01.768");
  });

  it("strips ANSI colour codes", () => {
    expect(stripAnsi("\u001b[32m INFO\u001b[0;39m ok")).toBe(" INFO ok");
  });
});
