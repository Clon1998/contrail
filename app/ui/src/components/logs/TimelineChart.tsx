import { useEffect, useRef, useState } from "react";
import { commands, type LevelCounts, type Timeline } from "@/bindings";
import {
  bucketRange,
  rangePixels,
  selectionRange,
  timelineLabel,
  utcOffsetMinutes,
} from "@/lib/timeline";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

/** The chart's height in pixels (bars plus the labels under them). */
const BARS_HEIGHT = 40;
/** A bar is at least this wide, so the number of buckets follows the chart's width. */
const MIN_BAR_PX = 5;
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
  const setFocus = useLogs((s) => s.setFocus);
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
  const indexAt = (x: number) => Math.min(count - 1, Math.max(0, Math.floor(x / barWidth)));
  const localX = (clientX: number) => clientX - (box.current?.getBoundingClientRect().left ?? 0);
  const spansDays = timeline ? count * timeline.bucketMs >= 86_400_000 : false;
  const hovered = hover !== null && timeline ? timeline.buckets[hover] : undefined;
  const focused = focus && timeline && count > 0 ? rangePixels(timeline, focus, width) : null;
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
                      x={i * barWidth}
                      y={y}
                      width={Math.max(1, barWidth - 1)}
                      height={height}
                      className={fill}
                    />
                  );
                })}
              </g>
            );
          })}
        </svg>
        {focused && !drag && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 rounded-sm border border-primary/60 bg-primary/10"
            style={{ left: focused.left, width: Math.max(2, focused.width) }}
          />
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
          </div>
        )}
      </div>
      {timeline && count > 0 && (
        <div className="flex justify-between tabular-nums">
          <span>{timelineLabel(bucketRange(timeline, 0)[0], timeZone, spansDays)}</span>
          <span>
            {focus ? "Click or drag to focus elsewhere" : "Click or drag to focus the list"}
          </span>
          <span>{timelineLabel(bucketRange(timeline, count - 1)[1], timeZone, spansDays)}</span>
        </div>
      )}
    </div>
  );
}
