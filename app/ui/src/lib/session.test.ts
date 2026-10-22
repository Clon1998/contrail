import { describe, expect, it } from "vitest";
import type { Profile, SessionStatus } from "@/bindings";
import { describeSession, formatDuration, initialProfile, needsLogin } from "./session";

const NOW = Date.parse("2026-10-22T12:00:00Z");

function sso(name: string): Profile {
  return {
    name,
    region: "eu-central-1",
    auth: {
      kind: "sso",
      accountId: "111122223333",
      roleName: "ReadOnly",
      startUrl: "https://example.awsapps.com/start",
      ssoRegion: "eu-central-1",
      sessionName: "corp",
    },
  };
}

describe("formatDuration", () => {
  it("formats minutes and hours", () => {
    expect(formatDuration(30_000)).toBe("<1m");
    expect(formatDuration(9 * 60_000)).toBe("9m");
    expect(formatDuration((2 * 60 + 5) * 60_000)).toBe("2h 05m");
  });
});

describe("describeSession", () => {
  it.each<[SessionStatus, string, string]>([
    [{ state: "valid", expiresAt: "2026-10-22T19:00:00Z" }, "valid · 7h 00m", "ok"],
    [{ state: "expiringSoon", expiresAt: "2026-10-22T12:09:00Z" }, "expires in 9m", "warn"],
    [{ state: "refreshable" }, "valid · auto-refresh", "ok"],
    [{ state: "expired", expiredAt: "2026-10-22T10:00:00Z" }, "expired 2h 00m ago", "bad"],
    [{ state: "loggedOut" }, "logged out", "bad"],
    [{ state: "notSso" }, "not SSO", "muted"],
  ])("%j → %s", (status, label, tone) => {
    expect(describeSession(status, NOW)).toEqual({ label, tone });
  });

  it("shows a placeholder while loading", () => {
    expect(describeSession(undefined, NOW).tone).toBe("muted");
  });
});

describe("needsLogin", () => {
  it("is true only for expired and logged-out sessions", () => {
    expect(needsLogin({ state: "expired", expiredAt: "2026-10-22T10:00:00Z" })).toBe(true);
    expect(needsLogin({ state: "loggedOut" })).toBe(true);
    expect(needsLogin({ state: "refreshable" })).toBe(false);
    expect(needsLogin({ state: "notSso" })).toBe(false);
    expect(needsLogin(undefined)).toBe(false);
  });
});

describe("initialProfile", () => {
  it("prefers default, then the first usable session, then the first profile", () => {
    const profiles = [sso("a"), sso("b"), sso("c")];
    expect(initialProfile([...profiles, sso("default")], {})).toBe("default");
    expect(
      initialProfile(profiles, {
        a: { state: "loggedOut" },
        b: { state: "refreshable" },
      }),
    ).toBe("b");
    expect(initialProfile(profiles, { a: { state: "loggedOut" } })).toBe("a");
    expect(initialProfile([], {})).toBeNull();
  });
});
