import { describe, expect, it } from "vitest";
import {
  formatLogTime,
  fromDateTimeLocal,
  liveHint,
  liveMode,
  stripAnsi,
  toDateTimeLocal,
  windowLabel,
} from "./logs";

describe("log helpers", () => {
  it("formats times with milliseconds in UTC", () => {
    expect(formatLogTime("2026-01-15T09:12:01.768108328Z", "utc")).toBe("09:12:01.768");
  });

  it("strips ANSI colour codes", () => {
    expect(stripAnsi("\u001b[32m INFO\u001b[0;39m ok")).toBe(" INFO ok");
  });
});

describe("stack traces and JSON", () => {
  it("classifies stack trace lines", async () => {
    const { classifyTrace } = await import("./logs");
    const kinds = classifyTrace(
      "java.lang.X: boom\n\tat a.B.c(B.java:1)\nCaused by: java.io.IOException\n\t... 12 common frames omitted\n",
    ).map((l) => l.kind);
    expect(kinds).toEqual(["header", "frame", "causedBy", "omitted"]);
  });

  it("pretty-prints and tokenizes JSON", async () => {
    const { prettyJson, tokenizeJson } = await import("./logs");
    expect(prettyJson("not json")).toBeNull();
    const pretty = prettyJson('{"a":1,"b":"x","c":true}') ?? "";
    const kinds = tokenizeJson(pretty)
      .filter((t) => t.kind !== "punctuation")
      .map((t) => `${t.kind}:${t.text}`);
    expect(kinds).toEqual([
      'key:"a"',
      "number:1",
      'key:"b"',
      'string:"x"',
      'key:"c"',
      "literal:true",
    ]);
  });

  it("splits a message around embedded JSON using byte offsets", async () => {
    const { splitEmbeddedJson } = await import("./logs");
    // "ü" is 2 bytes in UTF-8, so the span from Rust is shifted against JavaScript's indices.
    const message = 'Fehler ü: {"a":1} end';
    expect(splitEmbeddedJson(message, [11, 18])).toEqual({
      before: "Fehler ü: ",
      json: '{"a":1}',
      after: " end",
    });
  });
});

describe("time windows", () => {
  it("labels relative and absolute windows", () => {
    expect(windowLabel({ kind: "last", minutes: 15 }, "utc")).toBe("15 min");
    expect(windowLabel({ kind: "last", minutes: 120 }, "utc")).toBe("2 h");
    expect(windowLabel({ kind: "last", minutes: 2 * 1440 }, "utc")).toBe("2 d");
    expect(windowLabel({ kind: "last", minutes: 90 }, "utc")).toBe("90 min");
    expect(
      windowLabel(
        { kind: "range", from: "2026-10-22T08:00:00Z", to: "2026-10-22T09:30:00Z" },
        "utc",
      ),
    ).toBe("10-22 08:00 – 10-22 09:30");
  });

  it("follows live only for short windows, and never for a fixed range", () => {
    expect(liveMode({ kind: "last", minutes: 5 })).toBe("live");
    expect(liveMode({ kind: "last", minutes: 15 })).toBe("live");
    expect(liveMode({ kind: "last", minutes: 60 })).toBe("paused");
    expect(
      liveMode({ kind: "range", from: "2026-10-22T08:00:00Z", to: "2026-10-22T09:00:00Z" }),
    ).toBe("off");
  });

  it("converts datetime-local input values in UTC and local time", () => {
    expect(fromDateTimeLocal("2026-10-22T08:15", "utc")).toBe("2026-10-22T08:15:00.000Z");
    expect(toDateTimeLocal("2026-10-22T08:15:00Z", "utc")).toBe("2026-10-22T08:15");
    const local = fromDateTimeLocal("2026-10-22T08:15", "local");
    expect(local).toBe(new Date(2026, 9, 22, 8, 15).toISOString());
    expect(toDateTimeLocal(local ?? "", "local")).toBe("2026-10-22T08:15");
    expect(fromDateTimeLocal("", "utc")).toBeNull();
  });
});

describe("liveHint", () => {
  const states = ["connecting", "live", "polling", "reconnecting", "paused", "failed"] as const;

  it("explains every state in plain words", () => {
    for (const state of states) {
      const hint = liveHint({
        state,
        message: null,
        userPaused: false,
        autoPaused: false,
        mode: "live",
      });
      expect(hint.length, state).toBeGreaterThan(20);
      // No symbols that render as emoji on Windows.
      expect(hint, state).not.toMatch(/[←-⯿\u{1F000}-\u{1FFFF}]/u);
    }
  });

  it("says why a view is paused", () => {
    const paused = { state: "paused", message: null } as const;
    expect(liveHint({ ...paused, userPaused: true, autoPaused: false, mode: "paused" })).toMatch(
      /longer than 15 minutes start paused/,
    );
    expect(liveHint({ ...paused, userPaused: false, autoPaused: true, mode: "live" })).toMatch(
      /hidden or the tab is in the background/,
    );
    expect(liveHint({ ...paused, userPaused: true, autoPaused: false, mode: "live" })).toMatch(
      /^Paused\. Resume/,
    );
  });

  it("keeps the backend's reason when there is one", () => {
    expect(
      liveHint({
        state: "polling",
        message: "AccessDenied; checking every 2 seconds instead",
        userPaused: false,
        autoPaused: false,
        mode: "live",
      }),
    ).toContain("AccessDenied");
  });
});
