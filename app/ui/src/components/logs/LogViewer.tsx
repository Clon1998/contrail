import { useEffect } from "react";
import {
  CircleAlertIcon,
  Columns3Icon,
  ListTreeIcon,
  Loader2Icon,
  PauseIcon,
  PlayIcon,
  ChartColumnIcon,
  RefreshCwIcon,
  WrapTextIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type { LiveState, LogColumn, ServiceRef } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, shortTaskId } from "@/lib/ecs";
import { isTyping } from "@/lib/keys";
import { formatLogTime, isToday, liveHint, liveMode } from "@/lib/logs";
import { timelineLabel } from "@/lib/timeline";
import { sameService, useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { OPTIONAL_COLUMNS, useLogColumns } from "./columns";
import { ExportMenu } from "./ExportMenu";
import { FieldMappingDialog } from "./FieldMappingDialog";
import { FieldsPanel } from "./FieldsPanel";
import { LogList } from "./LogList";
import { LogListSkeleton } from "./LogListSkeleton";
import { OlderMarker } from "./OlderMarker";
import { SearchBar } from "./SearchBar";
import { ShareMenu } from "./ShareMenu";
import { TimelineChart } from "./TimelineChart";
import { TimeWindowPicker } from "./TimeWindowPicker";
import { Hint } from "@/components/ui/tooltip";
import { LoginAgain } from "@/components/profile/LoginAgain";

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
  const mode = useLogs((s) => liveMode(s.timeWindow));
  const hasView = useLogs((s) => s.view !== null);
  if (mode === "off" && hasView) {
    return (
      <Hint content="A fixed time range is not followed live.">
        <Badge variant="outline">fixed range</Badge>
      </Hint>
    );
  }
  if (!live) return null;

  const hint = liveHint({ state: live.state, message: live.message, userPaused, autoPaused, mode });
  return (
    <span className="flex items-center gap-1.5">
      <Hint content={hint}>
        <span
          role="status"
          aria-label={`Live tail: ${LIVE_LABEL[live.state]}`}
          className="flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5"
        >
          <span className={cn("size-2 rounded-full", LIVE_TONE[live.state])} />
          {LIVE_LABEL[live.state]}
        </span>
      </Hint>
      {live.sampled && (
        <Hint content="More than 500 events per second: CloudWatch sends a sample.">
          <Badge variant="outline">sampled</Badge>
        </Hint>
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

/**
 * How much of the window is loaded (views start with the newest events), and buttons to load
 * older ones; scrolling to the oldest row loads them too.
 */
function OlderControls() {
  const view = useLogs((s) => s.view);
  const older = useLogs((s) => s.older);
  const loadAll = useLogs((s) => s.loadAll);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  if (!view || view.complete) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      <Hint
        content={`Loaded from ${formatDateTime(view.loadedFrom, timeZone)}. Search and export cover the loaded events; scroll to the oldest row or press "Load all" for the whole window.`}
      >
        <span>since {formatLogTime(view.loadedFrom, timeZone).slice(0, 5)}</span>
      </Hint>
      {older.loading ? (
        <Loader2Icon aria-label="Loading older events" className="size-3.5 animate-spin" />
      ) : older.full ? (
        <Hint content="The buffer is full (see the buffer size setting): older events can't be added.">
          <Badge variant="outline">buffer full</Badge>
        </Hint>
      ) : (
        <Button
          variant="ghost"
          size="xs"
          tooltip="Load the whole time window (needed to search or export all of it)"
          onClick={() => void loadAll()}
        >
          Load all
        </Button>
      )}
      {older.error && (
        <Hint content={older.error.hint ?? older.error.message}>
          <CircleAlertIcon aria-label={older.error.message} className="size-3.5 text-destructive" />
        </Hint>
      )}
    </span>
  );
}

/** Why the live tail stopped, and a way to try again. */
function LiveFailure() {
  const live = useLogs((s) => s.live);
  const retry = useLogs((s) => s.retryLive);
  if (live?.state !== "failed") return null;
  const login = /credentials|token/i.test(live.message ?? "");
  const expired = login
    ? { code: "credentials" as const, message: live.message ?? "", hint: null }
    : null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 border-b border-destructive/40 bg-destructive/5 px-4 py-1.5 text-xs"
    >
      <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1">
        Live tail stopped: {live.message}
        <span className="block text-muted-foreground">
          {login
            ? "Log in again, then the tail resumes."
            : "The role lacks a permission (docs/iam-policy.json lists them). Retry once it's fixed."}
        </span>
      </span>
      <LoginAgain error={expired} onLoggedIn={retry} />
      <Button variant="outline" size="xs" onClick={retry}>
        <RefreshCwIcon /> Retry
      </Button>
    </div>
  );
}

/** Shows or hides the Fields panel; also with F. */
function FieldsToggle() {
  const open = useLogs((s) => s.fieldsOpen);
  const setOpen = useLogs((s) => s.setFieldsOpen);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key.toLowerCase() === "f" && plain && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(!open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, setOpen]);
  return (
    <Button
      variant={open ? "secondary" : "ghost"}
      size="xs"
      aria-pressed={open}
      tooltip="The fields of the matching events and their most common values (F)"
      onClick={() => setOpen(!open)}
    >
      <ListTreeIcon /> Fields
    </Button>
  );
}

/** Wraps long messages onto more lines, or cuts them off (a setting, the same for every view). */
function WrapToggle() {
  const wrap = usePrefs((s) => s.prefs.settings.wrapLines);
  const updateSettings = usePrefs((s) => s.updateSettings);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key.toLowerCase() === "w" && plain && !isTyping(event.target)) {
        event.preventDefault();
        void updateSettings({ wrapLines: !wrap });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wrap, updateSettings]);
  return (
    <Button
      variant={wrap ? "secondary" : "ghost"}
      size="icon-xs"
      aria-label="Wrap lines"
      aria-pressed={wrap}
      tooltip="Wrap long messages instead of cutting them off (W)"
      onClick={() => void updateSettings({ wrapLines: !wrap })}
    >
      <WrapTextIcon />
    </Button>
  );
}

