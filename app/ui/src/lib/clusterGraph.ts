import type { Endpoint, RouteProperty, ServiceTopology, TopicLink, Transformer } from "@/bindings";
import { layerColumns, type Graph, type GraphEdge, type GraphNode } from "./routes";

/** Where a transformer's topics come from: its startup log lines, or entered by hand. */
export type TransformerOrigin = "logs" | "manual";

/** A transformer's topics and where they come from (entered by hand when not said). */
export interface KnownTransformer extends Transformer {
  origin?: TransformerOrigin;
}

/** One end of a route as configured: which service's route, on which topic, and its settings. */
export interface EndpointConfig {
  service: string;
  topic: string;
  side: "source" | "target";
  kind: string | null;
  system: string | null;
  enabled: boolean;
  /** The consumer group of an output route. */
  group: string | null;
  /** Values of secrets are empty: they never reach the UI. */
  properties: RouteProperty[];
}

export interface ClusterNode extends GraphNode {
  /** A service that reads and writes topics from its code (a transformer). */
  transformer: boolean;
  /** Where a transformer's topics come from; `null` for everything else. */
  origin: TransformerOrigin | null;
  /** The route ends at this node: a service's own, or those of every service using a system. */
  config: EndpointConfig[];
}

export interface ClusterEdge extends GraphEdge {
  /**
   * The routes the line belongs to (`service|topic|direction`). Inside a route service, a source
   * leads only to its own route's topic (and a topic only to its own route's targets); lines of
   * transformers have no routes and connect everything they touch.
   */
  routes: string[];
}

/**
 * The transformers to draw: those found in startup lines, and those entered by hand. A service
 * entered by hand is drawn as entered, even when its startup lines say otherwise.
 */
export function knownTransformers(
  found: ServiceTopology[],
  manual: Record<string, Transformer>,
): Record<string, KnownTransformer> {
  const known: Record<string, KnownTransformer> = {};
  for (const t of found) {
    known[t.service] = { reads: t.reads.map((r) => r.topic), writes: t.writes, origin: "logs" };
  }
  for (const [name, t] of Object.entries(manual)) known[name] = { ...t, origin: "manual" };
  return known;
}

export interface ClusterGraph extends Graph {
  nodes: ClusterNode[];
  edges: ClusterEdge[];
  /** The cluster's services that are neither route services nor known transformers. */
  leftOut: string[];
  /** After a search: what matched in each matching node (`name`, or a setting like `host: …`). */
  matches?: Map<string, string>;
}

export const clusterServiceId = (name: string) => `service:${name}`;

/**
 * A whole cluster's routes as one graph: input services write topics, output services read them,
 * transformers (from their startup lines or entered by hand) read one topic and write the next,
 * each service with the external systems at its other end. A system several services use is one
 * node, so the graph shows who shares it. `services` are the cluster's services: transformers of
 * other clusters are left out, and the services that are neither route services nor transformers
 * are counted in `leftOut`.
 */
