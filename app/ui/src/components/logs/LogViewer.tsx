import { useEffect } from "react";
import {
  CircleAlertIcon,
  Columns3Icon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type { LiveState } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { shortTaskId } from "@/lib/ecs";
import { BACKFILL_WINDOWS } from "@/lib/logs";
import { sameService, useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { OPTIONAL_COLUMNS } from "./columns";
import { ExportMenu } from "./ExportMenu";
import { LogList } from "./LogList";
import { SearchBar } from "./SearchBar";

const LIVE_LABEL: Record<LiveState, string> = {
  connecting: "Connecting…",
  live: "Live",
  polling: "Polling",
  reconnecting: "Reconnecting…",
  paused: "Paused",
  failed: "Stopped",
};

const LIVE_TONE: Record<LiveState, string> = {
  connecting: "bg-muted-foreground",
  live: "bg-success animate-pulse",
  polling: "bg-warning",
  reconnecting: "bg-warning animate-pulse",
  paused: "bg-muted-foreground",
  failed: "bg-destructive",
};

/** The live tail's state, sampling badge and pause/resume button. */
function LiveControls() {
  const live = useLogs((s) => s.live);
  const userPaused = useLogs((s) => s.pauseReasons.user);
  const autoPaused = useLogs((s) => s.pauseReasons.hidden || s.pauseReasons.background);
  const setPaused = useLogs((s) => s.setPaused);
  if (!live) return null;

  const hint =
    live.message ??
    (live.state === "paused" && !userPaused && autoPaused
      ? "Paused automatically (see the live tail settings); resumes when you're back."
      : undefined);
  return (
    <span className="flex items-center gap-1.5">
      <span
        role="status"
        aria-label={`Live tail: ${LIVE_LABEL[live.state]}`}
        title={hint}
        className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5"
      >
        <span className={cn("size-2 rounded-full", LIVE_TONE[live.state])} />
        {LIVE_LABEL[live.state]}
      </span>
      {live.sampled && (
        <Badge
          variant="outline"
          title="More than 500 events per second: CloudWatch sends a sample."
        >
          sampled
        </Badge>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={userPaused ? "Resume live tail" : "Pause live tail"}
        onClick={() => setPaused("user", !userPaused)}
      >
        {userPaused ? <PlayIcon /> : <PauseIcon />}
      </Button>
    </span>
  );
}

/** The Logs tab: a service's (or one task's) events, backfilled and then followed live. */
export function LogViewer() {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const view = useLogs((s) => s.view);
  const loading = useLogs((s) => s.loading);
  const error = useLogs((s) => s.error);
  const open = useLogs((s) => s.open);
  const ensureOpen = useLogs((s) => s.ensureOpen);
  const minutes = useLogs((s) => s.minutes);
  const setMinutes = useLogs((s) => s.setMinutes);
  const taskFilter = useLogs((s) => s.taskFilter);
  const showTask = useLogs((s) => s.showTask);
  const columns = useLogs((s) => s.columns);
  const setColumn = useLogs((s) => s.setColumn);
  const visible = useLogs((s) => s.visible);
  // The task filter only applies to the service it was set for.
  const taskId = taskFilter && sameService(taskFilter.service, selected) ? taskFilter.taskId : null;

  // The view stays open while its service tab exists (it's closed with the tab).
  useEffect(() => {
    if (ctx && selected) void ensureOpen(ctx, selected, minutes, taskId);
  }, [ctx, selected, minutes, taskId, ensureOpen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
        <div
          role="radiogroup"
          aria-label="Time window"
          className="flex rounded-md border border-border p-0.5"
        >
          {BACKFILL_WINDOWS.map((w) => (
            <button
              key={w.minutes}
              type="button"
              role="radio"
              aria-checked={w.minutes === minutes}
              onClick={() => setMinutes(w.minutes)}
              className={cn(
                "rounded px-2 py-0.5",
                w.minutes === minutes
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w.label}
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload logs"
          disabled={loading || !ctx || !selected}
          onClick={() => ctx && selected && void open(ctx, selected, minutes, taskId)}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </Button>
        {taskId && selected && (
          <Badge variant="secondary" className="gap-1 font-mono">
            task {shortTaskId(taskId)}
            <button
              type="button"
              aria-label="Show all tasks"
              onClick={() => showTask(selected, null)}
              className="rounded hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          </Badge>
        )}
        <LiveControls />
        {view && (
          <span className="truncate text-muted-foreground" title={view.location.logGroup}>
            {`${view.location.logGroup} · ${view.streams} ${view.streams === 1 ? "stream" : "streams"}`}
          </span>
        )}
        <span className="ml-auto" />
        {view?.truncated && (
          <Badge
            variant="outline"
            title="The window holds more events than the buffer; the newest are missing."
          >
            truncated
          </Badge>
        )}
        <ExportMenu />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Columns">
              <Columns3Icon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>Columns</DropdownMenuLabel>
            {OPTIONAL_COLUMNS.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={columns[column.id]}
                onCheckedChange={(checked) => setColumn(column.id, checked === true)}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {view && <SearchBar />}
      {error && (
        <p className="mx-4 mt-3 flex items-start gap-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {error.message}
            {error.hint && <span className="block text-muted-foreground">{error.hint}</span>}
          </span>
        </p>
      )}
      {loading && (
        <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2Icon className="size-4 animate-spin" /> Loading logs…
        </p>
      )}
      {!loading && view && view.stats.total === 0 && (
        <p className="p-4 text-sm text-muted-foreground">No log events in this time window.</p>
      )}
      {!loading && view && view.stats.total > 0 && visible === 0 && (
        <p className="p-4 text-sm text-muted-foreground">No events match the search.</p>
      )}
      {!loading && view && visible > 0 && (
        <LogList viewId={view.viewId} total={visible} showTask={taskId === null} />
      )}
    </div>
  );
}
