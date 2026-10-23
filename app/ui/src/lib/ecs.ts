import type { ServiceSummary, TimeZone } from "@/bindings";
import { formatDuration } from "./session";

/** How a service is doing, from its task counts. */
export type ServiceHealth = "ok" | "warn" | "bad" | "idle";

export function serviceHealth(service: Pick<ServiceSummary, "desired" | "running" | "pending">) {
  const { desired, running, pending } = service;
  if (desired === 0 && running === 0) return "idle" satisfies ServiceHealth;
  if (running === 0) return "bad" satisfies ServiceHealth;
  if (running < desired || pending > 0) return "warn" satisfies ServiceHealth;
  return "ok" satisfies ServiceHealth;
}

/** `5m ago`, `2h 05m ago`, or `—` without a time. */
export function formatAgo(timestamp: string | null | undefined, now: number): string {
  if (!timestamp) return "—";
  return `${formatDuration(now - Date.parse(timestamp))} ago`;
}

/** An absolute date-time for tooltips, in local time or UTC (the time zone setting). */
export function formatDateTime(
  timestamp: string | null | undefined,
  timeZone: TimeZone = "local",
): string {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return timeZone === "utc"
    ? `${date.toLocaleString(undefined, { timeZone: "UTC" })} UTC`
    : date.toLocaleString();
}

/** The first characters of a task ID, enough to tell tasks apart (like the console's badges). */
export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

/** `orders-api` from `arn:aws:ecs:…:cluster/orders-api`. */
export function nameFromArn(arn: string): string {
  return arn.split("/").at(-1) ?? arn;
}

/**
 * Whether an environment variable name usually holds a credential (its value is masked until
 * clicked). Matches whole words, so `ROUTES_0_KEYEXPRESSION` is not a "key".
 */
export function looksSecret(name: string): boolean {
  return /(^|[_.-])(PASSWORD|PASSWD|PWD|SECRET|TOKEN|CREDENTIALS?|API_?KEY|ACCESS_KEY|PRIVATE_KEY|KEY)([_.-]|$)/i.test(
    name,
  );
}

/** Service events in a row with the same message, shown once with a count. */
export interface EventGroup {
  /** The newest event's ID. */
  id: string;
  message: string;
  count: number;
  latest: string | null;
  earliest: string | null;
}

/**
 * Collapses consecutive events with the same message (ECS repeats "has reached a steady state"
 * every few hours) and drops the "(service <name>) " prefix every message starts with. `events`
 * are newest first, as ECS returns them.
 */
export function groupEvents(
  events: { id: string; createdAt: string | null; message: string }[],
  serviceName: string,
): EventGroup[] {
  const prefix = `(service ${serviceName}) `;
  const groups: EventGroup[] = [];
  for (const event of events) {
    const message = event.message.startsWith(prefix)
      ? event.message.slice(prefix.length)
      : event.message;
    const last = groups.at(-1);
    if (last?.message === message) {
      last.count++;
      last.earliest = event.createdAt;
    } else {
      groups.push({
        id: event.id,
        message,
        count: 1,
        latest: event.createdAt,
        earliest: event.createdAt,
      });
    }
  }
  return groups;
}
