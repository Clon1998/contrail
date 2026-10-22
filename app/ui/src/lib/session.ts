import type { Profile, SessionStatus } from "@/bindings";

/** How a session state is shown: a short label and a colour tone. */
export interface SessionView {
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
}

/** Formats a duration as `2h 05m`, `9m` or `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

/** The label and tone of a session state at time `now` (milliseconds since the epoch). */
export function describeSession(status: SessionStatus | undefined, now: number): SessionView {
  if (!status) return { label: "…", tone: "muted" };
  switch (status.state) {
    case "valid":
      return { label: `valid · ${formatDuration(Date.parse(status.expiresAt) - now)}`, tone: "ok" };
    case "expiringSoon":
      return {
        label: `expires in ${formatDuration(Date.parse(status.expiresAt) - now)}`,
        tone: "warn",
      };
    case "refreshable":
      return { label: "valid · auto-refresh", tone: "ok" };
    case "expired":
      return {
        label: `expired ${formatDuration(now - Date.parse(status.expiredAt))} ago`,
        tone: "bad",
      };
    case "loggedOut":
      return { label: "logged out", tone: "bad" };
    case "notSso":
      return { label: "not SSO", tone: "muted" };
  }
}

/** Whether `aws sso login` is needed before AWS calls can work. */
export function needsLogin(status: SessionStatus | undefined): boolean {
  return status?.state === "expired" || status?.state === "loggedOut";
}

/** Whether Contrail can log in for this profile (only SSO profiles). */
export function canLogin(profile: Profile | undefined): boolean {
  return profile?.auth.kind === "sso";
}

/** The account ID shown next to a profile, if its config names one. */
export function accountId(profile: Profile): string | null {
  return profile.auth.kind === "sso" ? profile.auth.accountId : null;
}

/**
 * The profile to select on start: `default` if it exists, otherwise the first profile with a
 * usable session, otherwise the first one.
 */
export function initialProfile(
  profiles: Profile[],
  statuses: Record<string, SessionStatus>,
): string | null {
  if (profiles.some((p) => p.name === "default")) return "default";
  const usable = profiles.find((p) => {
    const state = statuses[p.name]?.state;
    return state === "valid" || state === "expiringSoon" || state === "refreshable";
  });
  return (usable ?? profiles[0])?.name ?? null;
}
