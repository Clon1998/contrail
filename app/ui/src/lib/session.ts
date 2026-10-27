import type { ApiError, Profile, SessionStatus } from "@/bindings";

/** How a session state is shown: a short label and a colour tone. */
export interface SessionView {
  label: string;
  tone: "ok" | "warn" | "bad" | "muted";
}

/** Formats a duration as `3d 4h`, `2h 05m`, `9m` or `<1m`. */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(Math.abs(ms) / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  const rest = minutes % 60;
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, "0")}m` : `${rest}m`;
}

/**
 * The label and tone of a session state at time `now` (milliseconds since the epoch).
 * `rejected`: AWS turned the session down although the local token cache looks fine.
 */
export function describeSession(
  status: SessionStatus | undefined,
  now: number,
  rejected = false,
): SessionView {
  if (rejected) return { label: "session rejected", tone: "bad" };
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
export function needsLogin(status: SessionStatus | undefined, rejected = false): boolean {
  return rejected || status?.state === "expired" || status?.state === "loggedOut";
}

/**
 * Whether AWS rejected the selected profile's credentials. The token cache can look valid (or
 * refreshable) while the session has ended on the AWS side; only a real call tells.
 */
export function isRejected(identity: { state: string; error?: ApiError }): boolean {
  return identity.state === "error" && identity.error?.code === "credentials";
}

/** Whether an error comes from an expired or revoked session (logging in again fixes it). */
export const sessionExpired = (error: ApiError | null | undefined) => error?.code === "credentials";

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

/**
 * A short name for who the credentials belong to: the role (for SSO the permission set, without
 * the `AWSReservedSSO_` prefix and the hash suffix) or the IAM user.
 */
export function roleName(arn: string): string {
  const resource = arn.split(":").slice(5).join(":");
  const [kind, name = kind] = resource.split("/");
  if (kind === "assumed-role" || kind === "user") {
    const sso = /^AWSReservedSSO_(.+)_[0-9a-f]+$/.exec(name ?? "");
    return sso?.[1] ?? name ?? resource;
  }
  return resource;
}
