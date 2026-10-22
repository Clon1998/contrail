import { useEffect } from "react";
import { CircleAlertIcon, Loader2Icon, RefreshCwIcon, StarIcon } from "lucide-react";
import { cn } from "cn";
import type { Deployment, ServiceDetail, Task } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useNow } from "@/hooks/useNow";
import { formatAgo, formatDateTime, nameFromArn, shortTaskId } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";
import { isSameService, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";
import { HealthDot } from "./HealthDot";

/** The open service is refreshed this often (only while it is shown). */
const REFRESH_MS = 30_000;

export function ServiceView() {
  const selected = useEcs((s) => s.selected);
  const detail = useEcs((s) => s.detail);
  const refresh = useEcs((s) => s.refreshService);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, selected]);

  if (!selected) return null;
  const data = "data" in detail ? detail.data : undefined;

  return (
    <main aria-label={`Service ${selected.serviceName}`} className="min-w-0 flex-1 overflow-y-auto">
      <Header />
      {detail.state === "error" && (
        <p className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {detail.error.message}
            {detail.error.hint && (
              <span className="block text-muted-foreground">{detail.error.hint}</span>
            )}
          </span>
        </p>
      )}
      {!data && detail.state === "loading" && (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> Loading service…
        </p>
      )}
      {data && (
        <div className="space-y-5 p-4">
          <Facts detail={data} />
          <Deployments deployments={data.deployments} />
          <Tasks />
          <Events detail={data} />
        </div>
      )}
    </main>
  );
}

function Header() {
  const selected = useEcs((s) => s.selected);
  const detail = useEcs((s) => s.detail);
  const refresh = useEcs((s) => s.refreshService);
  const profile = useProfiles((s) => s.selected);
  const favorites = usePrefs((s) => s.prefs.favorites);
  const toggleFavorite = usePrefs((s) => s.toggleFavorite);
  if (!selected || !profile) return null;

  const summary = "data" in detail ? detail.data?.summary : undefined;
  const pinned = favorites.some((f) => isSameService(f, profile, selected));

  return (
    <header className="flex items-center gap-2 border-b border-border px-4 py-2">
      {summary && <HealthDot service={summary} />}
      <h1 className="truncate text-base font-semibold">{selected.serviceName}</h1>
      <span className="truncate text-sm text-muted-foreground">
        {nameFromArn(selected.clusterArn)}
      </span>
      {summary && summary.status !== "ACTIVE" && <Badge variant="outline">{summary.status}</Badge>}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={pinned ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={pinned}
        onClick={() => void toggleFavorite(profile, selected)}
      >
        <StarIcon className={pinned ? "fill-amber-400 text-amber-400" : undefined} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label="Refresh service"
        onClick={() => void refresh()}
      >
        <RefreshCwIcon className={detail.state === "loading" ? "animate-spin" : undefined} />
      </Button>
    </header>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-sm">{children}</dd>
    </div>
  );
}

/** `"512"` CPU units → `0.5 vCPU`; `"1024"` MiB → `1 GB`. */
function formatResources(cpu: string | null, memory: string | null): string {
  const vcpu = cpu ? `${Number(cpu) / 1024} vCPU` : "—";
  const mem = memory ? `${Number(memory) / 1024} GB` : "—";
  return `${vcpu} / ${mem}`;
}

function Facts({ detail }: { detail: ServiceDetail }) {
  const { summary, taskDefinition } = detail;
  const container = taskDefinition?.containers[0];
  return (
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-5">
      <Fact label="Tasks (running / desired)">
        {summary.running} / {summary.desired}
        {summary.pending > 0 && <span className="text-warning"> · {summary.pending} pending</span>}
      </Fact>
      <Fact label="Task definition">{summary.taskDefinition}</Fact>
      <Fact label="Image">{container ? container.imageTag : "—"}</Fact>
      <Fact label="CPU / memory">
        {taskDefinition ? formatResources(taskDefinition.cpu, taskDefinition.memory) : "—"}
      </Fact>
      <Fact label="Launch type">
        {summary.launchType ?? "capacity provider"}
        {detail.platformVersion && (
          <span className="text-muted-foreground"> {detail.platformVersion}</span>
        )}
      </Fact>
    </dl>
  );
}

const ROLLOUT_TONE: Record<string, string> = {
  COMPLETED: "text-success",
  IN_PROGRESS: "text-warning",
  FAILED: "text-destructive",
};

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title}>
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const TH = "px-2 py-1 text-left font-normal text-muted-foreground";
const TD = "px-2 py-1 align-top";

/** The time zone setting, for absolute times in tooltips. */
function useTimeZone() {
  return usePrefs((s) => s.prefs.settings.timeZone);
}

