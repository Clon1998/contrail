import { describe, expect, it } from "vitest";
import { durationText, parseTimeInput, windowChip, windowDetail, windowTitle } from "./timeInput";

// Friday, 2026-10-23 15:30 UTC.
const NOW = Date.parse("2026-10-23T15:30:00Z");
const parse = (text: string) => parseTimeInput(text, "utc", NOW);
const lastMinutes = (text: string) => {
  const result = parse(text);
  return result.kind === "ok" && result.window.kind === "last" ? result.window.minutes : result;
};
const range = (text: string) => {
  const result = parse(text);
  return result.kind === "ok" && result.window.kind === "range"
    ? [result.window.from, result.window.to]
    : result;
};

describe("parseTimeInput", () => {
  it("reads durations in minutes, hours, days and weeks", () => {
    expect(lastMinutes("15m")).toBe(15);
    expect(lastMinutes("15 min")).toBe(15);
    expect(lastMinutes("3h")).toBe(180);
    expect(lastMinutes("2d")).toBe(2880);
    expect(lastMinutes("1w")).toBe(10080);
    expect(lastMinutes("1h30m")).toBe(90);
    expect(lastMinutes("1h 30m")).toBe(90);
    expect(lastMinutes("1.5h")).toBe(90);
    expect(lastMinutes("last 2 hours")).toBe(120);
    expect(lastMinutes("  3H ")).toBe(180);
    expect(lastMinutes("90")).toBe(90);
  });

  it("reads 'since' and 'today' as windows until now", () => {
    expect(lastMinutes("today")).toBe(15 * 60 + 30);
    expect(lastMinutes("since 14:00")).toBe(90);
    expect(lastMinutes("since 2pm")).toBe(90);
    expect(lastMinutes("since yesterday 15:30")).toBe(1440);
    expect(lastMinutes("since yesterday")).toBe(1440 + 15 * 60 + 30);
  });

  it("reads days and time ranges as fixed ranges", () => {
    expect(range("yesterday")).toEqual(["2026-10-22T00:00:00.000Z", "2026-10-23T00:00:00.000Z"]);
    expect(range("2026-10-20")).toEqual(["2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"]);
    expect(range("oct 20")).toEqual(["2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"]);
    expect(range("20 Oct")).toEqual(["2026-10-20T00:00:00.000Z", "2026-10-21T00:00:00.000Z"]);
    expect(range("9:00-11:30")).toEqual(["2026-10-23T09:00:00.000Z", "2026-10-23T11:30:00.000Z"]);
    expect(range("9 – 11")).toEqual(["2026-10-23T09:00:00.000Z", "2026-10-23T11:00:00.000Z"]);
    expect(range("2pm to 3pm")).toEqual(["2026-10-23T14:00:00.000Z", "2026-10-23T15:00:00.000Z"]);
    expect(range("yesterday 9-11")).toEqual([
      "2026-10-22T09:00:00.000Z",
      "2026-10-22T11:00:00.000Z",
    ]);
    expect(range("oct 22 22:00 - oct 23 2:00")).toEqual([
      "2026-10-22T22:00:00.000Z",
      "2026-10-23T02:00:00.000Z",
    ]);
  });

  it("takes a time that hasn't come yet today as yesterday's", () => {
    expect(lastMinutes("since 16:00")).toBe(1410);
    expect(range("16:00-17:00")).toEqual(["2026-10-22T16:00:00.000Z", "2026-10-22T17:00:00.000Z"]);
  });

  it("ends a range on the next day when it wraps past midnight", () => {
    expect(range("yesterday 22:00-2:00")).toEqual([
      "2026-10-22T22:00:00.000Z",
      "2026-10-23T02:00:00.000Z",
    ]);
  });

  it("takes a month and day without a year as the last one", () => {
    expect(range("dec 24")).toEqual(["2025-12-24T00:00:00.000Z", "2025-12-25T00:00:00.000Z"]);
  });

  it("reads days and times in local time when that's the setting", () => {
    const local = parseTimeInput("9:00-10:00", "local", NOW);
    expect(local).toEqual({
      kind: "ok",
      window: {
        kind: "range",
        from: new Date(2026, 9, 23, 9, 0).toISOString(),
        to: new Date(2026, 9, 23, 10, 0).toISOString(),
      },
    });
  });

  it("names 'today' and 'since' windows by what was typed", () => {
    const title = (text: string) => {
      const result = parse(text);
      return result.kind === "ok" ? result.title : result;
    };
    expect(title("today")).toBe("Today");
    expect(title("since 14:00")).toBe("Since 14:00");
    expect(title("since yesterday 9:00")).toBe("Since Yesterday 09:00");
    expect(title("3h")).toBeUndefined();
  });

  it("explains what it can't read", () => {
    expect(parse("")).toEqual({ kind: "empty" });
    expect(parse("   ").kind).toBe("empty");
    expect(parse("soon").kind).toBe("invalid");
    expect(parse("5 parsecs").kind).toBe("invalid");
    expect(parse("0m").kind).toBe("invalid");
    expect(parse("25:00-26:00").kind).toBe("invalid");
    expect(parse("feb 30").kind).toBe("invalid");
    expect(parse("since tomorrow").kind).toBe("invalid");
    expect(parse("since today 16:00")).toEqual({ kind: "invalid", hint: "That's in the future." });
    expect(parse("today 16:00-17:00")).toEqual({ kind: "invalid", hint: "That's in the future." });
  });
});