/**
 * The part of the window the list is focused on (picked on the timeline), with a way back to the
 * whole window. It sits in the toolbar so it stays in sight when the timeline is hidden.
 */
function FocusChip() {
  const focus = useLogs((s) => s.focus);
  const setFocus = useLogs((s) => s.setFocus);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  if (!focus) return null;
  const [start, end] = [Date.parse(focus.start), Date.parse(focus.end)];
  const withDate = !isToday(start, timeZone);
  return (
    <span className="flex items-center gap-1 rounded-md border border-primary/50 bg-primary/10 py-0.5 pr-0.5 pl-2 tabular-nums">
      Focus {timelineLabel(start, timeZone, withDate)} – {timelineLabel(end, timeZone, false)}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Show the whole time window"
        tooltip="Show the whole time window again"
        onClick={() => void setFocus(null)}
      >
        <XIcon />
      </Button>
    </span>
  );
}

/** Shows or hides the timeline above the list (a setting, the same for every view). */
function TimelineToggle() {
  const shown = usePrefs((s) => s.prefs.settings.showTimeline);
  const updateSettings = usePrefs((s) => s.updateSettings);
  return (
    <Button
      variant={shown ? "secondary" : "ghost"}
      size="icon-xs"
      aria-label="Timeline"
      aria-pressed={shown}
      tooltip="Events over time, by level; drag across it to zoom in"
      onClick={() => void updateSettings({ showTimeline: !shown })}
    >
      <ChartColumnIcon />
    </Button>
  );
}

/** Radix Select can't use "" as a value, so "all tasks" gets a sentinel. */
const ALL_TASKS = "__all__";

