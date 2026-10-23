import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, RouteIcon, TriangleAlertIcon } from "lucide-react";
import { cn } from "cn";
import { commands, type ApiError, type ServiceRef, type Trace } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatLogTime, formatShortTime } from "@/lib/logs";
import { useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { tabKey, useTabs } from "@/stores/tabs";
import { StateBadge } from "./StateBadge";

/** How far around the event's time the services are searched. */
const SPANS = [
  { minutes: 15, label: "±15 min" },
  { minutes: 60, label: "±1 h" },
  { minutes: 360, label: "±6 h" },
];

const OUTCOME = {
  completed: { label: "Completed", tone: "border-success/40 text-success" },
  failed: { label: "Failed", tone: "border-destructive/50 text-destructive" },
  open: { label: "Open", tone: "border-warning/50 text-warning" },
} as const;

/**
 * Follows one ID (a document's correlation ID, an API's trace ID) across the services of the
 * cluster: which services logged it, in what order, and how the document ended.
 *
 * `term` is the search that lists the ID in one service (`correlation:<id>` or the ID as text).
 */
export function TraceDialog({ id, term, at }: { id: string; term: string; at: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="xs"
          tooltip="Find this ID in other services of the cluster and show the way it took"
        >
          <RouteIcon /> Trace across services
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">Trace {id}</DialogTitle>
          <DialogDescription>
            Searches the chosen services’ logs (CloudWatch FilterLogEvents) for this ID.
          </DialogDescription>
        </DialogHeader>
        {open && <TraceBody id={id} term={term} at={at} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function TraceBody({
  id,
  term,
  at,
  close,
}: {
  id: string;
  term: string;
  at: string;
  close: () => void;
}) {
  const ctx = useEcs((s) => s.ctx);
  const current = useLogs((s) => s.service);
  const clusterArn = current?.clusterArn ?? "";
  const loadServices = useEcs((s) => s.loadServices);
  const loaded = useEcs((s) => s.services[clusterArn]);
  const names = useMemo(
    () => (loaded && "data" in loaded ? (loaded.data ?? []) : []).map((s) => s.name),
    [loaded],
  );
  const [chosen, setChosen] = useState<string[]>(current ? [current.serviceName] : []);
  const [filter, setFilter] = useState("");
  const [span, setSpan] = useState(60);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done"; trace: Trace }
    | { kind: "error"; error: ApiError }
  >({ kind: "idle" });

  useEffect(() => {
    if (clusterArn && !loaded) void loadServices(clusterArn);
  }, [clusterArn, loaded, loadServices]);

  const shown = names.filter((n) => n.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (name: string, on: boolean) =>
    setChosen((list) => (on ? [...list, name] : list.filter((n) => n !== name)));

  const search = async () => {
    if (!ctx) return;
    setState({ kind: "loading" });
    const time = Date.parse(at);
    const result = await commands.traceId(
      ctx,
      chosen.map((serviceName) => ({ clusterArn, serviceName })),
      id,
      {
        kind: "range",
        from: new Date(time - span * 60_000).toISOString(),
        to: new Date(time + span * 60_000).toISOString(),
      },
    );
    setState(
      result.status === "ok"
        ? { kind: "done", trace: result.data }
        : { kind: "error", error: result.error },
    );
  };

  /** Opens a service's logs, searched for the ID (its tab keeps the search). */
  const openService = (serviceName: string) => {
    const service: ServiceRef = { clusterArn, serviceName };
    useTabs.getState().activate(service);
    const tab = useTabs.getState().tabs.find((t) => t.key === tabKey(service));
    if (tab) {
      tab.logs.getState().setTab("logs");
      void tab.logs.getState().setSearch({ query: term, mode: "filter" });
    }
    void useEcs.getState().openService(service);
    close();
  };

  return (
    <div className="grid min-h-0 gap-4 md:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col gap-2">
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
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setChosen(current ? [current.serviceName] : [])}
          >
            Only this one
          </Button>
        </div>
        <ul
          aria-label="Services to search"
          className="max-h-72 min-h-0 overflow-y-auto rounded-md border border-border p-1"
        >
          {shown.map((name) => (
            <li key={name}>
              <label className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                <Checkbox
                  aria-label={name}
                  checked={chosen.includes(name)}
                  onCheckedChange={(on) => toggle(name, on === true)}
                />
                <span className="truncate">{name}</span>
              </label>
            </li>
          ))}
        </ul>
        <div role="radiogroup" aria-label="Time around the event" className="flex gap-1">
          {SPANS.map((s) => (
            <Button
              key={s.minutes}
              role="radio"
              aria-checked={span === s.minutes}
              variant={span === s.minutes ? "secondary" : "ghost"}
              size="xs"
              onClick={() => setSpan(s.minutes)}
            >
              {s.label}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          disabled={chosen.length === 0 || state.kind === "loading"}
          onClick={() => void search()}
        >
          {state.kind === "loading" && <Loader2Icon className="animate-spin" />}
          Search {chosen.length} {chosen.length === 1 ? "service" : "services"}
        </Button>
        {chosen.length > 20 && (
          <p className="text-xs text-muted-foreground">
            Many services: CloudWatch allows only a few searches per second, so this can take a
            while.
          </p>
        )}
      </div>

      <div className="min-h-0 overflow-y-auto">
        {state.kind === "idle" && (
          <p className="text-sm text-muted-foreground">
            Choose the services the document may have passed through, then search.
          </p>
        )}
        {state.kind === "error" && (
          <p className="text-sm text-destructive">
            {state.error.message}
            {state.error.hint && (
              <span className="block text-muted-foreground">{state.error.hint}</span>
            )}
          </p>
        )}
        {state.kind === "done" && <TraceResult trace={state.trace} open={openService} />}
      </div>
    </div>
  );
}

function TraceResult({ trace, open }: { trace: Trace; open: (service: string) => void }) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const outcome = OUTCOME[trace.outcome];
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          role="status"
          aria-label="Trace outcome"
          variant="outline"
          className={cn("text-xs", outcome.tone)}
        >
          {outcome.label}
        </Badge>
        <span className="text-muted-foreground">
          {trace.hits.length} {trace.hits.length === 1 ? "event" : "events"} in{" "}
          {trace.services.length} {trace.services.length === 1 ? "service" : "services"}
          {trace.truncated && " (some services had more; the newest are missing)"}
        </span>
      </div>

      {trace.services.length > 0 && (
        <ol aria-label="Services on the way" className="flex flex-wrap items-center gap-1.5">
          {trace.services.map((service, i) => (
            <li key={service.service} className="flex items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground">→</span>}
              <button
                type="button"
                onClick={() => open(service.service)}
                className="flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs hover:bg-accent"
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
        <ol aria-label="Trace events" className="divide-y divide-border rounded-md border">
          {trace.hits.map((hit) => (
            <li key={`${hit.service}-${hit.event.seq}-${hit.event.cwTimestamp}`}>
              <button
                type="button"
                onClick={() => open(hit.service)}
                className="grid w-full grid-cols-[6.5rem_9rem_auto_minmax(0,1fr)] items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent"
              >
                <span
                  className="font-mono text-muted-foreground"
                  title={formatShortTime(hit.event.timestamp, timeZone)}
                >
                  {formatLogTime(hit.event.timestamp, timeZone)}
                </span>
                <span className="truncate font-medium">{hit.service}</span>
                <span>{hit.event.status && <StateBadge state={hit.event.status.state} />}</span>
                <span className="truncate font-mono">
                  {hit.event.line.message.split("\n", 1)[0]}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
