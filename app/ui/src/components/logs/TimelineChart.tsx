import { useEffect, useRef, useState } from "react";
import { commands, type LevelCounts, type Timeline } from "@/bindings";
import {
  bucketRange,
  rangePixels,
  selectionRange,
  timelineLabel,
  utcOffsetMinutes,
} from "@/lib/timeline";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useServiceMarkers } from "./useServiceMarkers";
import { markersBetween } from "@/lib/markers";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

/** The bars' height in pixels: a strip above the list, not a chart of its own. */
const BARS_HEIGHT = 28;
/** A bar is at least this wide, so the number of buckets follows the chart's width. */
const MIN_BAR_PX = 5;
/**
 * A bar is at most this wide, centred in its bucket: few buckets (a short or sparse window)
 * would otherwise draw blocks.
 */
const MAX_BAR_PX = 6;
/** While events arrive live, the timeline is asked again at most this often. */
const REFRESH_MS = 1_000;

/** Bottom to top: errors first, so they stay visible at the foot of every bar. */
const STACK: { key: keyof LevelCounts; label: string; fill: string }[] = [
  { key: "error", label: "ERROR", fill: "fill-destructive" },
  { key: "warn", label: "WARN", fill: "fill-warning" },
  { key: "info", label: "INFO", fill: "fill-primary/55" },
  { key: "debug", label: "DEBUG", fill: "fill-muted-foreground/45" },
  { key: "trace", label: "TRACE", fill: "fill-muted-foreground/25" },
  { key: "none", label: "no level", fill: "fill-muted-foreground/35" },
];

const total = (b: LevelCounts) => b.error + b.warn + b.info + b.debug + b.trace + b.none;

/**
 * Events over time above the log list, stacked by level, counted in Rust from the listed events
 * (it follows the search). Clicking a bar, or dragging across bars, focuses the list on that part
 * of the window; the chart keeps showing the whole window, so another part can be picked.
 */
