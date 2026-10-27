import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { commands, type ApiError, type LineContext, type LogEvent } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { shortTaskId } from "@/lib/ecs";
import { isToday } from "@/lib/logs";
import { usePrefs } from "@/stores/prefs";
import { gridTemplate, useLogColumns } from "./columns";
import { LogListSkeleton } from "./LogListSkeleton";
import { LogRow } from "./LogRow";

/** Lines on each side at first, and how many more each "Earlier" / "Later" adds. */
const STEP = 25;

/**
 * The lines of the same task around `event`, without the view's search: what happened just
 * before and after a line the search found. The line itself is marked; more lines on either
 * side load on request (from the events loaded in the view). Mounted while open, so it starts
 * afresh each time.
 */
export function LineContextDialog({
  viewId,
  event,
  open,
  onOpenChange,
}: {
  viewId: number;
  event: LogEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [span, setSpan] = useState({ before: STEP, after: STEP });
  const [result, setResult] = useState<
    { kind: "done"; context: LineContext } | { kind: "error"; error: ApiError } | null
  >(null);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const columns = useLogColumns();
  const scroller = useRef<HTMLDivElement>(null);
  const marked = useRef<HTMLDivElement>(null);
  // Earlier lines go in above what's on screen: the height before, to stay at the same line.
  const heightBefore = useRef<number | null>(null);
  const centered = useRef(false);
  // Expanded lines here are separate from the list's.
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const toggle = (seq: number) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(seq)) next.add(seq);
      return next;
    });

  useEffect(() => {
    if (!open) return;
    let current = true;
    void commands.logContext(viewId, event.seq, span.before, span.after).then((r) => {
      if (!current) return;
      setResult(
        r.status === "ok" ? { kind: "done", context: r.data } : { kind: "error", error: r.error },
      );
    });
    return () => {
      current = false;
    };
  }, [open, viewId, event.seq, span]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || result?.kind !== "done") return;
    if (!centered.current) {
      centered.current = true;
      marked.current?.scrollIntoView({ block: "center" });
    } else if (heightBefore.current !== null) {
      element.scrollTop += element.scrollHeight - heightBefore.current;
    }
    heightBefore.current = null;
  }, [result]);

  const context = result?.kind === "done" ? result.context : null;
  const first = context?.events[0];
  const withDate = first ? !isToday(Date.parse(first.timestamp), timeZone) : false;
  const grid = gridTemplate(false, columns, withDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-3 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Surrounding lines</DialogTitle>
          <DialogDescription>
            Task {shortTaskId(event.taskId)}, before and after the marked line, without the search.
          </DialogDescription>
        </DialogHeader>
        {result === null && <LogListSkeleton timeline={false} label="Loading the lines" />}
        {result?.kind === "error" && (
          <p className="text-sm text-destructive">{result.error.message}</p>
        )}
        {context && (
          <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-auto rounded-md border border-border font-mono text-(length:--log-font-size) leading-[1.6]"
          >
            <More
              label="Earlier lines"
              shown={context.moreBefore}
              icon={<ChevronUpIcon />}
              onClick={() => {
                heightBefore.current = scroller.current?.scrollHeight ?? null;
                setSpan((s) => ({ ...s, before: s.before + STEP }));
              }}
            />
            <div role="list" aria-label="Surrounding lines">
              {context.events.map((e, i) => (
                <div
                  key={e.seq}
                  role="listitem"
                  ref={i === context.line ? marked : undefined}
                  aria-current={i === context.line || undefined}
                >
                  <LogRow
                    event={e}
                    grid={grid}
                    showTask={false}
                    withDate={withDate}
                    marked={i === context.line}
                    local={{ expanded: expanded.has(e.seq), toggle: () => toggle(e.seq) }}
                  />
                </div>
              ))}
            </div>
            <More
              label="Later lines"
              shown={context.moreAfter}
              icon={<ChevronDownIcon />}
              onClick={() => setSpan((s) => ({ ...s, after: s.after + STEP }))}
            />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function More({
  label,
  shown,
  icon,
  onClick,
}: {
  label: string;
  shown: boolean;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  if (!shown) return null;
  return (
    <div className="flex justify-center p-1 font-sans">
      <Button variant="ghost" size="xs" onClick={onClick}>
        {icon} {label}
      </Button>
    </div>
  );
}