export function buildClusterGraph(
  links: TopicLink[],
  transformers: Record<string, KnownTransformer>,
  services: string[],
): ClusterGraph {
  const nodes = new Map<string, Omit<ClusterNode, "column">>();
  const edges = new Map<string, ClusterEdge>();

  const node = (
    id: string,
    template: Omit<ClusterNode, "id" | "column" | "self" | "disabled" | "origin" | "config">,
    disabled: boolean,
  ) => {
    const existing = nodes.get(id);
    // On as soon as one route through it is on.
    if (existing) existing.disabled &&= disabled;
    else nodes.set(id, { ...template, id, self: false, disabled, origin: null, config: [] });
    return id;
  };
  const edge = (from: string, to: string, disabled: boolean, route?: string) => {
    const id = `${from}->${to}`;
    const existing = edges.get(id);
    if (existing) {
      existing.disabled &&= disabled;
      if (route && !existing.routes.includes(route)) existing.routes.push(route);
    } else edges.set(id, { id, from, to, disabled, routes: route ? [route] : [] });
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
    const route = `${link.service}|${link.topic}|${link.direction}`;
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
    const side = link.direction === "in" ? "source" : "target";
    for (const e of link.endpoints) {
      const disabled = off || !e.enabled;
      const end = system(side, e, disabled);
      if (link.direction === "in") edge(end, service, disabled, route);
      else edge(service, end, disabled, route);
      const config: EndpointConfig = {
        service: link.service,
        topic: link.topic,
        side,
        kind: e.kind,
        system: e.system,
        enabled: link.enabled && e.enabled,
        group: link.group,
        properties: e.properties,
      };
      nodes.get(service)?.config.push(config);
      nodes.get(end)?.config.push(config);
    }
    if (link.direction === "in") edge(service, t, off, route);
    else edge(t, service, off, route);
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
      existing.origin = transformer.origin ?? "manual";
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

/** The nodes and lines on one side of a node: what feeds into it, or what it feeds. */
export interface PathSide {
  nodes: Set<string>;
  edges: Set<string>;
}

/**
 * Everything upstream (feeding into `id`) and downstream (fed by it), following routes: inside a
 * route service, only lines of the same route connect, so a target isn't shown as fed by every
 * source of the service that writes its topic. Both sides include `id`.
 */
export function routePath(
  graph: ClusterGraph,
  id: string,
): { upstream: PathSide; downstream: PathSide } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const walk = (forward: boolean): PathSide => {
    const side: PathSide = { nodes: new Set([id]), edges: new Set() };
    const queue: { node: string; via: ClusterEdge | null }[] = [{ node: id, via: null }];
    for (let item = queue.pop(); item; item = queue.pop()) {
      const { node, via } = item;
      const throughService = via !== null && byId.get(node)?.kind === "service";
      for (const e of graph.edges) {
        if ((forward ? e.from : e.to) !== node || side.edges.has(e.id)) continue;
        const sameRoute =
          !throughService ||
          via.routes.length === 0 ||
          e.routes.length === 0 ||
          e.routes.some((r) => via.routes.includes(r));
        if (!sameRoute) continue;
        side.edges.add(e.id);
        const next = forward ? e.to : e.from;
        side.nodes.add(next);
        queue.push({ node: next, via: e });
      }
    }
    return side;
  };
  return { upstream: walk(false), downstream: walk(true) };
}

/** Which part of the graph to show around a node. */
export type PathScope = "path" | "upstream" | "downstream";

/** Only the part of the graph around `id`: both sides of it, or one of them. */
export function scopeClusterGraph(graph: ClusterGraph, id: string, scope: PathScope): ClusterGraph {
  const { upstream, downstream } = routePath(graph, id);
  const sides =
    scope === "path" ? [upstream, downstream] : [scope === "upstream" ? upstream : downstream];
  const nodes = new Set(sides.flatMap((s) => [...s.nodes]));
  const edges = new Set(sides.flatMap((s) => [...s.edges]));
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => nodes.has(n.id)),
    edges: graph.edges.filter((e) => edges.has(e.id)),
  };
}

/**
 * What in `node` contains `needle` (lower case): `name` for its name, else for a system the first
 * setting of a route that ends there (`host: sftp.example.com`) or its type, for a service its
 * consumer group. A setting belongs to the system end of one route: matching it there keeps the
 * search to that route, not every route of the service. Values of secrets are empty, so they
 * never match.
 */
export function nodeMatch(node: ClusterNode, needle: string): string | null {
  if (node.label.toLowerCase().includes(needle)) return "name";
  for (const c of node.config) {
    if (node.kind === "service") {
      if (c.group?.toLowerCase().includes(needle)) return `group: ${c.group}`;
      continue;
    }
    for (const p of c.properties) {
      if (p.value && p.value.toLowerCase().includes(needle)) return `${p.key}: ${p.value}`;
    }
    if (c.kind?.toLowerCase().includes(needle)) return `type: ${c.kind}`;
  }
  return null;
}

/**
 * The part of the graph on a path through a node matching `query` (case-insensitive): in its
 * name or in a setting of its routes (hosts, paths, topics, queues, …), with everything upstream
 * and downstream of it. `matches` says what matched. An empty query keeps the whole graph.
 */
export function filterClusterGraph(graph: ClusterGraph, query: string): ClusterGraph {
  const needle = query.trim().toLowerCase();
  if (!needle) return graph;
  const matches = new Map<string, string>();
  const nodes = new Set<string>();
  const edges = new Set<string>();
  for (const n of graph.nodes) {
    const match = nodeMatch(n, needle);
    if (match === null) continue;
    matches.set(n.id, match);
    for (const side of Object.values(routePath(graph, n.id))) {
      side.nodes.forEach((id) => nodes.add(id));
      side.edges.forEach((id) => edges.add(id));
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => nodes.has(n.id)),
    edges: graph.edges.filter((e) => edges.has(e.id)),
    matches,
  };
}
