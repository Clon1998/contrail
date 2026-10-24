import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import {
  ChevronRightIcon,
  ListFilterIcon,
  Loader2Icon,
  RefreshCwIcon,
  RouteIcon,
  SquareArrowOutUpRightIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "cn";
import type { ServiceRef, Trace, TraceHit } from "@/bindings";
import { CopyButton } from "@/components/CopyButton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { nameFromArn } from "@/lib/ecs";
import { formatLogTime, formatShortTime, prettyJson } from "@/lib/logs";
import { useEcs } from "@/stores/ecs";
import { usePrefs } from "@/stores/prefs";
import { tabKey, useTabs, type TraceTab } from "@/stores/tabs";
import { hitKey, TRACE_SPANS, type TraceState } from "@/stores/trace";
import { Ansi } from "./Ansi";
import { LEVEL_TONE } from "./levels";
import { EventBody, StatusSummary } from "./LogDetails";
import { StateBadge } from "./StateBadge";
import { TraceGraph } from "./TraceGraph";

const OUTCOME = {
  completed: { label: "Completed", tone: "border-success/40 text-success" },
  failed: { label: "Failed", tone: "border-destructive/50 text-destructive" },
  open: { label: "Open", tone: "border-warning/50 text-warning" },
} as const;

const SPAN_LABEL: Record<number, string> = { 15: "±15 min", 60: "±1 h", 360: "±6 h" };

/** Chevron, time, service, level, message. */
const ROW_GRID = "1rem 7.5rem minmax(6rem, 11rem) 3.5rem minmax(0, 1fr)";

/**
 * A trace across services, in its own tab: which services logged one ID, in what order, how the
 * document ended, and every event with that ID in one timeline (expandable like log lines).
 *
 * The website's tracing guide (site/src/content/docs/guides/tracing.mdx) walks through this tab
 * with screenshots: update it, and run `pnpm screenshots`, after visible changes.
 */
export function TraceView({ tab }: { tab: TraceTab }) {
  const store = tab.trace;
  // `useStore` subscribes to a store passed in (here: this tab's), like `useLogs` for a service.
  const use = <T,>(selector: (state: TraceState) => T) => useStore(store, selector);
  const request = use((s) => s.request);
  const result = use((s) => s.result);
  const pickerOpen = use((s) => s.pickerOpen);
  const chosen = use((s) => s.chosen);
  const ctx = useEcs((s) => s.ctx);
  const loading = result.kind === "loading";

  return (
    <main
      aria-label={`Trace ${request.id}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2">
        <RouteIcon className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="truncate font-mono text-base font-semibold" title={request.id}>
          {request.id}
        </h1>
        <span className="truncate text-sm text-muted-foreground">
          from {request.origin} · {nameFromArn(request.clusterArn)}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant={pickerOpen ? "secondary" : "outline"}
            size="xs"
            aria-pressed={pickerOpen}
            onClick={() => store.getState().setPickerOpen(!pickerOpen)}
          >
            <ListFilterIcon /> Services ({chosen.length})
          </Button>
          {result.kind !== "idle" && (
            <Button
              variant="outline"
              size="xs"
              disabled={loading || chosen.length === 0 || !ctx}
              tooltip="Search the chosen services again"
              onClick={() => ctx && void store.getState().search(ctx)}
            >
              <RefreshCwIcon className={loading ? "animate-spin" : undefined} /> Search again
            </Button>
          )}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {pickerOpen && <ServicePicker store={store} />}
        <section aria-label="Trace result" className="min-w-0 flex-1 overflow-y-auto">
          {result.kind === "idle" && (
            <p className="p-4 text-sm text-muted-foreground">
              Choose the services the request may have passed through, then search.
            </p>
          )}
          {result.kind === "loading" && (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Searching {chosen.length}{" "}
              {chosen.length === 1 ? "service" : "services"}…
            </p>
          )}
          {result.kind === "error" && (
            <p className="m-4 text-sm text-destructive">
              {result.error.message}
              {result.error.hint && (
                <span className="block text-muted-foreground">{result.error.hint}</span>
              )}
            </p>
          )}
          {result.kind === "done" && <TraceResult store={store} trace={result.trace} />}
        </section>
      </div>
    </main>
  );
}

/** Which services to search, how far around the event, and how. */
function ServicePicker({ store }: { store: TraceTab["trace"] }) {
  const request = useStore(store, (s) => s.request);
  const chosen = useStore(store, (s) => s.chosen);
  const span = useStore(store, (s) => s.span);
  const insights = useStore(store, (s) => s.insights);
  const loading = useStore(store, (s) => s.result.kind === "loading");
  const ctx = useEcs((s) => s.ctx);
  const loadServices = useEcs((s) => s.loadServices);
  const loaded = useEcs((s) => s.services[request.clusterArn]);
  const names = useMemo(
    () => (loaded && "data" in loaded ? (loaded.data ?? []) : []).map((s) => s.name),
    [loaded],
  );
  const [filter, setFilter] = useState("");
  const { toggleService, setChosen, setSpan, setInsights, search } = store.getState();

  useEffect(() => {
    if (!loaded) void loadServices(request.clusterArn);
  }, [request.clusterArn, loaded, loadServices]);

  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <aside
      aria-label="Services to search"
      className="flex w-64 shrink-0 flex-col gap-2 overflow-y-auto border-r border-border p-3"
    >
      <Input
        type="search"
        aria-label="Filter services"
        placeholder="Filter services…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="h-7 text-xs"
      />
      <div className="flex gap-1">
        <Button variant="ghost" size="xs" onClick={() => setChosen(names)}>
          All ({names.length})
        </Button>
        <Button variant="ghost" size="xs" onClick={() => setChosen([request.origin])}>
          Only {request.origin}
        </Button>
      </div>
      <ul className="min-h-24 flex-1 overflow-y-auto rounded-md border border-border p-1">
        {shown.map((name) => (
          <li key={name}>
            <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
              <Checkbox
                aria-label={name}
                checked={chosen.includes(name)}
                onCheckedChange={(on) => toggleService(name, on === true)}
              />
              <span className="truncate">{name}</span>
            </label>
          </li>
        ))}
      </ul>
      <div role="radiogroup" aria-label="Time around the event" className="flex gap-1">
        {TRACE_SPANS.map((minutes) => (
          <Button
            key={minutes}
            role="radio"
            aria-checked={span === minutes}
            variant={span === minutes ? "secondary" : "ghost"}
            size="xs"
            onClick={() => setSpan(minutes)}
          >
            {SPAN_LABEL[minutes]}
          </Button>
        ))}
      </div>
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <Checkbox
          className="mt-0.5"
          checked={insights}
          onCheckedChange={(on) => setInsights(on === true)}
        />
        <span>
          Use Logs Insights: one query for up to 50 services (faster with many; billed per GB
          scanned, needs logs:StartQuery)
        </span>
      </label>
      <Button
        size="sm"
        disabled={chosen.length === 0 || loading || !ctx}
        onClick={() => ctx && void search(ctx)}
      >
        {loading && <Loader2Icon className="animate-spin" />}
        Search {chosen.length} {chosen.length === 1 ? "service" : "services"}
      </Button>
      {chosen.length > 20 && !insights && (
        <p className="text-xs text-muted-foreground">
          Many services: CloudWatch allows only a few searches per second, so this can take a while.
        </p>
      )}
    </aside>
  );
}

/** The outcome, the services in the order they were reached, and the events. */
function TraceResult({ store, trace }: { store: TraceTab["trace"]; trace: Trace }) {
  const only = useStore(store, (s) => s.only);
  const setOnly = useStore(store, (s) => s.setOnly);
  // Only status events say how a document ended; a plain trace ID (an API request) has no outcome.
  const outcome = trace.services.some((s) => s.lastState) ? OUTCOME[trace.outcome] : null;
  const hits = only ? trace.hits.filter((h) => h.service === only) : trace.hits;
  // With hops, the graph shows the services on the document's way; the rest are listed.
  const chips = trace.services.filter((s) => !trace.hops.some((h) => h.service === s.service));

  return (
    <div className="space-y-3 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        {outcome && (
          <Badge
            role="status"
            aria-label="Trace outcome"
            variant="outline"
            className={cn("text-xs", outcome.tone)}
          >
            {outcome.label}
          </Badge>
        )}
        <span className="text-muted-foreground">
          {trace.hits.length} {trace.hits.length === 1 ? "event" : "events"} in{" "}
          {trace.services.length} {trace.services.length === 1 ? "service" : "services"}
          {trace.truncated && " (some services had more; the newest are missing)"}
        </span>
      </div>

      {trace.hops.length > 0 && <TraceGraph store={store} trace={trace} />}
      {chips.length > 0 && (
        <ol
          aria-label={trace.hops.length > 0 ? "Also in this trace" : "Services on the way"}
          className="flex flex-wrap items-center gap-1.5"
        >
          {trace.hops.length > 0 && (
            <li className="text-xs text-muted-foreground">Also in this trace:</li>
          )}
          {chips.map((service, i) => (
            <li key={service.service} className="flex items-center gap-1.5">
              {i > 0 && trace.hops.length === 0 && <span className="text-muted-foreground">→</span>}
              <button
                type="button"
                aria-pressed={only === service.service}
                title={
                  only === service.service
                    ? "Show the events of all services"
                    : `Show only ${service.service}’s events`
                }
                onClick={() => setOnly(only === service.service ? null : service.service)}
                className={cn(
                  "flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent",
                  only === service.service && "border-primary bg-primary/10",
                )}
              >
                {service.service}
                {service.lastState && <StateBadge state={service.lastState} />}
                <span className="text-muted-foreground tabular-nums">{service.events}</span>
              </button>
            </li>
          ))}
        </ol>
      )}

      {trace.failures.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warning">
          {trace.failures.map((f) => (
            <li key={f.service} className="flex items-start gap-1.5">
              <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
              {f.service}: {f.message}
            </li>
          ))}
        </ul>
      )}

      {trace.hits.length === 0 ? (
        <p className="text-muted-foreground">No events with this ID in that time.</p>
      ) : (
        <ol
          aria-label="Trace events"
          className="divide-y divide-border overflow-hidden rounded-md border border-border font-mono text-(length:--log-font-size) leading-[1.6]"
        >
          {hits.map((hit) => (
            <TraceRow key={hitKey(hit)} store={store} hit={hit} />
          ))}
        </ol>
      )}
    </div>
  );
}

/** One event of the trace; expands into the event's content. */
function TraceRow({ store, hit }: { store: TraceTab["trace"]; hit: TraceHit }) {
  const key = hitKey(hit);
  const expanded = useStore(store, (s) => s.expanded[key] ?? false);
  const toggle = useStore(store, (s) => s.toggleExpanded);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const { event } = hit;
  const { line } = event;

  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => toggle(key)}
        style={{ gridTemplateColumns: ROW_GRID }}
        className={cn(
          "grid w-full items-baseline gap-x-2 px-3 text-left hover:bg-accent/50",
          expanded && "bg-accent/40",
          line.level === "ERROR" && "bg-destructive/5",
        )}
      >
        <ChevronRightIcon
          className={cn("size-3 self-center text-muted-foreground", expanded && "rotate-90")}
        />
        <span
          className="text-muted-foreground tabular-nums"
          title={formatShortTime(event.timestamp, timeZone)}
        >
          {formatLogTime(event.timestamp, timeZone)}
        </span>
        <span className="truncate font-sans font-medium">{hit.service}</span>
        <span
          className={cn(
            "font-semibold",
            line.level ? LEVEL_TONE[line.level] : "text-muted-foreground",
          )}
        >
          {line.level ?? "·"}
        </span>
        <span className="truncate">
          {event.status && <StateBadge state={event.status.state} className="mr-1.5 align-[1px]" />}
          <Ansi text={line.message.split("\n", 1)[0] ?? ""} />
        </span>
      </button>
      {expanded && <TraceHitDetails store={store} hit={hit} />}
    </li>
  );
}

function TraceHitDetails({ store, hit }: { store: TraceTab["trace"]; hit: TraceHit }) {
  const request = useStore(store, (s) => s.request);
  const { event } = hit;
  const rawPretty =
    event.line.kind === "ecs" || event.line.kind === "json" ? prettyJson(event.raw) : null;

  /** Opens the service's logs, searched for the ID; this trace tab stays open. */
  const openService = () => {
    const service: ServiceRef = { clusterArn: request.clusterArn, serviceName: hit.service };
    useTabs.getState().activate(service);
    const tab = useTabs.getState().tabs.find((t) => t.key === tabKey(service));
    if (tab?.kind === "service") {
      tab.logs.getState().setTab("logs");
      void tab.logs.getState().setSearch({ query: request.term, mode: "filter" });
    }
    void useEcs.getState().openService(service);
  };

  return (
    <div className="space-y-3 border-l-2 border-primary/60 bg-muted/30 py-2 pr-4 pl-4">
      <div className="flex flex-wrap gap-1.5">
        <CopyButton label="Copy message" text={event.line.message} />
        {rawPretty && <CopyButton label="Copy JSON" text={rawPretty} />}
        <Button
          variant="outline"
          size="xs"
          tooltip={`Open ${hit.service}’s logs, filtered to this ID (this tab stays open)`}
          onClick={openService}
        >
          <SquareArrowOutUpRightIcon /> Open in {hit.service}
        </Button>
      </div>
      {event.status && <StatusSummary event={event} />}
      <EventBody event={event} />
    </div>
  );
}
