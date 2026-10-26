import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleXIcon,
  EyeIcon,
  EyeOffIcon,
  FilterIcon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { commands, type ServiceTopology, type Transformer } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildClusterGraph,
  filterClusterGraph,
  knownTransformers,
  scopeClusterGraph,
  withoutDisabled,
  type ClusterGraph,
  type PathScope,
} from "@/lib/clusterGraph";
import { formatDateTime, nameFromArn, shortTaskId } from "@/lib/ecs";
import { isTyping } from "@/lib/keys";
import { useEcs } from "@/stores/ecs";
import { usePrefs } from "@/stores/prefs";
import {
  recallRouteMap,
  rememberRouteMap,
  type CanvasMemory,
  type RouteScan as Scan,
  type TopologyScan as Topology,
} from "@/stores/routeMaps";
import type { RoutesTab } from "@/stores/tabs";
import { ClusterMapCanvas, DOWNSTREAM_COLOR, UPSTREAM_COLOR } from "./ClusterMapCanvas";
import { ConfigList } from "./RouteConfig";

/**
 * A cluster's route map, in a tab of its own: every route service (from the cluster's topic scan,
 * kept for the session) and every transformer (found in its startup lines or entered by hand),
 * linked by topic, each with the external systems at its other end, on a canvas to zoom and pan.
 * The search keeps what lies on a path through the matching services, topics, systems or route
 * settings; a click on a node colours what feeds into it and what it feeds, and shows its routes.
 * Right-click narrows the map to one node's path or one side of it. Showing another tab and coming
 * back brings it back as it was (see `stores/routeMaps`).
 */
