import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Loader2Icon,
  NetworkIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { commands, type ApiError, type TopicLink } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { buildClusterGraph, filterClusterGraph, type ClusterGraph } from "@/lib/clusterGraph";
import { nameFromArn } from "@/lib/ecs";
import { columnTitles } from "@/lib/routes";
import { useEcs } from "@/stores/ecs";
import { usePrefs } from "@/stores/prefs";
import type { RoutesTab } from "@/stores/tabs";
import { GraphView } from "./RouteGraphView";

type Scan =
  { kind: "loading" } | { kind: "done"; links: TopicLink[] } | { kind: "error"; error: ApiError };

/**
 * A cluster's route map, in a tab of its own: every route service (from the cluster's topic scan,
 * kept for the session) and every transformer entered by hand, linked by topic, each with the
 * external systems at its other end. The search keeps what lies on a path through the matching
 * services, topics or systems; a click on a node highlights its paths and shows what it is.
 */
export function RouteMap({ tab }: { tab: RoutesTab }) {
  const { clusterArn } = tab;
  const ctx = useEcs((s) => s.ctx);
  const loaded = useEcs((s) => s.services[clusterArn]);
  const loadServices = useEcs((s) => s.loadServices);
  const transformers = usePrefs((s) => s.prefs.transformers);
  const [scan, setScan] = useState<Scan>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
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
  useEffect(() => {
    let current = true;
    void load(false).then((result) => current && setScan(result));
    return () => {
      current = false;
    };
  }, [load]);

  const whole = useMemo(
    () => buildClusterGraph(scan.kind === "done" ? scan.links : [], transformers, services),
    [scan, transformers, services],
  );
  const graph = useMemo(() => filterClusterGraph(whole, query), [whole, query]);
  const topics = useMemo(
    () => whole.nodes.filter((n) => n.kind === "topic").map((n) => n.label),
    [whole],
  );
  const routeServices = whole.nodes.filter((n) => n.kind === "service" && !n.transformer).length;
  const focused = graph.nodes.find((n) => n.id === focus) ?? null;

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
        <div className="ml-auto flex items-center gap-1.5">
          <Input
            type="search"
            aria-label="Find in the route map"
            placeholder="Find a service, topic or system…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-7 w-64 text-xs"
          />
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
              void load(true).then(setScan);
            }}
          >
            <RefreshCwIcon className={scan.kind === "loading" ? "animate-spin" : undefined} />
            Scan again
          </Button>
        </div>
      </header>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 text-sm">
        {scan.kind === "loading" && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2Icon className="size-4 animate-spin" /> Reading the routes of the cluster's
            services…
          </p>
        )}
        {scan.kind === "error" && <p className="text-destructive">{scan.error.message}</p>}
        {editing !== null && (
          <TransformerEditor
            initial={editing}
            candidates={services}
            topics={topics}
            onClose={() => setEditing(null)}
          />
        )}
        {scan.kind === "done" && whole.nodes.length === 0 && (
          <p className="text-muted-foreground">
            No service of this cluster has routes. Transformers entered by hand show up here too.
          </p>
        )}
        {scan.kind === "done" && whole.nodes.length > 0 && graph.nodes.length === 0 && (
          <p className="text-muted-foreground">Nothing matches “{query}”.</p>
        )}
        {graph.nodes.length > 0 && (
          <GraphView
            graph={graph}
            label="Cluster route map"
            columnTitle={columnTitles(graph)}
            minColumnWidth="9rem"
            focus={focus}
            onFocus={(id) => setFocus(focus === id ? null : id)}
          />
        )}
        {focused && (
          <NodeDetails
            graph={whole}
            id={focused.id}
            clusterArn={clusterArn}
            onEdit={setEditing}
            onClose={() => setFocus(null)}
          />
        )}
        {scan.kind === "done" && whole.leftOut.length > 0 && (
          <LeftOut names={whole.leftOut} onPick={setEditing} />
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
  id,
  clusterArn,
  onEdit,
  onClose,
}: {
  graph: ClusterGraph;
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

  return (
    <section
      aria-label="Node details"
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs"
    >
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
          <Button
            variant="outline"
            size="xs"
            onClick={() => void openService({ clusterArn, serviceName: node.label })}
          >
            <SquareArrowOutUpRightIcon /> Open {node.label}
          </Button>
          {node.transformer && (
            <Button variant="outline" size="xs" onClick={() => onEdit(node.label)}>
              <PencilIcon /> Edit topics
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
    </section>
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
  topics,
  onClose,
}: {
  initial: string;
  candidates: string[];
  topics: string[];
  onClose: () => void;
}) {
  const saved = usePrefs((s) => s.prefs.transformers);
  const setTransformer = usePrefs((s) => s.setTransformer);
  const [service, setService] = useState(initial);
  const existing = saved[service];
  const [reads, setReads] = useState(existing?.reads.join(", ") ?? "");
  const [writes, setWrites] = useState(existing?.writes.join(", ") ?? "");

  /** Picking another service shows what was saved for it. */
  const pick = (name: string) => {
    setService(name);
    setReads(saved[name]?.reads.join(", ") ?? "");
    setWrites(saved[name]?.writes.join(", ") ?? "");
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
        definition. Enter its topics (comma-separated); they apply to the service of this name in
        every cluster.
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
