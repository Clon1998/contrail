import { describe, expect, it } from "vitest";
import {
  formatAgo,
  groupEvents,
  formatDateTime,
  nameFromArn,
  serviceHealth,
  looksSecret,
  shortTaskId,
} from "./ecs";

describe("serviceHealth", () => {
  it.each([
    [{ desired: 3, running: 3, pending: 0 }, "ok"],
    [{ desired: 3, running: 2, pending: 0 }, "warn"],
    [{ desired: 2, running: 2, pending: 1 }, "warn"],
    [{ desired: 2, running: 0, pending: 1 }, "bad"],
    [{ desired: 0, running: 0, pending: 0 }, "idle"],
  ])("%j → %s", (counts, health) => {
    expect(serviceHealth(counts)).toBe(health);
  });
});

describe("formatting", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(formatAgo("2026-10-22T11:55:00Z", now)).toBe("5m ago");
    expect(formatAgo(null, now)).toBe("—");
  });

  it("formats absolute times in UTC on request", () => {
    expect(formatDateTime("2026-10-22T11:55:00Z", "utc")).toMatch(/11:55:00.* UTC$/);
    expect(formatDateTime(null)).toBe("");
  });

  it("shortens IDs and ARNs", () => {
    expect(shortTaskId("0123456789abcdef0123456789abcdef")).toBe("01234567");
    expect(nameFromArn("arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core")).toBe(
      "demo-core",
    );
  });
});

describe("looksSecret", () => {
  it("flags names that usually hold credentials", () => {
    for (const name of [
      "DB_PASSWORD",
      "API_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "PRIVATE_KEY",
      "spring.datasource.password",
    ]) {
      expect(looksSecret(name), name).toBe(true);
    }
    for (const name of ["SERVER_PORT", "SPRING_PROFILES_ACTIVE", "ROUTES_0_KEYEXPRESSION"]) {
      expect(looksSecret(name), name).toBe(false);
    }
  });
});

describe("groupEvents", () => {
  const event = (id: string, at: string, message: string) => ({ id, createdAt: at, message });

  it("collapses repeats in a row and drops the service prefix", () => {
    const groups = groupEvents(
      [
        event("1", "2026-10-23T12:00:00Z", "(service api) has reached a steady state."),
        event("2", "2026-10-23T06:00:00Z", "(service api) has reached a steady state."),
        event("3", "2026-10-23T05:00:00Z", "(service api) has started 1 tasks: (task abc)."),
        event("4", "2026-10-23T00:00:00Z", "(service api) has reached a steady state."),
      ],
      "api",
    );
    expect(groups).toEqual([
      {
        id: "1",
        message: "has reached a steady state.",
        count: 2,
        latest: "2026-10-23T12:00:00Z",
        earliest: "2026-10-23T06:00:00Z",
      },
      {
        id: "3",
        message: "has started 1 tasks: (task abc).",
        count: 1,
        latest: "2026-10-23T05:00:00Z",
        earliest: "2026-10-23T05:00:00Z",
      },
      {
        id: "4",
        message: "has reached a steady state.",
        count: 1,
        latest: "2026-10-23T00:00:00Z",
        earliest: "2026-10-23T00:00:00Z",
      },
    ]);
  });
});
