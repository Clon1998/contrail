import { useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { Loader2Icon, NetworkIcon, SearchIcon } from "lucide-react";
import { commands, type ApiError, type Trace, type TopicLink } from "@/bindings";
import { GraphView } from "@/components/ecs/RouteGraphView";
import { Button } from "@/components/ui/button";
import { columnTitles } from "@/lib/routes";
import { buildTraceGraph, serviceNodeId } from "@/lib/traceGraph";
import { useEcs } from "@/stores/ecs";
import type { TraceTab } from "@/stores/tabs";

type Links =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; links: TopicLink[] }
  | { kind: "error"; error: ApiError };

/**
 * The trace on the route graph: the services the document passed and the topics between them,
 * each line in the colour of how its hop ended (done, still waiting, failed). With the cluster's
 * route scan (kept for the session), the external systems join in, and so do services on the
 * same topics that logged nothing about the document: where it may have got lost, or a service
 * that wasn't searched yet. A click on a service shows only its events.
 */
export function TraceGraph({ store, trace }: { store: TraceTab["trace"]; trace: Trace }) {
  const request = useStore(store, (s) => s.request);
  const chosen = useStore(store, (s) => s.chosen);
  const only = useStore(store, (s) => s.only);
  const ctx = useEcs((s) => s.ctx);
  const [links, setLinks] = useState<Links>({ kind: "idle" });
  const [picked, setPicked] = useState<string | null>(null);
  const topics = useMemo(() => [...new Set(trace.hops.map((h) => h.topic))], [trace.hops]);
  const graph = useMemo(
    () =>
      buildTraceGraph(trace.hops, trace.services, links.kind === "done" ? links.links : [], chosen),
    [trace, links, chosen],
  );

  // The cluster's last route scan, if there was one this session: no AWS call.
  useEffect(() => {
    if (!ctx || topics.length === 0) return;
    let current = true;
    void commands.servicesOnTopics(ctx, request.clusterArn, topics, "", "cached").then((result) => {
      if (!current || result.status === "error") return;
      const cached = result.data;
      setLinks((links) =>
        links.kind === "loading"
          ? links
          : cached
            ? { kind: "done", links: cached }
            : { kind: "idle" },
      );
    });
    return () => {
      current = false;
    };
  }, [ctx, request.clusterArn, topics]);

  const scan = async () => {
    if (!ctx) return;
    setLinks({ kind: "loading" });
    const result = await commands.servicesOnTopics(ctx, request.clusterArn, topics, "", "fresh");
    setLinks(
      result.status === "ok"
        ? { kind: "done", links: result.data ?? [] }
        : { kind: "error", error: result.error },
    );
  };

  const onFocus = (id: string) => {
    const node = graph.nodes.find((n) => n.id === id);
    if (node?.kind === "service" && !node.missing) {
      store.getState().setOnly(only === node.label ? null : node.label);
      setPicked(null);
    } else {
      setPicked(picked === id ? null : id);
    }
  };
  const focus = only ? serviceNodeId(only) : picked;
  const missing = graph.nodes.find((n) => n.id === picked && n.missing);

  return (
    <section
      aria-label="The document's way"
      className="space-y-2 rounded-md border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">The document's way</span>
        <Legend />
        <Button
          variant="outline"
          size="xs"
          className="ml-auto"
          disabled={links.kind === "loading" || !ctx}
          tooltip={
            links.kind === "done"
              ? "Look through the cluster's services again (they're kept for the session)"
              : "Add the external systems, and the services on these topics that logged nothing"
          }
          onClick={() => void scan()}
        >
          {links.kind === "loading" ? <Loader2Icon className="animate-spin" /> : <NetworkIcon />}
          Find connected services
        </Button>
      </div>
      {links.kind === "error" && <p className="text-xs text-destructive">{links.error.message}</p>}
      <GraphView
        graph={graph}
        label="Trace graph"
        columnTitle={columnTitles(graph)}
        focus={focus}
        onFocus={onFocus}
      />
      {missing ? (
        <MissingService
          name={missing.label}
          searched={chosen.includes(missing.label)}
          onSearch={() => {
            store.getState().toggleService(missing.label, true);
            if (ctx) void store.getState().search(ctx);
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          {only
            ? `Showing ${only}'s events; click it again for all.`
            : "Click a service to show only its events."}
        </p>
      )}
    </section>
  );
}

function Legend() {
  const line = (tone: string, dashed = false) => (
    <svg aria-hidden className="h-2 w-5" viewBox="0 0 20 8">
      <path
        d="M0,4 L20,4"
        strokeWidth={2}
        strokeDasharray={dashed ? "4 3" : undefined}
        className={tone}
      />
    </svg>
  );
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Legend">
      <span className="flex items-center gap-1">{line("stroke-success/70")} done</span>
      <span className="flex items-center gap-1">{line("stroke-warning")} waiting</span>
      <span className="flex items-center gap-1">{line("stroke-destructive")} failed</span>
      <span className="flex items-center gap-1">
        {line("stroke-muted-foreground/60", true)} no event
      </span>
    </span>
  );
}

/** A service on the topics that logged nothing about the ID, or wasn't searched yet. */
function MissingService({
  name,
  searched,
  onSearch,
}: {
  name: string;
  searched: boolean;
  onSearch: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
      {searched ? (
        <span>
          <span className="font-medium">{name}</span> is on the document's way but logged nothing
          about it in the searched time: it may not have arrived there.
        </span>
      ) : (
        <>
          <span>
            <span className="font-medium">{name}</span> is on the document's way but wasn't
            searched.
          </span>
          <Button variant="outline" size="xs" onClick={onSearch}>
            <SearchIcon /> Search {name} too
          </Button>
        </>
      )}
    </div>
  );
}