export function TimelineChart({ viewId }: { viewId: number }) {
  const total_ = useLogs((s) => s.view?.stats.total ?? 0);
  const visible = useLogs((s) => s.visible);
  const revision = useLogs((s) => s.searchRevision);
  const focus = useLogs((s) => s.focus);
  const viewport = useLogs((s) => s.viewport);
  const setFocus = useLogs((s) => s.setFocus);
  const markers = useServiceMarkers();
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // Where the pointer went down, for the handlers: they must not wait for a render (a quick click
  // on a busy machine ends before the state set on pointer down is rendered).
  const dragStart = useRef<number | null>(null);
  const lastFetch = useRef(0);

  // The chart's width decides how many buckets fit.
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Asked again when the events, the search or the width change; live updates at most once a
  // second (a trailing call catches the last change).
  useEffect(() => {
    if (width === 0) return;
    let current = true;
    const fetch = () => {
      lastFetch.current = Date.now();
      const buckets = Math.max(10, Math.floor(width / MIN_BAR_PX));
      void commands
        .logTimeline(viewId, buckets, utcOffsetMinutes(timeZone))
        .then((result) => current && result.status === "ok" && setTimeline(result.data));
    };
    const wait = Math.max(0, lastFetch.current + REFRESH_MS - Date.now());
    const timer = setTimeout(fetch, wait);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [viewId, total_, visible, revision, width, timeZone]);

  const count = timeline?.buckets.length ?? 0;
  const highest = timeline ? Math.max(1, ...timeline.buckets.map(total)) : 1;
  const barWidth = count > 0 ? width / count : 0;
  const drawnWidth = Math.max(1, Math.min(MAX_BAR_PX, barWidth - 1));
  const indexAt = (x: number) => Math.min(count - 1, Math.max(0, Math.floor(x / barWidth)));
  const localX = (clientX: number) => clientX - (box.current?.getBoundingClientRect().left ?? 0);
  const spansDays = timeline ? count * timeline.bucketMs >= 86_400_000 : false;
  const hovered = hover !== null && timeline ? timeline.buckets[hover] : undefined;
  const focused = focus && timeline && count > 0 ? rangePixels(timeline, focus, width) : null;
  // Where the rows on screen are in the window: a scrollbar thumb along the time axis.
  const onScreen =
    viewport && timeline && count > 0 ? rangePixels(timeline, viewport, width) : null;
  // Where the chart starts and ends, for the markers' positions.
  const [start, end] =
    timeline && count > 0
      ? [bucketRange(timeline, 0)[0], bucketRange(timeline, count - 1)[1]]
      : [0, 0];
  const shownMarkers = end > start ? markersBetween(markers, start - 1, end) : [];
  const markerX = (at: number) => ((at - start) / (end - start)) * width;
  const hoveredMarkers =
    hover !== null && timeline
      ? markersBetween(
          shownMarkers,
          bucketRange(timeline, hover)[0] - 1,
          bucketRange(timeline, hover)[1],
        )
      : [];
  const outsideFocus = (i: number) =>
    focused !== null &&
    ((i + 1) * barWidth <= focused.left || i * barWidth >= focused.left + focused.width);

  return (
    <div className="border-b border-border px-4 pt-1.5 pb-1 text-[11px] text-muted-foreground">
      <div
        ref={box}
        role="img"
        aria-label="Timeline of events"
        className="relative cursor-crosshair select-none"
        style={{ height: BARS_HEIGHT }}
        onPointerDown={(e) => {
          if (!timeline) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const x = localX(e.clientX);
          dragStart.current = x;
          setDrag({ from: x, to: x });
        }}
        onPointerMove={(e) => {
          const x = localX(e.clientX);
          if (count > 0) setHover(indexAt(x));
          const from = dragStart.current;
          if (from !== null) setDrag({ from, to: x });
        }}
        onPointerLeave={() => setHover(null)}
        onPointerUp={(e) => {
          // A click focuses the bar under it, a drag the bars under the drag.
          const from = dragStart.current;
          const to = localX(e.clientX);
          if (from !== null && timeline && count > 0) {
            const x1 = Math.abs(to - from) > 4 ? to : from;
            void setFocus(selectionRange(timeline, from, x1, width));
          }
          dragStart.current = null;
          setDrag(null);
        }}
      >
        {!timeline && <Skeleton className="absolute inset-0" />}
        <svg width={width} height={BARS_HEIGHT} aria-hidden className="block">
          {timeline?.buckets.map((bucket, i) => {
            let y = BARS_HEIGHT;
            return (
              <g key={i} opacity={outsideFocus(i) ? 0.3 : hover === null || hover === i ? 1 : 0.7}>
                {STACK.map(({ key, fill }) => {
                  const height = (bucket[key] / highest) * (BARS_HEIGHT - 2);
                  if (height <= 0) return null;
                  y -= height;
                  return (
                    <rect
                      key={key}
                      x={i * barWidth + (barWidth - drawnWidth) / 2}
                      y={y}
                      width={drawnWidth}
                      height={height}
                      className={fill}
                    />
                  );
                })}
              </g>
            );
          })}
          {shownMarkers.map((m) => (
            <line
              key={`${m.kind}-${m.at}-${m.title}`}
              x1={markerX(m.at)}
              x2={markerX(m.at)}
              y1={0}
              y2={BARS_HEIGHT}
              strokeWidth={1.5}
              strokeDasharray="3 2"
              className={
                m.failed
                  ? "stroke-destructive"
                  : m.kind === "deployment"
                    ? "stroke-primary"
                    : "stroke-muted-foreground/70"
              }
            />
          ))}
        </svg>
        {onScreen && !drag && (
          <div
            aria-hidden
            data-testid="timeline-viewport"
            className="pointer-events-none absolute inset-y-0 border-x border-foreground/40 bg-foreground/[0.06]"
            style={{ left: onScreen.left, width: Math.max(3, onScreen.width) }}
          />
        )}
        {focused && !drag && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 rounded-sm border border-primary/60 bg-primary/10"
            style={{ left: focused.left, width: Math.max(2, focused.width) }}
          />
        )}
        {/* Clears the focus right where it is; its pointer-down mustn't start a new drag. */}
        {focused && !drag && (
          <button
            type="button"
            aria-label="Clear the focus"
            title="Show the whole window again"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => void setFocus(null)}
            className="absolute top-0.5 z-10 flex size-4 items-center justify-center rounded-full border border-primary/60 bg-background text-primary shadow-sm hover:bg-primary hover:text-primary-foreground"
            style={{
              left: Math.min(width - 16, Math.max(0, focused.left + focused.width - 18)),
            }}
          >
            <XIcon className="size-3" />
          </button>
        )}
        {drag && Math.abs(drag.to - drag.from) > 4 && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 rounded-sm border border-primary bg-primary/15"
            style={{ left: Math.min(drag.from, drag.to), width: Math.abs(drag.to - drag.from) }}
          />
        )}
        {hovered && timeline && hover !== null && !drag && (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-full z-10 mt-1 rounded-md border border-border bg-popover px-2 py-1 whitespace-nowrap text-popover-foreground shadow-md"
            style={{
              left: Math.min(Math.max(0, hover * barWidth - 60), Math.max(0, width - 180)),
            }}
          >
            <p className="font-medium tabular-nums">
              {bucketRange(timeline, hover)
                .map((ms) => timelineLabel(ms, timeZone, spansDays))
                .join(" – ")}{" "}
              · {total(hovered).toLocaleString()} events
            </p>
            {STACK.filter(({ key }) => hovered[key] > 0).map(({ key, label }) => (
              <p key={key} className="tabular-nums">
                {label} {hovered[key].toLocaleString()}
              </p>
            ))}
            {hoveredMarkers.map((m) => (
              <p
                key={`${m.kind}-${m.at}-${m.title}`}
                className={m.failed ? "text-destructive" : "text-primary"}
              >
                {m.title}
              </p>
            ))}
          </div>
        )}
      </div>
      {timeline && count > 0 && (
        <div aria-hidden className="relative mt-0.5 h-0.5 rounded-full bg-border">
          {onScreen && (
            <div
              className="absolute inset-y-0 rounded-full bg-primary"
              style={{ left: onScreen.left, width: Math.max(8, onScreen.width) }}
            />
          )}
        </div>
      )}
      {timeline && count > 0 && (
        <div className="flex items-center justify-between tabular-nums">
          <span>{timelineLabel(bucketRange(timeline, 0)[0], timeZone, spansDays)}</span>
          {focus ? (
            <span className="flex items-center gap-1.5 text-foreground">
              Focused on {timelineLabel(Date.parse(focus.start), timeZone, spansDays)} –{" "}
              {timelineLabel(Date.parse(focus.end), timeZone, spansDays)}
              <Button
                variant="outline"
                size="xs"
                className="h-5 px-1.5 text-[11px]"
                aria-label="Show the whole time window"
                tooltip="Show the whole time window again (or click or drag elsewhere)"
                onClick={() => void setFocus(null)}
              >
                <XIcon /> Show all
              </Button>
            </span>
          ) : (
            <span>Click or drag to focus the list</span>
          )}
          <span>{timelineLabel(bucketRange(timeline, count - 1)[1], timeZone, spansDays)}</span>
        </div>
      )}
    </div>
  );
}