describe("window labels", () => {
  const r = (from: string, to: string) => ({ kind: "range" as const, from, to });

  it("names durations short and long", () => {
    expect(durationText(15, "short")).toBe("15 min");
    expect(durationText(90, "short")).toBe("1 h 30 min");
    expect(durationText(2880, "short")).toBe("2 d");
    expect(durationText(60, "long")).toBe("1 hour");
    expect(durationText(1440, "long")).toBe("24 hours");
    expect(durationText(1530, "long")).toBe("25 hours 30 minutes");
    expect(durationText(3000, "long")).toBe("2 days 2 hours");
  });

  it("titles windows by what they cover", () => {
    expect(windowTitle({ kind: "last", minutes: 90 }, "utc", NOW)).toBe("Last 1 hour 30 minutes");
    expect(windowTitle(r("2026-10-22T00:00:00Z", "2026-10-23T00:00:00Z"), "utc", NOW)).toBe(
      "Yesterday",
    );
    expect(windowTitle(r("2026-10-19T00:00:00Z", "2026-10-21T00:00:00Z"), "utc", NOW)).toBe(
      "Oct 19 → Oct 20",
    );
    expect(windowTitle(r("2026-10-23T09:00:00Z", "2026-10-23T11:30:00Z"), "utc", NOW)).toBe(
      "Today 09:00 → 11:30",
    );
    expect(windowTitle(r("2026-10-22T22:00:00Z", "2026-10-23T02:00:00Z"), "utc", NOW)).toBe(
      "Yesterday 22:00 → Today 02:00",
    );
    expect(windowTitle(r("2025-12-24T08:00:00Z", "2025-12-24T09:00:00Z"), "utc", NOW)).toBe(
      "Dec 24, 2025 08:00 → 09:00",
    );
  });

  it("labels the button short and adds where a window starts or how long it is", () => {
    expect(windowChip({ kind: "last", minutes: 15 }, "utc", NOW)).toBe("Last 15 min");
    expect(windowDetail({ kind: "last", minutes: 15 }, "utc", NOW)).toBe("since 15:15");
    expect(windowDetail({ kind: "last", minutes: 2880 }, "utc", NOW)).toBe("since Oct 21 15:30");
    expect(windowDetail(r("2026-10-23T09:00:00Z", "2026-10-23T11:30:00Z"), "utc", NOW)).toBe(
      "2 hours 30 minutes",
    );
  });
});
