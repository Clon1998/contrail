import { ScrollTextIcon } from "lucide-react";
import { cn } from "cn";
import type { Deployment, ServiceDetail, Task } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Hint } from "@/components/ui/tooltip";
import { useNow } from "@/hooks/useNow";
import { formatAgo, formatDateTime, groupEvents, shortTaskId } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { Environment } from "./Environment";
import { OverviewCard } from "./OverviewCard";
import { Routes } from "./Routes";

/**
 * The Overview tab: tasks, deployments and the environment in the main column; the service's
 * details and its recent events in a side column (one column on narrow windows).
 */
export function Overview({ detail }: { detail: ServiceDetail }) {
  return (
    <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <Tasks />
        <Deployments deployments={detail.deployments} />
        {detail.taskDefinition && <Routes containers={detail.taskDefinition.containers} />}
        {detail.taskDefinition && <Environment containers={detail.taskDefinition.containers} />}
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Details detail={detail} />
        <Events detail={detail} />
      </div>
    </div>
  );
}

/**
 * A long name cut at the front ("…TaskDefinition4F2A9C1E:5"), so its end, e.g. a task definition's
 * revision, stays visible. The full name shows on hover.
 *
 * A right-to-left box puts the ellipsis at the start; the inner `dir="ltr"` keeps the text itself
 * in normal order (otherwise ":5" would be moved to the front).
 */
function StartTruncated({ text, align = "left" }: { text: string; align?: "left" | "right" }) {
  return (
    <span
      title={text}
      dir="rtl"
      className={cn("block truncate", align === "left" ? "text-left" : "text-right")}
    >
      <span dir="ltr">{text}</span>
    </span>
  );
}

/** The time zone setting, for absolute times in tooltips. */
function useTimeZone() {
  return usePrefs((s) => s.prefs.settings.timeZone);
}

/** `"512"` CPU units → `0.5 vCPU`; `"1024"` MiB → `1 GB`. */
function formatResources(cpu: string | null, memory: string | null): string {
  const vcpu = cpu ? `${Number(cpu) / 1024} vCPU` : "—";
  const mem = memory ? `${Number(memory) / 1024} GB` : "—";
  return `${vcpu} · ${mem}`;
}

function Details({ detail }: { detail: ServiceDetail }) {
  const { summary, taskDefinition } = detail;
  const container = taskDefinition?.containers[0];
  const rows: [string, React.ReactNode][] = [
    ["Task definition", <StartTruncated key="td" text={summary.taskDefinition} align="right" />],
    [
      "Image",
      container ? (
        <Hint key="image" content={container.image}>
          <span className="block truncate">{container.imageTag}</span>
        </Hint>
      ) : (
        "—"
      ),
    ],
    [
      "CPU · memory",
      taskDefinition ? formatResources(taskDefinition.cpu, taskDefinition.memory) : "—",
    ],
    [
      "Launch type",
      <span key="launch">
        {summary.launchType ?? "capacity provider"}
        {detail.platformVersion && (
          <span className="text-muted-foreground"> {detail.platformVersion}</span>
        )}
      </span>,
    ],
  ];
  return (
    <OverviewCard title="Details">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-right font-mono text-xs leading-5">{value}</dd>
          </div>
        ))}
      </dl>
    </OverviewCard>
  );
}

const ROLLOUT_TONE: Record<string, string> = {
  COMPLETED: "border-success/40 text-success",
  IN_PROGRESS: "border-warning/40 text-warning",
  FAILED: "border-destructive/40 text-destructive",
};

/** Running out of desired as a thin bar (amber while short). */
function Progress({ running, desired }: { running: number; desired: number }) {
  const share = desired === 0 ? 1 : Math.min(running / desired, 1);
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs tabular-nums">
        {running}/{desired}
      </span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", share < 1 ? "bg-warning" : "bg-success")}
          style={{ width: `${share * 100}%` }}
        />
      </span>
    </span>
  );
}

