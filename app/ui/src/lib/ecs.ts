import type { ServiceSummary } from "@/bindings";
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

/** A local date-time for tooltips. */
export function formatDateTime(timestamp: string | null | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : "";
}

/** The first characters of a task ID, enough to tell tasks apart (like the console's badges). */
export function shortTaskId(id: string): string {
  return id.slice(0, 8);
}

/** `orders-api` from `arn:aws:ecs:…:cluster/orders-api`. */
export function nameFromArn(arn: string): string {
  return arn.split("/").at(-1) ?? arn;
}
