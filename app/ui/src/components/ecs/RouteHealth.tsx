import { useEffect, useRef, useState } from "react";
import { ScrollTextIcon } from "lucide-react";
import { cn } from "cn";
import { commands, type RouteHealth as Health, type TopicHealth } from "@/bindings";
import { Button } from "@/components/ui/button";
import { formatShortTime } from "@/lib/logs";
import { useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

/** Buckets in a sparkline. */
const BUCKETS = 40;
/** While events arrive live, the health is counted again at most this often. */
const REFRESH_MS = 2_000;

/**
 * How the service's documents ended, per topic and consumer group: done, retrying, failed, the
 * failure rate and the throughput over time. Counted in Rust from the status events of the
 * service's log view (its time window), so nothing is read from AWS for it; without a view, it
 * offers to load the logs.
 */
export function RouteHealthSection({
  expected,
}: {
  /** The service's own topics and groups (from its routes): listed even without events. */
  expected: { topic: string; group: string | null }[];
}) {
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const view = useLogs((s) => s.view);
  const loading = useLogs((s) => s.loading);
  const ensureOpen = useLogs((s) => s.ensureOpen);
  const timeWindow = useLogs((s) => s.timeWindow);
  const taskId = useLogs((s) => s.taskId);
  const total = useLogs((s) => s.view?.stats.total ?? 0);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const [health, setHealth] = useState<Health | null>(null);
  const lastFetch = useRef(0);

  useEffect(() => {
    if (!view) return;
    let current = true;
    const fetch = () => {
      lastFetch.current = Date.now();
      void commands
        .routeHealth(view.viewId, BUCKETS)
        .then((result) => current && result.status === "ok" && setHealth(result.data));
    };
    const timer = setTimeout(fetch, Math.max(0, lastFetch.current + REFRESH_MS - Date.now()));
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [view, total]);

  return (
    <section aria-label="Route health" className="mt-4 space-y-2">
      <h4 className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-medium tracking-wide text-muted-foreground uppercase">Health</span>
        {view && (
          <span className="text-muted-foreground">
            from the logs loaded since {formatShortTime(view.loadedFrom, timeZone)}
            {taskId && " (one task)"}
          </span>
        )}
      </h4>
      {!view && (
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Counted from the service's logs (status events).
          <Button
            variant="outline"
            size="xs"
            disabled={loading || !ctx || !selected}
            onClick={() => ctx && selected && void ensureOpen(ctx, selected, timeWindow, taskId)}
          >
            <ScrollTextIcon /> Load the logs
          </Button>
        </p>
      )}
      {view && health && rows(health.topics, expected).length === 0 && (
        <p className="text-xs text-muted-foreground">No status events in the logs loaded.</p>
      )}
      {view && health && rows(health.topics, expected).length > 0 && (
        <table aria-label="Health per topic" className="w-full text-left text-xs">
          <thead className="text-[11px] text-muted-foreground">
            <tr>
              <th className="pb-1 font-medium">Topic</th>
              <th className="pb-1 font-medium">Group</th>
              <th className="pb-1 text-right font-medium">Done</th>
              <th className="pb-1 text-right font-medium">Retrying</th>
              <th className="pb-1 text-right font-medium">Failed</th>
              <th className="pb-1 text-right font-medium">Failure rate</th>
              <th className="pb-1 pl-4 font-medium">Over time</th>
            </tr>
          </thead>
          <tbody>
            {rows(health.topics, expected).map((t) => (
              <HealthRow key={`${t.topic}|${t.consumerGroup ?? ""}`} topic={t} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * The counted topics, then the service's own topics that logged nothing (a route without traffic
 * is worth seeing too), each topic and group once.
 */
function rows(
  counted: TopicHealth[],
  expected: { topic: string; group: string | null }[],
): TopicHealth[] {
  const seen = new Set(counted.map((t) => `${t.topic}|${t.consumerGroup ?? ""}`));
  // A route without a group of its own reads with the service's: its topic alone counts.
  const seenTopics = new Set(counted.map((t) => t.topic));
  const quiet = expected
    .filter((e, i) => {
      const key = `${e.topic}|${e.group ?? ""}`;
      const first = expected.findIndex((o) => `${o.topic}|${o.group ?? ""}` === key) === i;
      return first && !(e.group === null ? seenTopics.has(e.topic) : seen.has(key));
    })
    .map((e) => ({
      topic: e.topic,
      consumerGroup: e.group,
      done: 0,
      retrying: 0,
      failed: 0,
      doneOverTime: [],
      failedOverTime: [],
    }));
  return [...counted, ...quiet];
}

function HealthRow({ topic: t }: { topic: TopicHealth }) {
  const ended = t.done + t.failed + t.retrying;
  if (ended === 0) {
    return (
      <tr
        aria-label={`Health of ${t.topic}${t.consumerGroup ? ` for ${t.consumerGroup}` : ""}`}
        className="border-t border-border/60 text-muted-foreground"
      >
        <td className="py-1 pr-3 font-mono">{t.topic}</td>
        <td className="py-1 pr-3 font-mono">{t.consumerGroup ?? "—"}</td>
        <td colSpan={5} className="py-1 text-right">
          no status events
        </td>
      </tr>
    );
  }
  return <CountedRow topic={t} />;
}

function CountedRow({ topic: t }: { topic: TopicHealth }) {
  const ended = t.done + t.failed;
  const rate = ended > 0 ? t.failed / ended : 0;
  return (
    <tr
      aria-label={`Health of ${t.topic}${t.consumerGroup ? ` for ${t.consumerGroup}` : ""}`}
      className="border-t border-border/60"
    >
      <td className="py-1 pr-3 font-mono font-medium">{t.topic}</td>
      <td className="py-1 pr-3 font-mono text-muted-foreground">{t.consumerGroup ?? "—"}</td>
      <td className="py-1 text-right tabular-nums">{t.done.toLocaleString()}</td>
      <td className={cn("py-1 text-right tabular-nums", t.retrying > 0 && "text-warning")}>
        {t.retrying.toLocaleString()}
      </td>
      <td className={cn("py-1 text-right tabular-nums", t.failed > 0 && "text-destructive")}>
        {t.failed.toLocaleString()}
      </td>
      <td
        className={cn(
          "py-1 text-right tabular-nums",
          rate >= 0.05 ? "text-destructive" : rate > 0 ? "text-warning" : "text-muted-foreground",
        )}
      >
        {ended > 0 ? `${(rate * 100).toFixed(rate > 0 && rate < 0.01 ? 2 : 1)} %` : "—"}
      </td>
      <td className="py-1 pl-4">
        <Sparkline done={t.doneOverTime} failed={t.failedOverTime} />
      </td>
    </tr>
  );
}

/** Done (blue) and failed (red, on top) per bucket, as thin bars. */
function Sparkline({ done, failed }: { done: number[]; failed: number[] }) {
  const height = 18;
  const bar = 3;
  const highest = Math.max(1, ...done.map((d, i) => d + (failed[i] ?? 0)));
  return (
    <svg
      width={done.length * bar}
      height={height}
      aria-label="Throughput over time"
      role="img"
      className="block"
    >
      {done.map((d, i) => {
        const f = failed[i] ?? 0;
        const doneH = (d / highest) * height;
        const failedH = (f / highest) * height;
        return (
          <g key={i}>
            {d > 0 && (
              <rect
                x={i * bar}
                y={height - doneH}
                width={bar - 1}
                height={doneH}
                className="fill-primary/60"
              />
            )}
            {f > 0 && (
              <rect
                x={i * bar}
                y={height - doneH - failedH}
                width={bar - 1}
                height={Math.max(1, failedH)}
                className="fill-destructive"
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