function Deployments({ deployments }: { deployments: Deployment[] }) {
  const now = useNow();
  const timeZone = useTimeZone();
  return (
    <OverviewCard title="Deployments" count={deployments.length}>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 w-24 text-muted-foreground">Status</TableHead>
            <TableHead className="h-8 w-32 text-muted-foreground">Rollout</TableHead>
            <TableHead className="h-8 text-muted-foreground">Task definition</TableHead>
            <TableHead className="h-8 w-40 text-muted-foreground">Running</TableHead>
            <TableHead className="h-8 w-24 text-muted-foreground">Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deployments.map((d) => (
            <TableRow key={d.id}>
              <TableCell className="text-xs font-medium">{d.status}</TableCell>
              <TableCell>
                <Hint content={d.rolloutReason}>
                  <Badge variant="outline" className={ROLLOUT_TONE[d.rolloutState ?? ""]}>
                    {d.rolloutState ?? "—"}
                  </Badge>
                </Hint>
              </TableCell>
              <TableCell className="font-mono text-xs">
                <StartTruncated text={d.taskDefinition} />
              </TableCell>
              <TableCell>
                <Progress running={d.running} desired={d.desired} />
                {(d.pending > 0 || d.failed > 0) && (
                  <span className="mt-0.5 flex gap-2 text-xs">
                    {d.pending > 0 && <span className="text-warning">{d.pending} pending</span>}
                    {d.failed > 0 && <span className="text-destructive">{d.failed} failed</span>}
                  </span>
                )}
              </TableCell>
              <TableCell
                className="text-xs text-muted-foreground"
                title={formatDateTime(d.updatedAt, timeZone)}
              >
                {formatAgo(d.updatedAt, now)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </OverviewCard>
  );
}

const STATUS_DOT: Record<string, string> = {
  RUNNING: "bg-success",
  PENDING: "bg-warning",
  PROVISIONING: "bg-warning",
  ACTIVATING: "bg-warning",
  STOPPED: "bg-muted-foreground/50",
};

function TaskStatus({ task }: { task: Task }) {
  const health = task.healthStatus && task.healthStatus !== "UNKNOWN" ? task.healthStatus : null;
  return (
    <span className="flex items-center gap-1.5">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          health === "UNHEALTHY" ? "bg-destructive" : (STATUS_DOT[task.lastStatus] ?? "bg-muted"),
        )}
      />
      <span className={cn("text-xs", task.lastStatus === "STOPPED" && "text-muted-foreground")}>
        {task.lastStatus.toLowerCase()}
      </span>
      {health && (
        <span
          className={cn("text-xs", health === "UNHEALTHY" ? "text-destructive" : "text-success")}
        >
          · {health.toLowerCase()}
        </span>
      )}
    </span>
  );
}

/** Why a task stopped: when, the stop code, the exit code and the reasons. */
function StopReason({ task }: { task: Task }) {
  const now = useNow();
  const timeZone = useTimeZone();
  const container = task.containers[0];
  const exitCode = container?.exitCode;
  return (
    <div className="space-y-0.5 text-xs whitespace-normal">
      <div>
        <span title={formatDateTime(task.stoppedAt, timeZone)}>
          {formatAgo(task.stoppedAt, now)}
        </span>
        {task.stopCode && (
          <>
            <span className="mx-1">·</span>
            <span className="font-mono">{task.stopCode}</span>
          </>
        )}
        {exitCode !== null && exitCode !== undefined && (
          <span
            className={cn(
              "ml-1 font-mono",
              exitCode === 0 ? "text-muted-foreground" : "text-destructive",
            )}
          >
            exit {exitCode}
          </span>
        )}
      </div>
      {task.stoppedReason && <div className="text-muted-foreground">{task.stoppedReason}</div>}
      {container?.reason && <div className="text-destructive">{container.reason}</div>}
    </div>
  );
}

function Tasks() {
  const tasks = useEcs((s) => s.tasks);
  const includeStopped = useEcs((s) => s.includeStopped);
  const setIncludeStopped = useEcs((s) => s.setIncludeStopped);
  const selected = useEcs((s) => s.selected);
  const showTask = useLogs((s) => s.showTask);
  const now = useNow();
  const timeZone = useTimeZone();
  const list = "data" in tasks ? (tasks.data ?? []) : [];

  return (
    <OverviewCard
      title="Tasks"
      count={list.length}
      action={
        <Button
          variant="outline"
          size="xs"
          aria-pressed={includeStopped}
          onClick={() => void setIncludeStopped(!includeStopped)}
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
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="h-8 text-muted-foreground">Task</TableHead>
              <TableHead className="h-8 text-muted-foreground">Status</TableHead>
              <TableHead className="h-8 text-muted-foreground">Image</TableHead>
              <TableHead className="h-8 text-muted-foreground">Revision</TableHead>
              <TableHead className="h-8 text-muted-foreground">Started</TableHead>
              <TableHead className="h-8 text-muted-foreground">Zone</TableHead>
              <TableHead className="h-8">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((task) => {
              const container = task.containers[0];
              return (
                <TableRow key={task.arn} aria-label={`Task ${shortTaskId(task.id)}`}>
                  <TableCell className="align-top font-mono text-xs" title={task.id}>
                    {shortTaskId(task.id)}
                  </TableCell>
                  <TableCell className="align-top">
                    <TaskStatus task={task} />
                    {task.lastStatus === "STOPPED" && <StopReason task={task} />}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    <Hint
                      content={
                        container?.image &&
                        [container.image, container.imageDigest].filter(Boolean).join("\n")
                      }
                    >
                      <span>{container?.imageTag ?? "—"}</span>
                    </Hint>
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs">
                    {task.taskDefinition.split(":").at(-1)}
                  </TableCell>
                  <TableCell
                    className="align-top text-xs text-muted-foreground"
                    title={formatDateTime(task.startedAt, timeZone)}
                  >
                    {formatAgo(task.startedAt, now)}
                  </TableCell>
                  <TableCell className="align-top font-mono text-xs text-muted-foreground">
                    {task.availabilityZone ?? "—"}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-label={`Logs of task ${shortTaskId(task.id)}`}
                      onClick={() => selected && showTask(selected, task.id)}
                    >
                      <ScrollTextIcon /> Logs
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </OverviewCard>
  );
}

function Events({ detail }: { detail: ServiceDetail }) {
  const now = useNow();
  const timeZone = useTimeZone();
  const groups = groupEvents(detail.events, detail.summary.name);
  if (groups.length === 0) return null;
  return (
    <OverviewCard title="Recent events">
      <ol className="space-y-3">
        {groups.map((group) => (
          <li key={group.id} className="text-sm">
            <p className="leading-snug">{group.message}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span title={formatDateTime(group.latest, timeZone)}>
                {formatAgo(group.latest, now)}
              </span>
              {group.count > 1 && (
                <Badge
                  variant="secondary"
                  className="h-4 px-1.5 text-[10px] tabular-nums"
                  title={`${group.count} times since ${formatDateTime(group.earliest, timeZone)}`}
                >
                  ×{group.count}
                </Badge>
              )}
            </p>
          </li>
        ))}
      </ol>
    </OverviewCard>
  );
}
