import { describe, expect, it } from "vitest";
import { formatClock, formatDate, formatDayName } from "./timeFormat";

describe("formatDate", () => {
  const day = { y: 2026, m: 3, d: 7 };

  it("writes dates in numbers, with or without the year", () => {
    expect(formatDate(day, "iso")).toBe("2026-03-07");
    expect(formatDate(day, "dayMonthYear")).toBe("07.03.2026");
    expect(formatDate(day, "monthDayYear")).toBe("03/07/2026");
    expect(formatDate(day, "iso", false)).toBe("03-07");
    expect(formatDate(day, "dayMonthYear", false)).toBe("07.03.");
    expect(formatDate(day, "monthDayYear", false)).toBe("03/07");
  });

  it("writes the month in words, day first for day-month-year", () => {
    expect(formatDayName(day, "dayMonthYear")).toBe("7 Mar");
    expect(formatDayName(day, "monthDayYear")).toBe("Mar 7");
    expect(formatDayName(day, "dayMonthYear", true)).toBe("7 Mar 2026");
    expect(formatDayName(day, "iso", true)).toBe("Mar 7, 2026");
  });
});

describe("formatClock", () => {
  const at = (hour: number) => ({ hour, minute: 5, second: 7, ms: 42 });

  it("writes 24-hour times", () => {
    expect(formatClock(at(0), "h24")).toBe("00:05");
    expect(formatClock(at(14), "h24", { seconds: true })).toBe("14:05:07");
    expect(formatClock(at(14), "h24", { ms: true })).toBe("14:05:07.042");
  });

  it("writes 12-hour times, with midnight and noon as 12", () => {
    expect(formatClock(at(0), "h12")).toBe("12:05 AM");
    expect(formatClock(at(9), "h12")).toBe("9:05 AM");
    expect(formatClock(at(12), "h12")).toBe("12:05 PM");
    expect(formatClock(at(23), "h12", { seconds: true })).toBe("11:05:07 PM");
  });

  it("pads 12-hour times for columns", () => {
    expect(formatClock(at(9), "h12", { ms: true, fixedWidth: true })).toBe("09:05:07.042 AM");
  });
});