/** All tasks of the service, or one of them (running tasks first). */
function TaskPicker({ service, taskId }: { service: ServiceRef; taskId: string | null }) {
  const tasks = useEcs((s) => s.tasks);
  const showTask = useLogs((s) => s.showTask);
  const list = "data" in tasks ? (tasks.data ?? []) : [];
  const sorted = [...list].sort(
    (a, b) => Number(b.lastStatus === "RUNNING") - Number(a.lastStatus === "RUNNING"),
  );
  // The chosen task may have dropped out of the list (e.g. stopped tasks hidden).
  const missing = taskId !== null && !list.some((t) => t.id === taskId);

  return (
    <Select
      value={taskId ?? ALL_TASKS}
      onValueChange={(value) => showTask(service, value === ALL_TASKS ? null : value)}
    >
      <SelectTrigger size="sm" aria-label="Task" className="h-6 font-mono text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_TASKS}>All tasks</SelectItem>
        {(sorted.length > 0 || missing) && <SelectSeparator />}
        {missing && <SelectItem value={taskId}>task {shortTaskId(taskId)}</SelectItem>}
        {sorted.map((task) => (
          <SelectItem key={task.id} value={task.id} className="font-mono text-xs">
            task {shortTaskId(task.id)}
            <span
              className={cn(
                "text-muted-foreground",
                task.lastStatus === "RUNNING" && "text-success",
              )}
            >
              {task.lastStatus}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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
  const timeWindow = useLogs((s) => s.timeWindow);
  const setWindow = useLogs((s) => s.setWindow);
  const taskFilter = useLogs((s) => s.taskFilter);
  const columns = useLogColumns();
  const updateSettings = usePrefs((s) => s.updateSettings);
  const setColumn = (column: LogColumn, shown: boolean) =>
    void updateSettings({
      logColumns: shown ? [...columns, column] : columns.filter((c) => c !== column),
    });
  const visible = useLogs((s) => s.visible);
  const fieldsOpen = useLogs((s) => s.fieldsOpen);
  const showTimeline = usePrefs((s) => s.prefs.settings.showTimeline);
  // The task filter only applies to the service it was set for.
  const taskId = taskFilter && sameService(taskFilter.service, selected) ? taskFilter.taskId : null;

  // The view stays open while its service tab exists (it's closed with the tab).
  useEffect(() => {
    if (ctx && selected) void ensureOpen(ctx, selected, timeWindow, taskId);
  }, [ctx, selected, timeWindow, taskId, ensureOpen]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-1.5 text-xs">
        <TimeWindowPicker value={timeWindow} onChange={setWindow} />
        <FocusChip />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Reload logs"
          tooltip="Reload the time window"
          disabled={loading || !ctx || !selected}
          onClick={() => ctx && selected && void open(ctx, selected, timeWindow, taskId)}
        >
          <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
        </Button>
        {selected && <TaskPicker service={selected} taskId={taskId} />}
        <LiveControls />
        {view && (
          <span className="truncate text-muted-foreground" title={view.location.logGroup}>
            {`${view.location.logGroup} · ${view.streams} ${view.streams === 1 ? "stream" : "streams"}`}
          </span>
        )}
        <OlderControls />
        <span className="ml-auto" />
        {view?.truncated && (
          <Hint content="More events than the buffer holds: some are missing (see the buffer size setting).">
            <Badge variant="outline">truncated</Badge>
          </Hint>
        )}
        {view && <FieldsToggle />}
        <FieldMappingDialog />
        <ExportMenu />
        <ShareMenu />
        <TimelineToggle />
        <WrapToggle />
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
                checked={columns.includes(column.id)}
                onCheckedChange={(checked) => setColumn(column.id, checked === true)}
              >
                {column.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <LiveFailure />
      {view && <SearchBar />}
      {error && (
        <p className="mx-4 mt-3 flex items-start gap-2 text-sm text-destructive">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>
            {error.message}
            {error.hint && <span className="block text-muted-foreground">{error.hint}</span>}
            <span className="mt-1.5 block empty:hidden">
              <LoginAgain
                error={error}
                onLoggedIn={() => ctx && selected && void open(ctx, selected, timeWindow, taskId)}
              />
            </span>
          </span>
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {loading && <LogListSkeleton timeline={showTimeline} label="Loading logs" />}
          {!loading && view && view.stats.total > 0 && showTimeline && (
            <TimelineChart viewId={view.viewId} />
          )}
          {!loading && view && view.stats.total === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No log events in this time window.</p>
          )}
          {!loading && view && view.stats.total > 0 && visible === 0 && (
            <div>
              <p className="p-4 text-sm text-muted-foreground">No events match the search.</p>
              {!view.complete && <OlderMarker />}
            </div>
          )}
          {!loading && view && visible > 0 && (
            <LogList viewId={view.viewId} total={visible} showTask={taskId === null} />
          )}
        </div>
        {view && fieldsOpen && <FieldsPanel />}
      </div>
    </div>
  );
}