function Deployments({ deployments }: { deployments: Deployment[] }) {
  const now = useNow();
  const timeZone = useTimeZone();
  return (
    <Section title="Deployments">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-xs">
          <tr>
            <th className={TH}>Status</th>
            <th className={TH}>Rollout</th>
            <th className={TH}>Task definition</th>
            <th className={TH}>Running / desired</th>
            <th className={TH}>Pending</th>
            <th className={TH}>Failed</th>
            <th className={TH}>Updated</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.id} className="border-b border-border/50">
              <td className={TD}>{d.status}</td>
              <td
                className={cn(TD, ROLLOUT_TONE[d.rolloutState ?? ""])}
                title={d.rolloutReason ?? undefined}
              >
                {d.rolloutState ?? "—"}
              </td>
              <td className={cn(TD, "font-mono")}>{d.taskDefinition}</td>
              <td className={cn(TD, "font-mono")}>
                {d.running} / {d.desired}
              </td>
              <td className={cn(TD, "font-mono")}>{d.pending}</td>
              <td className={cn(TD, "font-mono", d.failed > 0 && "text-destructive")}>
                {d.failed}
              </td>
              <td className={TD} title={formatDateTime(d.updatedAt, timeZone)}>
                {formatAgo(d.updatedAt, now)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function TaskStatus({ task }: { task: Task }) {
  const unhealthy = task.healthStatus === "UNHEALTHY";
  return (
    <span className={cn(task.lastStatus === "STOPPED" && "text-muted-foreground")}>
      {task.lastStatus}
      {task.healthStatus && task.healthStatus !== "UNKNOWN" && (
        <span className={cn("ml-1 text-xs", unhealthy ? "text-destructive" : "text-success")}>
          {task.healthStatus.toLowerCase()}
        </span>
      )}
    </span>
  );
}

function Tasks() {
  const tasks = useEcs((s) => s.tasks);
  const includeStopped = useEcs((s) => s.includeStopped);
  const setIncludeStopped = useEcs((s) => s.setIncludeStopped);
  const now = useNow();
  const timeZone = useTimeZone();
  const list = "data" in tasks ? (tasks.data ?? []) : [];

  return (
    <Section
      title="Tasks"
      action={
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={includeStopped}
          onClick={() => void setIncludeStopped(!includeStopped)}
          className={cn(
            includeStopped && "text-foreground",
            !includeStopped && "text-muted-foreground",
          )}
        >
          {includeStopped ? "Hide stopped" : "Show stopped"}
        </Button>
      }
    >
      {tasks.state === "error" && <p className="text-sm text-destructive">{tasks.error.message}</p>}
      {list.length === 0 && tasks.state === "ok" && (
        <p className="text-sm text-muted-foreground">No tasks.</p>
      )}
      {list.length > 0 && (
        <table className="w-full text-sm">
          <thead className="border-b border-border text-xs">
            <tr>
              <th className={TH}>Task</th>
              <th className={TH}>Status</th>
              <th className={TH}>Started</th>
              <th className={TH}>Zone</th>
              <th className={TH}>Revision</th>
              <th className={TH}>Stopped</th>
            </tr>
          </thead>
          <tbody>
            {list.map((task) => {
              const container = task.containers[0];
              return (
                <tr
                  key={task.arn}
                  aria-label={`Task ${shortTaskId(task.id)}`}
                  className="border-b border-border/50"
                >
                  <td className={cn(TD, "font-mono")} title={task.id}>
                    {shortTaskId(task.id)}
                  </td>
                  <td className={TD}>
                    <TaskStatus task={task} />
                  </td>
                  <td className={TD} title={formatDateTime(task.startedAt, timeZone)}>
                    {formatAgo(task.startedAt, now)}
                  </td>
                  <td className={cn(TD, "font-mono text-xs")}>{task.availabilityZone ?? "—"}</td>
                  <td className={cn(TD, "font-mono")}>{task.taskDefinition.split(":").at(-1)}</td>
                  <td className={TD}>
                    {task.lastStatus === "STOPPED" ? (
                      <div className="space-y-0.5">
                        <div title={formatDateTime(task.stoppedAt, timeZone)}>
                          {formatAgo(task.stoppedAt, now)} ·{" "}
                          <span className="font-mono text-xs">{task.stopCode}</span>
                          {container?.exitCode !== null && container?.exitCode !== undefined && (
                            <span
                              className={cn(
                                "ml-1 font-mono text-xs",
                                container.exitCode === 0
                                  ? "text-muted-foreground"
                                  : "text-destructive",
                              )}
                            >
                              exit {container.exitCode}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">{task.stoppedReason}</div>
                        {container?.reason && (
                          <div className="text-xs text-destructive">{container.reason}</div>
                        )}
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function Events({ detail }: { detail: ServiceDetail }) {
  const now = useNow();
  const timeZone = useTimeZone();
  if (detail.events.length === 0) return null;
  // Events read "(service orders-api) has reached a steady state."; the prefix is noise here.
  const prefix = `(service ${detail.summary.name}) `;
  return (
    <Section title="Recent events">
      <ul className="space-y-0.5 text-sm">
        {detail.events.map((event) => (
          <li key={event.id} className="flex gap-3">
            <span
              className="w-20 shrink-0 text-muted-foreground"
              title={formatDateTime(event.createdAt, timeZone)}
            >
              {formatAgo(event.createdAt, now)}
            </span>
            <span className="min-w-0">{event.message.replace(prefix, "")}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
