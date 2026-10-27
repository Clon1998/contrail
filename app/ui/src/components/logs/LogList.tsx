import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLineIcon, ArrowUpToLineIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { isToday } from "@/lib/logs";
import { markersBetween } from "@/lib/markers";
import { cachedIndexOf, PAGE_SIZE, type ScrollAnchor, useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { gridTemplate, useLogColumns } from "./columns";
import { LogRow } from "./LogRow";
import { MarkerBanner } from "./MarkerBanner";
import { useServiceMarkers } from "./useServiceMarkers";
import { OLDER_MARKER_HEIGHT, OlderMarker } from "./OlderMarker";

/** Rows fetched beyond the visible ones in each direction, so scrolling finds them loaded. */
const PREFETCH_ROWS = 400;
/** Older events are loaded when the oldest loaded row is this close (in pixels). */
const OLDER_MARGIN_PX = 2_000;

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
 *
 * Hiding the list (the Overview tab, another service tab) unmounts it; it saves where it was
 * scrolled to (`scrollAnchor`) and comes back there, unless it was following the newest event.
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
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  // Where the listed events start: the focus, or as far back as events are loaded.
  const from = useLogs((s) => s.focus?.start ?? s.view?.loadedFrom ?? null);
  // Where they end: the focus, or the window's end. (A service event after it shows up between
  // the lines once a newer line arrives.)
  const until = useLogs((s) => s.focus?.end ?? s.view?.to ?? null);
  const markers = useServiceMarkers();
  const pages = useLogs((s) => s.pages);
  const scrollTarget = useLogs((s) => s.scrollTarget);
  const prepended = useLogs((s) => s.prepended);
  const highlightMode = useLogs((s) => s.search.mode === "highlight");
  const positions = useLogs((s) => s.matchPositions);
  const current = useLogs((s) => s.matchPositions[s.currentMatch]);
  const matchSet = highlightMode ? new Set(positions) : null;
  const fetchRows = useLogs((s) => s.fetchRows);
  const newestFirst = usePrefs((s) => s.prefs.settings.newestFirst);
  const toData = (index: number) => (newestFirst ? total - 1 - index : index);
  const row = (index: number) => pages.get(Math.floor(index / PAGE_SIZE))?.[index % PAGE_SIZE];
  const savedAnchor = useLogs((s) => s.scrollAnchor);
  const setScrollAnchor = useLogs((s) => s.setScrollAnchor);
  const [atNewest, setAtNewest] = useState(savedAnchor === null);
  // The scroll position, kept up to date while scrolling (`null`: not scrolled since mounting).
  const scrolled = useRef<{ top: number; newest: boolean } | null>(null);
  // Works out the event at the top when the list unmounts: the rows there may have loaded only
  // after the last scroll event. Replaced on every render, so it sees the latest rows.
  const anchorNow = useRef<() => ScrollAnchor | null>(() => savedAnchor);
  // What the list was last positioned for (view, font size, order); `null` until mounted.
  const positionedFor = useRef<string | null>(null);
  // Jumps and prepends from before the list was mounted are done: only new ones move it.
  const handledTarget = useRef(scrollTarget);
  const handledPrepend = useRef(prepended);
  // Read inside effects without re-running them when it changes.
  const following = useRef(true);
  following.current = atNewest;
  const previousTotal = useRef(total);
  const loadOlder = useLogs((s) => s.loadOlder);
  const rowHeight = Math.round(fontSize * 1.6);

  // Back where it was when it was hidden, if that event is still loaded: the virtualizer starts
  // there (it scrolls to its initial offset whenever it attaches to the element, so scrolling
  // from an effect would be undone). Rows are all estimated the same height right after mounting.
  const [restoredOffset] = useState(() => {
    const index = savedAnchor ? cachedIndexOf(pages, savedAnchor.seq) : undefined;
    if (!savedAnchor || index === undefined) return null;
    const margin = newestFirst ? 0 : OLDER_MARKER_HEIGHT;
    return margin + toData(index) * rowHeight + savedAnchor.offset;
  });

  // TanStack Virtual decides which rows to render. Rows have a fixed height until expanded;
  // `measureElement` corrects the size of rows that turn out taller. The React compiler can't
  // optimise this hook (it returns functions that change internally); that is expected.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: total,
    initialOffset: restoredOffset ?? 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 40,
    // Oldest first, the marker of older events sits above the rows.
    scrollMargin: newestFirst ? 0 : OLDER_MARKER_HEIGHT,
    // Keyed by the event (its sequence number) once loaded, so a row keeps its measured height
    // (e.g. expanded) when rows are added in front of it.
    getItemKey: (index) => row(toData(index))?.seq ?? `row-${toData(index)}`,
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? 0;
  const scrollToNewest = () =>
    newestFirst
      ? virtualizer.scrollToIndex(0, { align: "start" })
      : virtualizer.scrollToIndex(total - 1, { align: "end" });

  // Load what's on screen plus a margin on both sides (again, after live updates made cached
  // pages stale). Each fetch is an IPC round trip; without the margin, fast scrolling shows
  // placeholder rows until the page arrives.
  const [dataFrom, dataTo] = newestFirst ? [toData(last), toData(first)] : [first, last];
  useEffect(() => {
    if (total > 0) {
      fetchRows(Math.max(0, dataFrom - PREFETCH_ROWS), Math.min(total - 1, dataTo + PREFETCH_ROWS));
    }
  }, [dataFrom, dataTo, total, pages, fetchRows]);

  anchorNow.current = () => {
    const position = scrolled.current;
    if (!position) return savedAnchor;
    if (position.newest) return null;
    const top = virtualizer.getVirtualItemForOffset(position.top);
    const event = top && row(toData(top.index));
    return top && event ? { seq: event.seq, offset: position.top - top.start } : null;
  };
  useEffect(() => () => setScrollAnchor(anchorNow.current()), [setScrollAnchor]);

  // A new view (or font size, or order) starts at the newest event. Right after mounting, the list
  // goes back to where it was instead. In development React runs effects twice: the second run
  // finds the same inputs and leaves the list alone.
  useEffect(() => {
    const inputs = `${viewId}|${fontSize}|${newestFirst}`;
    if (positionedFor.current === inputs) return;
    const mounting = positionedFor.current === null;
    positionedFor.current = inputs;
    if (mounting && restoredOffset !== null) return;
    if (total > 0) scrollToNewest();
    setAtNewest(true);
    // Only on these changes: new rows must not pull the user back to the newest event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, fontSize, newestFirst, virtualizer]);

  // Jumping to a match (search navigation).
  useEffect(() => {
    if (scrollTarget === handledTarget.current) return;
    handledTarget.current = scrollTarget;
    if (scrollTarget) {
      virtualizer.scrollToIndex(toData(scrollTarget.index), { align: "center" });
      setAtNewest(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollTarget, virtualizer]);

  // Older rows put in front (oldest first: at the top) would push what's on screen down: scroll
  // along. Newest first, they are added at the bottom and nothing moves.
  useEffect(() => {
    if (prepended === handledPrepend.current) return;
    handledPrepend.current = prepended;
    if (prepended && !newestFirst) {
      virtualizer.scrollToOffset((scrollRef.current?.scrollTop ?? 0) + prepended.count * rowHeight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepended]);

  // A list shorter than the screen can't be scrolled to its oldest row: load older right away.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && total > 0 && el.scrollHeight <= el.clientHeight) void loadOlder();
  }, [total, viewId, loadOlder]);

  // Follow mode: new rows keep the list at the newest event while the user is there. Newest
  // first, rows added on top would push what the user is reading down: scroll along instead.
  useEffect(() => {
    const added = total - previousTotal.current;
    previousTotal.current = total;
    if (total === 0) return;
    if (following.current) scrollToNewest();
    else if (newestFirst && added > 0) {
      // The element's position, not the virtualizer's: that one can lag behind a scroll.
      const offset = scrollRef.current?.scrollTop ?? 0;
      virtualizer.scrollToOffset(offset + added * Math.round(fontSize * 1.6));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total, virtualizer]);

  // Once the listed events reach back before today, every row shows its date: one format (and
  // column width) for the whole list.
  const withDate = from !== null && !isToday(Date.parse(from), timeZone);
  const grid = gridTemplate(showTask, columns, withDate);

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          const fromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
          if ((newestFirst ? fromBottom : el.scrollTop) < OLDER_MARGIN_PX) void loadOlder();
          const newest = newestFirst
            ? el.scrollTop <= EDGE_SLACK
            : el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_SLACK;
          setAtNewest(newest);
          scrolled.current = { top: el.scrollTop, newest };
        }}
        className="absolute inset-0 overflow-auto font-mono text-(length:--log-font-size) leading-[1.6]"
      >
        {!newestFirst && <OlderMarker />}
        <div
          role="list"
          aria-label="Log events"
          aria-rowcount={total}
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {items.map((item) => {
            const index = toData(item.index);
            const event = row(index);
            // The service's markers between this event and the one before it (oldest first),
            // and after the newest one.
            const previous = index === 0 ? from : row(index - 1)?.timestamp;
            const at = event && Date.parse(event.timestamp);
            const before = at && previous ? markersBetween(markers, Date.parse(previous), at) : [];
            const after =
              at && index === total - 1
                ? markersBetween(markers, at, until ? Date.parse(until) : Infinity)
                : [];
            const [above, below] = newestFirst ? [after, before] : [before, after];
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
                  transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                <MarkerBanner markers={above} />
                {event ? (
                  <LogRow
                    event={event}
                    grid={grid}
                    withDate={withDate}
                    showTask={showTask}
                    marked={matchSet?.has(index) ?? false}
                    current={current === index}
                  />
                ) : (
                  <div className="px-3 text-muted-foreground/50">…</div>
                )}
                <MarkerBanner markers={below} />
              </div>
            );
          })}
        </div>
        {newestFirst && <OlderMarker />}
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
