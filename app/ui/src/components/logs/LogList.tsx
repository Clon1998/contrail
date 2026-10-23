import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLineIcon, ArrowUpToLineIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { PAGE_SIZE, useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { gridTemplate, useLogColumns } from "./columns";
import { LogRow } from "./LogRow";

/** How close to the newest end counts as "at the newest event" (follow mode), in pixels. */
const EDGE_SLACK = 8;

/**
 * The virtualized list of a view's events: only the rows on screen (plus a margin) exist in the
 * DOM, and their data is fetched page by page from the Rust buffer. Starts at the newest event
 * and stays there (follow mode) until you scroll away.
 *
 * The buffer is oldest first. With the "newest first" setting the list shows it the other way
 * round: list position `i` shows buffer index `total - 1 - i` (`toData`; the mapping is its own
 * inverse). Pages, matches and scroll targets stay in buffer indices.
 */
export function LogList({
  viewId,
  total,
  showTask,
}: {
  viewId: number;
  total: number;
  showTask: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fontSize = usePrefs((s) => s.prefs.settings.logFontSize);
  const columns = useLogColumns();
  const pages = useLogs((s) => s.pages);
  const scrollTarget = useLogs((s) => s.scrollTarget);
  const highlightMode = useLogs((s) => s.search.mode === "highlight");
  const positions = useLogs((s) => s.matchPositions);
  const current = useLogs((s) => s.matchPositions[s.currentMatch]);
  const matchSet = highlightMode ? new Set(positions) : null;
  const fetchRows = useLogs((s) => s.fetchRows);
  const newestFirst = usePrefs((s) => s.prefs.settings.newestFirst);
  const toData = (index: number) => (newestFirst ? total - 1 - index : index);
  const row = (index: number) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  const [atNewest, setAtNewest] = useState(true);
  // Read inside effects without re-running them when it changes.
  const following = useRef(true);
  following.current = atNewest;
  const previousTotal = useRef(total);

  // TanStack Virtual decides which rows to render. Rows have a fixed height until expanded;
  // `measureElement` corrects the size of rows that turn out taller. The React compiler can't
  // optimise this hook (it returns functions that change internally); that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => Math.round(fontSize * 1.6),
    overscan: 40,
    // Keyed by buffer index, so a row keeps its measured height (e.g. expanded) when newer
    // rows are added in front of it.
    getItemKey: toData,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  const scrollToNewest = () =>
    newestFirst
      ? virtualizer.scrollToIndex(0, { align: "start" })
      : virtualizer.scrollToIndex(total - 1, { align: "end" });

  // Load what's on screen (again, after live updates made cached pages stale).
  const [dataFrom, dataTo] = newestFirst ? [toData(last), toData(first)] : [first, last];
  useEffect(() => {
    if (total > 0) fetchRows(dataFrom, dataTo);
  }, [dataFrom, dataTo, total, pages, fetchRows]);

  // A new view (or font size, or order) starts at the newest event.
  useEffect(() => {
    if (total > 0) scrollToNewest();
    setAtNewest(true);
    // Only on these changes: new rows must not pull the user back to the newest event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, fontSize, newestFirst, virtualizer]);

  // Jumping to a match (search navigation).
  useEffect(() => {
    if (scrollTarget) {
      virtualizer.scrollToIndex(toData(scrollTarget.index), { align: "center" });
      setAtNewest(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget, virtualizer]);

  // Follow mode: new rows keep the list at the newest event while the user is there. Newest
  // first, rows added on top would push what the user is reading down: scroll along instead.
  useEffect(() => {
    const added = total - previousTotal.current;
    previousTotal.current = total;
    if (total === 0) return;
    if (following.current) scrollToNewest();
    else if (newestFirst && added > 0) {
      const offset = virtualizer.scrollOffset ?? 0;
      virtualizer.scrollToOffset(offset + added * Math.round(fontSize * 1.6));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, virtualizer]);

  const grid = gridTemplate(showTask, columns);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtNewest(
            newestFirst
              ? el.scrollTop <= EDGE_SLACK
              : el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_SLACK,
          );
        }}
        className="absolute inset-0 overflow-auto font-mono text-(length:--log-font-size) leading-[1.6]"
      >
        <div
          role="list"
          aria-label="Log events"
          aria-rowcount={total}
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((item) => {
            const index = toData(item.index);
            const event = row(index);
            return (
              <div
                key={item.key}
                role="listitem"
                aria-posinset={item.index + 1}
                aria-setsize={total}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {event ? (
                  <LogRow
                    event={event}
                    grid={grid}
                    showTask={showTask}
                    marked={matchSet?.has(index) ?? false}
                    current={current === index}
                  />
                ) : (
                  <div className="px-3 text-muted-foreground/50">…</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atNewest && total > 0 && (
        <Button
          size="sm"
          className={cn("absolute right-6 shadow-md", newestFirst ? "top-4" : "bottom-4")}
          onClick={() => {
            scrollToNewest();
            setAtNewest(true);
          }}
        >
          {newestFirst ? <ArrowUpToLineIcon /> : <ArrowDownToLineIcon />} Jump to latest
        </Button>
      )}
    </div>
  );
}