export function RouteMap({ tab }: { tab: RoutesTab }) {
  const { clusterArn } = tab;
  const ctx = useEcs((s) => s.ctx);
  const loaded = useEcs((s) => s.services[clusterArn]);
  const loadServices = useEcs((s) => s.loadServices);
  const transformers = usePrefs((s) => s.prefs.transformers);
  // What the tab looked like when it was last shown (read once, when it mounts).
  const [saved] = useState(() => recallRouteMap(tab.key));
  const [scan, setScan] = useState<Scan>(saved?.scan ?? { kind: "loading" });
  const [topology, setTopology] = useState<Topology>(saved?.topology ?? { kind: "loading" });
  const [query, setQuery] = useState(saved?.query ?? "");
  const [focus, setFocus] = useState<string | null>(saved?.focus ?? null);
  const [scope, setScope] = useState<{ id: string; scope: PathScope } | null>(saved?.scope ?? null);
  const [hideDisabled, setHideDisabled] = useState(saved?.hideDisabled ?? false);
  // Stepping through the search's matches (Enter / Shift+Enter): the one last jumped to.
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(null);
  const searchBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rememberRouteMap(tab.key, { scan, topology, query, focus, scope, hideDisabled });
  }, [tab.key, scan, topology, query, focus, scope, hideDisabled]);
  const saveCanvas = useCallback(
    (canvas: CanvasMemory) => rememberRouteMap(tab.key, { canvas }),
    [tab.key],
  );
  const [editing, setEditing] = useState<string | null>(null);
  const services = useMemo(
    () => (loaded && "data" in loaded ? (loaded.data ?? []) : []).map((s) => s.name),
    [loaded],
  );

  useEffect(() => {
    if (!loaded) void loadServices(clusterArn);
  }, [clusterArn, loaded, loadServices]);

  /** The cluster's routes: from this session's scan, or a new one (opening the map is reason
   * enough to scan when there was none yet). */
  const load = useCallback(
    async (fresh: boolean): Promise<Scan> => {
      if (!ctx) return { kind: "loading" };
      let result = await commands.clusterRoutes(ctx, clusterArn, fresh ? "fresh" : "cached");
      if (result.status === "ok" && result.data === null) {
        result = await commands.clusterRoutes(ctx, clusterArn, "fresh");
      }
      return result.status === "ok"
        ? { kind: "done", links: result.data ?? [] }
        : { kind: "error", error: result.error };
    },
    [ctx, clusterArn],
  );
  /** The transformers' startup lines, the same way: this session's scan or a new one. */
  const loadTopology = useCallback(
    async (fresh: boolean): Promise<Topology> => {
      if (!ctx) return { kind: "loading" };
      let result = await commands.startupTopology(ctx, clusterArn, fresh ? "fresh" : "cached");
      if (result.status === "ok" && result.data === null) {
        result = await commands.startupTopology(ctx, clusterArn, "fresh");
      }
      return result.status === "ok"
        ? { kind: "done", found: result.data ?? [] }
        : { kind: "error", error: result.error };
    },
    [ctx, clusterArn],
  );
  /**
   * Routes first (the map shows them right away), then the transformers' startup lines. The
   * results are only shown while `isCurrent()` holds (the tab may have closed meanwhile).
   */
  const scanAll = useCallback(
    (fresh: boolean, isCurrent: () => boolean) =>
      load(fresh).then(async (routes) => {
        if (!isCurrent()) return;
        setScan(routes);
        if (routes.kind !== "done") return;
        const found = await loadTopology(fresh);
        if (isCurrent()) setTopology(found);
      }),
    [load, loadTopology],
  );
  // Scanned already when the tab was shown before: nothing to load.
  const scanned = saved?.scan.kind === "done" && saved.topology.kind === "done";
  useEffect(() => {
    if (scanned) return;
    let current = true;
    void scanAll(false, () => current);
    return () => {
      current = false;
    };
  }, [scanAll, scanned]);

  const found = useMemo(() => (topology.kind === "done" ? topology.found : []), [topology]);
  const whole = useMemo(
    () =>
      buildClusterGraph(
        scan.kind === "done" ? scan.links : [],
        knownTransformers(found, transformers),
        services,
      ),
    [scan, found, transformers, services],
  );
  const graph = useMemo(() => {
    const found = filterClusterGraph(hideDisabled ? withoutDisabled(whole) : whole, query);
    return scope && found.nodes.some((n) => n.id === scope.id)
      ? scopeClusterGraph(found, scope.id, scope.scope)
      : found;
  }, [whole, query, scope, hideDisabled]);
  const topics = useMemo(
    () => whole.nodes.filter((n) => n.kind === "topic").map((n) => n.label),
    [whole],
  );
  const routeServices = whole.nodes.filter((n) => n.kind === "service" && !n.transformer).length;
  const focused = graph.nodes.find((n) => n.id === focus) ?? null;
  // In the order the graph lists them (left to right, roughly).
  const matchIds = useMemo(
    () => graph.nodes.filter((n) => graph.matches?.has(n.id)).map((n) => n.id),
    [graph],
  );
  const matchIndex = jump ? matchIds.indexOf(jump.id) : -1;
  const step = (direction: 1 | -1) => {
    if (matchIds.length === 0) return;
    const next = (matchIndex + direction + matchIds.length) % matchIds.length;
    setJump({ id: matchIds[next] ?? "", nonce: Date.now() });
  };
  const scopedTo = scope && whole.nodes.find((n) => n.id === scope.id);
  const openService = useEcs((s) => s.openService);
  const actions = useMemo(
    () => ({
      select: (id: string) => setFocus((current) => (id === "" || id === current ? null : id)),
      scope: (id: string, next: PathScope) => {
        setScope({ id, scope: next });
        setFocus(id);
      },
      openService: (name: string) => void openService({ clusterArn, serviceName: name }),
      editTopics: (name: string) => setEditing(name),
    }),
    [clusterArn, openService],
  );

  // Esc clears the selection first, then the narrowing to one path; "/" goes to the search.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "/" && !isTyping(event.target)) {
        event.preventDefault();
        searchBox.current?.focus();
        return;
      }
      if (event.key !== "Escape" || isTyping(event.target)) return;
      if (focus) setFocus(null);
      else if (scope) setScope(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus, scope]);

  return (
    <main
      aria-label={`Route map ${nameFromArn(clusterArn)}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2">
        <NetworkIcon className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="text-base font-semibold">Routes of {nameFromArn(clusterArn)}</h1>
        {scan.kind === "done" && (
          <span className="text-sm text-muted-foreground">
            {routeServices} route {routeServices === 1 ? "service" : "services"} · {topics.length}{" "}
            {topics.length === 1 ? "topic" : "topics"}
          </span>
        )}
        {scan.kind === "done" && topology.kind === "loading" && (
          <span className="animate-pulse text-xs text-muted-foreground">
            Reading the transformers' startup logs…
          </span>
        )}
        {topology.kind === "error" && (
          <span className="text-xs text-destructive" title={topology.error.message}>
            Startup logs couldn't be read
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {focus && (
            <Button variant="secondary" size="xs" tooltip="Esc" onClick={() => setFocus(null)}>
              <CircleXIcon /> Clear selection
            </Button>
          )}
          <Input
            ref={searchBox}
            type="search"
            aria-label="Find in the route map"
            placeholder="Find a service, topic, system, host, path… (/)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setJump(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
            className="h-7 w-64 text-xs"
          />
          {query.trim() !== "" && (
            <span className="flex items-center text-xs text-muted-foreground tabular-nums">
              <span aria-label="Matches" className="px-1">
                {matchIds.length === 0
                  ? "0"
                  : `${matchIndex >= 0 ? matchIndex + 1 : "–"} / ${matchIds.length}`}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Previous match"
                tooltip="Shift+Enter"
                disabled={matchIds.length === 0}
                onClick={() => step(-1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Next match"
                tooltip="Enter"
                disabled={matchIds.length === 0}
                onClick={() => step(1)}
              >
                <ChevronDownIcon />
              </Button>
            </span>
          )}
          {/* Says what a click does (no pressed state: the label changes instead). */}
          <Button
            variant={hideDisabled ? "secondary" : "outline"}
            size="xs"
            tooltip={
              hideDisabled
                ? "Show the switched-off routes again"
                : "Hide switched-off routes and the systems only they use"
            }
            onClick={() => setHideDisabled(!hideDisabled)}
          >
            {hideDisabled ? <EyeIcon /> : <EyeOffIcon />}
            {hideDisabled ? "Show disabled" : "Hide disabled"}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => setEditing("")}
            tooltip="Enter the topics a service reads and writes from its code"
          >
            <PlusIcon /> Transformer
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={scan.kind === "loading"}
            tooltip="Look through the cluster's services again (kept for the session)"
            onClick={() => {
              setScan({ kind: "loading" });
              setTopology({ kind: "loading" });
              void scanAll(true, () => true);
            }}
          >
            <RefreshCwIcon className={scan.kind === "loading" ? "animate-spin" : undefined} />
            Scan again
          </Button>
        </div>
      </header>
      {(scopedTo || focus) && (
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-1 text-xs">
          {scopedTo && scope && (
            <span className="flex items-center gap-1.5">
              <FilterIcon className="size-3.5 text-muted-foreground" />
              {scope.scope === "path"
                ? "Only the path through"
                : scope.scope === "upstream"
                  ? "Only what feeds into"
                  : "Only what is fed by"}{" "}
              <span className="font-medium">{scopedTo.label}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Show the whole map"
                onClick={() => setScope(null)}
              >
                <XIcon />
              </Button>
            </span>
          )}
          {focus && (
            <span className="flex items-center gap-3 text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="h-0.5 w-4 rounded" style={{ background: UPSTREAM_COLOR }} />
                feeds into the selection
              </span>
              <span className="flex items-center gap-1">
                <span className="h-0.5 w-4 rounded" style={{ background: DOWNSTREAM_COLOR }} />
                fed by it
              </span>
            </span>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1 text-sm">
          {scan.kind === "loading" && (
            <div aria-label="Reading the routes of the cluster's services" className="h-full">
              <div className="grid h-full grid-cols-5 gap-6 p-6">
                {Array.from({ length: 5 }, (_, column) => (
                  <div key={column} className="flex flex-col justify-center gap-3">
                    {Array.from({ length: 4 + (column % 3) }, (_, i) => (
                      <Skeleton key={i} className="h-10" />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
          {scan.kind === "error" && <p className="p-4 text-destructive">{scan.error.message}</p>}
          {scan.kind === "done" && whole.nodes.length === 0 && (
            <p className="p-4 text-muted-foreground">
              No service of this cluster has routes. Transformers entered by hand show up here too.
            </p>
          )}
          {scan.kind === "done" && whole.nodes.length > 0 && graph.nodes.length === 0 && (
            <p className="p-4 text-muted-foreground">Nothing matches “{query}”.</p>
          )}
          {graph.nodes.length > 0 && (
            <ClusterMapCanvas
              graph={graph}
              selected={focus}
              actions={actions}
              saved={saved?.canvas ?? null}
              onSave={saveCanvas}
              jump={jump}
            />
          )}
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-col items-start gap-2">
            {editing !== null && (
              <div className="pointer-events-auto">
                <TransformerEditor
                  initial={editing}
                  candidates={services}
                  found={found}
                  topics={topics}
                  onClose={() => setEditing(null)}
                />
              </div>
            )}
            {scan.kind === "done" && whole.leftOut.length > 0 && editing === null && (
              <div className="pointer-events-auto rounded-md border border-border bg-card/95 px-3 py-1.5">
                <LeftOut names={whole.leftOut} onPick={setEditing} />
              </div>
            )}
          </div>
        </div>
        {/* Beside the map, not over it: the map gets narrower, nothing is hidden. */}
        {focused && (
          <aside className="w-96 shrink-0 overflow-y-auto border-l border-border bg-card/40">
            <NodeDetails
              graph={whole}
              found={found}
              id={focused.id}
              clusterArn={clusterArn}
              onEdit={setEditing}
              onClose={() => setFocus(null)}
            />
          </aside>
        )}
      </div>
    </main>
  );
}

/** The services drawn neither as route services nor as transformers. */
function LeftOut({ names, onPick }: { names: string[]; onPick: (name: string) => void }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-default">
        {names.length}{" "}
        {names.length === 1
          ? "service has no routes and isn't drawn"
          : "services have no routes and aren't drawn"}
      </summary>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {names.map((name) => (
          <li key={name}>
            <Button
              variant="ghost"
              size="xs"
              tooltip={`Enter the topics ${name} reads and writes`}
              onClick={() => onPick(name)}
            >
              {name}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** What the clicked node is: a service to open (or edit, for a transformer), a topic's sides. */
function NodeDetails({
  graph,
  found,
  id,
  clusterArn,
  onEdit,
  onClose,
}: {
  graph: ClusterGraph;
  found: ServiceTopology[];
  id: string;
  clusterArn: string;
  onEdit: (service: string) => void;
  onClose: () => void;
}) {
  const node = graph.nodes.find((n) => n.id === id);
  const openService = useEcs((s) => s.openService);
  if (!node) return null;
  const label = (ids: string[]) =>
    ids.map((i) => graph.nodes.find((n) => n.id === i)?.label ?? i).join(", ") || "—";
  const writers = graph.edges.filter((e) => e.to === id).map((e) => e.from);
  const readers = graph.edges.filter((e) => e.from === id).map((e) => e.to);
  const startup = node.origin === "logs" ? found.find((t) => t.service === node.label) : undefined;

  return (
    <section aria-label="Node details" className="flex flex-wrap items-center gap-2 p-3 text-xs">
      <span className="font-medium">{node.label}</span>
      {node.kind === "topic" && (
        <span className="text-muted-foreground">
          written by {label(writers)} · read by {label(readers)}
        </span>
      )}
      {node.kind === "system" && <span className="text-muted-foreground">{node.detail}</span>}
      {node.kind === "service" && (
        <>
          <span className="text-muted-foreground">{node.detail}</span>
          {startup && <StartupSource topology={startup} />}
          {node.origin === "manual" && (
            <span className="text-muted-foreground">· topics entered by hand</span>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => void openService({ clusterArn, serviceName: node.label })}
          >
            <SquareArrowOutUpRightIcon /> Open {node.label}
          </Button>
          {node.transformer && (
            <Button
              variant="outline"
              size="xs"
              tooltip={
                node.origin === "logs"
                  ? "Enter the topics by hand instead of reading them from the startup logs"
                  : undefined
              }
              onClick={() => onEdit(node.label)}
            >
              <PencilIcon /> {node.origin === "logs" ? "Override topics" : "Edit topics"}
            </Button>
          )}
        </>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close node details"
        className="ml-auto"
        onClick={onClose}
      >
        <XIcon />
      </Button>
      {node.config.length > 0 && (
        <div className="basis-full border-t border-border pt-2">
          <ConfigList config={node.config} node={node} />
        </div>
      )}
    </section>
  );
}

/** Where a transformer's topics were read: which task's startup, and the consumer groups. */
function StartupSource({ topology }: { topology: ServiceTopology }) {
  const groups = topology.reads
    .filter((r) => r.group)
    .map((r) => `${r.topic}: ${r.group}${r.concurrency ? ` ×${r.concurrency}` : ""}`);
  return (
    <span className="text-muted-foreground">
      · from the startup logs of task {shortTaskId(topology.taskId)} ({topology.taskDefinition},
      started {formatDateTime(topology.startedAt)})
      {groups.length > 0 && <> · consumer groups {groups.join(", ")}</>}
    </span>
  );
}

const splitTopics = (text: string) =>
  text
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

/**
 * Enters the topics a service reads and writes from its code. Saved by service name, so the same
 * service is drawn the same way in every environment's cluster.
 */
function TransformerEditor({
  initial,
  candidates,
  found,
  topics,
  onClose,
}: {
  initial: string;
  candidates: string[];
  /** Topics found in startup lines: the starting point when nothing was entered yet. */
  found: ServiceTopology[];
  topics: string[];
  onClose: () => void;
}) {
  const saved = usePrefs((s) => s.prefs.transformers);
  const setTransformer = usePrefs((s) => s.setTransformer);
  const [service, setService] = useState(initial);
  const existing = saved[service];
  /** What was entered for `name`, or else what its startup lines say. */
  const startingPoint = (name: string): Transformer | undefined => {
    const fromLogs = found.find((t) => t.service === name);
    return (
      saved[name] ??
      (fromLogs && { reads: fromLogs.reads.map((r) => r.topic), writes: fromLogs.writes })
    );
  };
  const [reads, setReads] = useState(startingPoint(initial)?.reads.join(", ") ?? "");
  const [writes, setWrites] = useState(startingPoint(initial)?.writes.join(", ") ?? "");

  /** Picking another service shows what was saved for it (or found in its startup lines). */
  const pick = (name: string) => {
    setService(name);
    setReads(startingPoint(name)?.reads.join(", ") ?? "");
    setWrites(startingPoint(name)?.writes.join(", ") ?? "");
  };
  const save = async () => {
    await setTransformer(service, { reads: splitTopics(reads), writes: splitTopics(writes) });
    onClose();
  };

  return (
    <form
      aria-label="Transformer"
      className="grid max-w-2xl grid-cols-[max-content_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="col-span-2 text-muted-foreground">
        A transformer reads and writes topics from its code, so its routes aren't in its task
        definition. Contrail reads them from its startup logs when it can; topics entered here
        (comma-separated) take their place for the service of this name in every cluster.
      </p>
      <label htmlFor="transformer-service">Service</label>
      <select
        id="transformer-service"
        value={service}
        onChange={(e) => pick(e.target.value)}
        className="h-7 rounded-md border border-input bg-background px-2"
      >
        <option value="" disabled>
          Choose a service…
        </option>
        {candidates.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <label htmlFor="transformer-reads">Reads</label>
      <Input
        id="transformer-reads"
        list="transformer-topics"
        value={reads}
        onChange={(e) => setReads(e.target.value)}
        placeholder="topic.a, topic.b"
        className="h-7 font-mono text-xs"
      />
      <label htmlFor="transformer-writes">Writes</label>
      <Input
        id="transformer-writes"
        list="transformer-topics"
        value={writes}
        onChange={(e) => setWrites(e.target.value)}
        placeholder="topic.c"
        className="h-7 font-mono text-xs"
      />
      <datalist id="transformer-topics">
        {topics.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="col-span-2 flex gap-1.5">
        <Button type="submit" size="xs" disabled={!service}>
          Save
        </Button>
        {existing && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => {
              void setTransformer(service, { reads: [], writes: [] });
              onClose();
            }}
          >
            Remove
          </Button>
        )}
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
