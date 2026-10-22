import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLineIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLogRows } from "@/hooks/useLogRows";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { gridTemplate } from "./columns";
import { LogRow } from "./LogRow";

/** How close to the end counts as "at the bottom" (follow mode), in pixels. */
const BOTTOM_SLACK = 8;

/**
 * The virtualized list of a view's events: only the rows on screen (plus a margin) exist in the
 * DOM, and their data is fetched page by page from the Rust buffer. Starts at the newest event
 * and stays there (follow mode) until you scroll up.
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
  const columns = useLogs((s) => s.columns);
  const { row, ensure } = useLogRows(viewId);
  const [atBottom, setAtBottom] = useState(true);

  // TanStack Virtual decides which rows to render. Rows have a fixed height until expanded;
  // `measureElement` corrects the size of rows that turn out taller. The React compiler can't
  // optimise this hook (it returns functions that change internally); that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => Math.round(fontSize * 1.6),
    overscan: 40,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;

  useEffect(() => {
    if (total > 0) ensure(first, last);
  }, [first, last, total, ensure]);

  // A new view (or font size) starts at the newest event.
  useEffect(() => {
    if (total > 0) virtualizer.scrollToIndex(total - 1, { align: "end" });
    setAtBottom(true);
  }, [viewId, total, fontSize, virtualizer]);

  const grid = gridTemplate(showTask, columns);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_SLACK);
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
            const event = row(item.index);
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
                  <LogRow event={event} grid={grid} showTask={showTask} />
                ) : (
                  <div className="px-3 text-muted-foreground/50">…</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {!atBottom && total > 0 && (
        <Button
          size="sm"
          className="absolute right-6 bottom-4 shadow-md"
          onClick={() => {
            virtualizer.scrollToIndex(total - 1, { align: "end" });
            setAtBottom(true);
          }}
        >
          <ArrowDownToLineIcon /> Jump to latest
        </Button>
      )}
    </div>
  );
}
