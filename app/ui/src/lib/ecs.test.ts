import { describe, expect, it } from "vitest";
import {
  formatAgo,
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
