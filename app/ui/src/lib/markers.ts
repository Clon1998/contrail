import type { ServiceDetail, Task } from "@/bindings";

/** What happened to the service at a point in time, shown between its log lines. */
export interface ServiceMarker {
  /** Milliseconds since the epoch. */
  at: number;
  kind: "deployment" | "task" | "event";
  title: string;
  /** A second line: why a task stopped, how a rollout went. */
  detail: string | null;
  /** Something went wrong (a failed rollout, a task that exited with an error). */
  failed: boolean;
  /** A stopped task, whose logs a click shows. */
  taskId: string | null;
}

/** Service events that say nothing happened (ECS logs one every few hours). */
const QUIET = /has reached a steady state/;

const ms = (timestamp: string | null) => (timestamp ? Date.parse(timestamp) : NaN);

/**
 * The service's deployments, stopped tasks (with the reason and exit codes) and service events
 * as markers, oldest first. A service event about a stopped task that is still listed is left
 * out: the task's own marker says more.
 */
export function serviceMarkers(detail: ServiceDetail | null, tasks: Task[]): ServiceMarker[] {
  const markers: ServiceMarker[] = [];
  for (const d of detail?.deployments ?? []) {
    const revision = d.taskDefinition.split("/").pop() ?? d.taskDefinition;
    markers.push({
      at: ms(d.createdAt),
      kind: "deployment",
      title: `Deployment of ${revision} started`,
      detail: null,
      failed: false,
      taskId: null,
    });
    // Only the primary deployment's rollout ends: an older one reports "completed" when it was
    // replaced, which reads like it was just rolled out.
    if (d.status === "PRIMARY" && (d.rolloutState === "COMPLETED" || d.rolloutState === "FAILED")) {
      const failed = d.rolloutState === "FAILED";
      markers.push({
        at: ms(d.updatedAt),
        kind: "deployment",
        title: `Deployment of ${revision} ${failed ? "failed" : "completed"}`,
        detail: d.rolloutReason,
        failed,
        taskId: null,
      });
    }
  }
  const stopped = tasks.filter((t) => t.stoppedAt);
  for (const t of stopped) {
    const exits = t.containers.filter((c) => c.exitCode !== null && c.exitCode !== 0);
    const exitText = exits.map((c) => `${c.name} exited with ${c.exitCode}`).join(", ");
    markers.push({
      at: ms(t.stoppedAt),
      kind: "task",
      title: `Task ${t.id.slice(0, 8)} stopped`,
      detail: [t.stoppedReason, exitText].filter(Boolean).join(" · ") || null,
      failed: exits.length > 0 || t.stopCode === "TaskFailedToStart",
      taskId: t.id,
    });
  }
  for (const e of detail?.events ?? []) {
    if (QUIET.test(e.message)) continue;
    if (/has stopped/.test(e.message) && stopped.some((t) => e.message.includes(t.id))) continue;
    markers.push({
      at: ms(e.createdAt),
      kind: "event",
      // "(service orders-api) has started 1 tasks: …": the service is the one shown.
      title: e.message.replace(/^\(service [^)]*\)\s*/, ""),
      detail: null,
      failed: false,
      taskId: null,
    });
  }
  return markers.filter((m) => !Number.isNaN(m.at)).sort((a, b) => a.at - b.at);
}

/** The markers after `after` up to and including `upTo` (milliseconds), e.g. between two rows. */
export function markersBetween(
  markers: ServiceMarker[],
  after: number,
  upTo: number,
): ServiceMarker[] {
  return markers.filter((m) => m.at > after && m.at <= upTo);
}
