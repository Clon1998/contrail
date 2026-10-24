import type { Endpoint, TopicLink, Transformer } from "@/bindings";
import { layerColumns, pathThrough, type Graph, type GraphEdge, type GraphNode } from "./routes";

export interface ClusterNode extends GraphNode {
  /** A service whose topics were entered by hand (a transformer). */
  transformer: boolean;
}

export interface ClusterGraph extends Graph {
  nodes: ClusterNode[];
  edges: GraphEdge[];
  /** The cluster's services that are neither route services nor known transformers. */
  leftOut: string[];
}

export const clusterServiceId = (name: string) => `service:${name}`;

/**
 * A whole cluster's routes as one graph: input services write topics, output services read them,
 * transformers (entered by hand) read one topic and write the next, each service with the external
 * systems at its other end. A system several services use is one node, so the graph shows who
 * shares it. `services` are the cluster's services: transformers of other clusters are left out,
 * and the services that are neither route services nor transformers are counted in `leftOut`.
 */
export function buildClusterGraph(
  links: TopicLink[],
  transformers: Record<string, Transformer>,
  services: string[],
): ClusterGraph {
  const nodes = new Map<string, Omit<ClusterNode, "column">>();
  const edges = new Map<string, GraphEdge>();

  const node = (
    id: string,
    template: Omit<ClusterNode, "id" | "column" | "self" | "disabled">,
    disabled: boolean,
  ) => {
    const existing = nodes.get(id);
    // On as soon as one route through it is on.
    if (existing) existing.disabled &&= disabled;
    else nodes.set(id, { ...template, id, self: false, disabled });
    return id;
  };
  const edge = (from: string, to: string, disabled: boolean) => {
    const id = `${from}->${to}`;
    const existing = edges.get(id);
    if (existing) existing.disabled &&= disabled;
    else edges.set(id, { id, from, to, disabled });
  };
  const topic = (name: string, disabled: boolean) =>
    node(
      `topic:${name}`,
      { kind: "topic", label: name, detail: null, transformer: false },
      disabled,
    );
  const system = (side: "source" | "target", e: Endpoint, disabled: boolean) => {
    const label = e.system ?? e.kind ?? "?";
    return node(
      `system:${side}:${e.kind ?? ""}|${label}`,
      { kind: "system", label, detail: e.system ? e.kind : null, transformer: false },
      disabled,
    );
  };

  for (const link of links) {
    const off = !link.enabled;
    const t = topic(link.topic, off);
    const service = node(
      clusterServiceId(link.service),
      {
        kind: "service",
        label: link.service,
        detail: link.direction === "in" ? "input" : "output",
        transformer: false,
      },
      off,
    );
    for (const e of link.endpoints) {
      const disabled = off || !e.enabled;
      if (link.direction === "in") edge(system("source", e, disabled), service, disabled);
      else edge(service, system("target", e, disabled), disabled);
    }
    if (link.direction === "in") edge(service, t, off);
    else edge(t, service, off);
  }

  const inCluster = new Set(services);
  for (const [name, transformer] of Object.entries(transformers)) {
    if (!inCluster.has(name)) continue;
    const service = node(
      clusterServiceId(name),
      { kind: "service", label: name, detail: "transformer", transformer: true },
      false,
    );
    // A route service entered as a transformer too keeps its routes and gets the extra topics.
    const existing = nodes.get(service);
    if (existing) {
      existing.transformer = true;
      existing.detail = "transformer";
    }
    for (const read of transformer.reads) edge(topic(read, false), service, false);
    for (const written of transformer.writes) edge(service, topic(written, false), false);
  }

  const columns = layerColumns([...nodes.keys()], [...edges.values()]);
  const drawn = new Set(
    [...nodes.values()].filter((n) => n.kind === "service").map((n) => n.label),
  );
  return {
    nodes: [...nodes.values()].map((n) => ({ ...n, column: columns.get(n.id) ?? 0 })),
    edges: [...edges.values()],
    leftOut: services.filter((s) => !drawn.has(s)).sort(),
  };
}

/**
 * The part of the graph on a path through a node whose name contains `query` (case-insensitive):
 * the matching services, topics or systems with everything upstream and downstream of them.
 * An empty query keeps the whole graph.
 */
export function filterClusterGraph(graph: ClusterGraph, query: string): ClusterGraph {
  const needle = query.trim().toLowerCase();
  if (!needle) return graph;
  const keep = new Set<string>();
  for (const match of graph.nodes.filter((n) => n.label.toLowerCase().includes(needle))) {
    for (const id of pathThrough(graph, match.id).nodes) keep.add(id);
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
  };
}
