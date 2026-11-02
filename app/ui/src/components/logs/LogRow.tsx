import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import type { LogEvent } from "@/bindings";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { highlightSegments } from "@/lib/highlight";
import { formatFullTime, formatLogTime, stripAnsi } from "@/lib/logs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { Ansi } from "./Ansi";
import { columnText, columnValue, OPTIONAL_COLUMNS, useLogColumns } from "./columns";
import { LEVEL_TONE } from "./levels";
import { StateBadge } from "./StateBadge";
import { TaskTag } from "./TaskTag";
import { LineContextDialog } from "./LineContextDialog";
import { useLineActions } from "./lineActions";
import { LogDetails } from "./LogDetails";

/**
 * One log line: time, level, task, optional columns and the message; expands on click, and offers
 * the actions of its details on right click.
 */
export function LogRow({
  event,
  grid,
  showTask,
  withDate = false,
  marked = false,
  current = false,
  local,
}: {
  event: LogEvent;
  grid: string;
  showTask: boolean;
  /** Show the date in front of the time (the list decides for all its rows). */
  withDate?: boolean;
  /** A search match in highlight mode. */
  marked?: boolean;
  /** The match last jumped to. */
  current?: boolean;
  /**
   * Expanded or not outside the view's list (the surrounding lines): its own state, and the
   * details leave out what leads back to it.
   */
  local?: { expanded: boolean; toggle: () => void };
}) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const wrap = usePrefs((s) => s.prefs.settings.wrapLines);
  const listExpanded = useLogs((s) => s.expanded[event.seq] ?? false);
  const expanded = local ? local.expanded : listExpanded;
  const fresh = useLogs((s) => s.fresh[event.seq] ?? false);
  const toggle = useLogs((s) => s.toggleExpanded);
  const columns = useLogColumns();
  const terms = useLogs((s) => s.highlightTerms);
  const viewId = useLogs((s) => s.view?.viewId);
  const [aroundOpen, setAroundOpen] = useState(false);
  const { line } = event;
  const firstLine = line.message.split("\n", 1)[0] ?? "";
  const toggleRow = () => (local ? local.toggle() : toggle(event.seq));

  return (
    <div data-fresh={fresh || undefined} className={cn(fresh && "motion-safe:animate-row-in")}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={toggleRow}
            style={{ gridTemplateColumns: grid }}
            className={cn(
              "grid w-full items-baseline gap-x-2 px-3 text-left hover:bg-accent/50",
              expanded && "bg-accent/40",
              line.level === "ERROR" && "bg-destructive/5",
              marked && "bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]",
              current && "bg-primary/25",
            )}
          >
            <ChevronRightIcon
              className={cn("size-3 self-center text-muted-foreground", expanded && "rotate-90")}
            />
            <span
              className="text-muted-foreground tabular-nums"
              title={formatFullTime(event.timestamp, timeZone)}
            >
              {formatLogTime(event.timestamp, timeZone, withDate)}
            </span>
            <span
              className={cn(
                "font-semibold",
                line.level ? LEVEL_TONE[line.level] : "text-muted-foreground",
              )}
            >
              {line.level ?? "·"}
            </span>
            {showTask && <TaskTag taskId={event.taskId} className="truncate" />}
            {OPTIONAL_COLUMNS.filter((c) => columns.includes(c.id)).map((c) => (
              <span
                key={c.id}
                className="truncate text-muted-foreground"
                title={columnValue(event, c.id)}
              >
                {columnText(event, c.id)}
              </span>
            ))}
            <span className={wrap ? "wrap-anywhere whitespace-pre-wrap" : "truncate"}>
              {event.status && (
                <StateBadge state={event.status.state} className="mr-1.5 align-[1px]" />
              )}
              {terms.length > 0 ? (
                <Highlighted text={stripAnsi(firstLine)} terms={terms} />
              ) : (
                <Ansi text={firstLine} />
              )}
              {line.error?.errorType && (
                <span className="ml-2 text-destructive">
                  {line.error.errorType.split(".").at(-1)}
                </span>
              )}
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <LineMenu
            event={event}
            expanded={expanded}
            onToggle={toggleRow}
            onSurrounding={local ? undefined : () => setAroundOpen(true)}
          />
        </ContextMenuContent>
      </ContextMenu>
      {aroundOpen && viewId !== undefined && (
        <LineContextDialog viewId={viewId} event={event} open onOpenChange={setAroundOpen} />
      )}
      {expanded && <LogDetails event={event} nested={local !== undefined} />}
    </div>
  );
}

/**
 * A line's context menu: open or close it, then the same actions as its details. Mounted only
 * while the menu is open, so the rows on screen don't each work out their actions.
 */
function LineMenu({
  event,
  expanded,
  onToggle,
  onSurrounding,
}: {
  event: LogEvent;
  expanded: boolean;
  onToggle: () => void;
  onSurrounding?: () => void;
}) {
  const { actions, documentActions } = useLineActions(event, onSurrounding);
  return (
    <>
      <ContextMenuItem onSelect={onToggle}>
        <ChevronRightIcon className={cn(expanded && "rotate-90")} />
        {expanded ? "Collapse" : "Expand"}
      </ContextMenuItem>
      <ContextMenuSeparator />
      {actions.map(({ label, icon: Icon, run }) => (
        <ContextMenuItem key={label} onSelect={run}>
          <Icon /> {label}
        </ContextMenuItem>
      ))}
      {documentActions.length > 0 && (
        <>
          <ContextMenuSeparator />
          <ContextMenuLabel>Document</ContextMenuLabel>
          {documentActions.map(({ label, icon: Icon, run }) => (
            <ContextMenuItem key={label} onSelect={run}>
              <Icon /> {label}
            </ContextMenuItem>
          ))}
        </>
      )}
    </>
  );
}

/** Text with the search words marked. */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  return (
    <>
      {highlightSegments(text, terms).map((segment, i) =>
        segment.match ? (
          <mark key={i} className="rounded-sm bg-warning/40 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}
