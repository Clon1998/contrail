import { useEffect, useState } from "react";
import { CircleAlertIcon, Columns3Icon, Loader2Icon, RefreshCwIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import type { Level } from "@/bindings";
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
import { usePrefs } from "@/stores/prefs";
import { OPTIONAL_COLUMNS } from "./columns";
import { LEVEL_TONE, LEVELS } from "./levels";
import { LogList } from "./LogList";

/** The Logs tab: a service's (or one task's) backfilled events in a virtualized list. */
export function LogViewer() {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const defaultMinutes = usePrefs((s) => s.prefs.settings.backfillMinutes);
  const [minutes, setMinutes] = useState(defaultMinutes);
  const { view, loading, error, open, close, taskFilter, showTask, columns, setColumn } = useLogs();
  // The task filter only applies to the service it was set for.
  const taskId = taskFilter && sameService(taskFilter.service, selected) ? taskFilter.taskId : null;

  useEffect(() => {
    if (ctx && selected) void open(ctx, selected, minutes, taskId);
  }, [ctx, selected, minutes, taskId, open]);

  // Free the view's buffer in Rust when the tab goes away.
  useEffect(() => () => void close(), [close]);

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
        {view && (
          <span className="truncate text-muted-foreground" title={view.location.logGroup}>
            {`${view.location.logGroup} · ${view.streams} ${view.streams === 1 ? "stream" : "streams"}`}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2" aria-label="Level counts">
          {view &&
            LEVELS.map((level) => (
              <span key={level} className={LEVEL_TONE[level]}>
                {level} {view.stats[level.toLowerCase() as Lowercase<Level>].toLocaleString()}
              </span>
            ))}
        </span>
        {view?.truncated && (
          <Badge
            variant="outline"
            title="The window holds more events than the buffer; the newest are missing."
          >
            truncated
          </Badge>
        )}
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
      {!loading && view && view.stats.total > 0 && (
        <LogList viewId={view.viewId} total={view.stats.total} showTask={taskId === null} />
      )}
    </div>
  );
}
