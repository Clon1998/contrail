import type { Endpoint, Route, TopicLink } from "@/bindings";

/**
 * Left to right: 0 where upstream services get their data, 1 this service's sources (input
 * systems, services writing to its topics), 2 the topics, 3 its targets (output systems,
 * services reading its topics), 4 where those downstream services send their data.
 */
export type RouteColumn = 0 | 1 | 2 | 3 | 4;

export interface RouteNode {
  id: string;
  column: RouteColumn;
  kind: "system" | "service" | "topic";
  label: string;
  /**
   * A system's endpoint type (`sftp`, `artemis_mq`, …); a service's consumer group; a topic's
   * group only when this service's routes use different groups (otherwise it's `ownGroup`).
   */
  detail: string | null;
  /** Every route through this node is switched off (or this endpoint is, on all of them). */
  disabled: boolean;
  /** This service's routes through this node, by index. */
  routes: number[];
}

export interface RouteEdge {
  id: string;
  from: string;
  to: string;
  disabled: boolean;
  routes: number[];
}

export interface RouteGraph {
  nodes: RouteNode[];
  edges: RouteEdge[];
  /** The consumer group of all this service's output routes, when they share one. */
  ownGroup: string | null;
}

/**
 * The routes of a service as a graph: where data comes from, the topics, where it goes. A system
 * that several routes use is one node, so the graph shows fan-in and fan-out. `links` (from "Find
 * connected services") adds the other services on each topic, with their group, and one step
 * further: where the services upstream get their data and where those downstream send it.
 */
export function buildRouteGraph(routes: Route[], links: TopicLink[] = []): RouteGraph {
  const nodes = new Map<string, RouteNode>();
  const edges = new Map<string, RouteEdge>();

  /** Adds a node, or adds the route (and its on/off state) to the existing one. */
  const node = (
    id: string,
    template: Omit<RouteNode, "id" | "routes" | "disabled">,
    route: number,
    disabled: boolean,
  ) => {
    const existing = nodes.get(id);
    if (existing) {
      if (!existing.routes.includes(route)) existing.routes.push(route);
      existing.disabled &&= disabled;
      // A service reading several topics in different groups lists them all, once each.
      const details = new Set(
        [...(existing.detail?.split(", ") ?? []), template.detail ?? []].flat(),
      );
      existing.detail = details.size > 0 ? [...details].join(", ") : null;
    } else {
      nodes.set(id, { ...template, id, routes: [route], disabled });
    }
  };
  const edge = (from: string, to: string, route: number, disabled: boolean) => {
    const id = `${from}->${to}`;
    const existing = edges.get(id);
    if (existing) {
      if (!existing.routes.includes(route)) existing.routes.push(route);
      existing.disabled &&= disabled;
    } else {
      edges.set(id, { id, from, to, routes: [route], disabled });
    }
  };
  /** A system node: one per column, type and system, whoever uses it. */
  const system = (column: RouteColumn, e: Endpoint, route: number, disabled: boolean) => {
    const id = `system:${column}:${e.kind ?? ""}|${e.system ?? e.kind ?? "?"}`;
    const label = e.system ?? e.kind ?? "?";
    node(id, { column, kind: "system", label, detail: e.system ? e.kind : null }, route, disabled);
    return id;
  };

  const groups = new Set(routes.flatMap((r) => (r.group ? [r.group] : [])));
  const ownGroup = groups.size === 1 ? ([...groups][0] ?? null) : null;

  for (const route of routes) {
    const off = !route.enabled;
    const topic = route.topic ? `topic:${route.topic}` : `topic:#${route.index}`;
    const detail = groups.size > 1 && route.group ? `group ${route.group}` : null;
    node(topic, { column: 2, kind: "topic", label: route.topic ?? "—", detail }, route.index, off);
    if (route.input) {
      const disabled = off || !route.input.enabled;
      edge(system(1, route.input, route.index, disabled), topic, route.index, disabled);
    }
    for (const output of route.outputs) {
      const disabled = off || !output.enabled;
      edge(topic, system(3, output, route.index, disabled), route.index, disabled);
    }
    for (const link of links.filter((l) => l.topic === route.topic)) {
      const upstream = link.direction === "in";
      const column: RouteColumn = upstream ? 1 : 3;
      const id = `service:${column}:${link.service}`;
      const disabled = off || !link.enabled;
      const label = link.service;
      const group = link.group ? `group ${link.group}` : null;
      node(id, { column, kind: "service", label, detail: group }, route.index, disabled);
      if (upstream) edge(id, topic, route.index, disabled);
      else edge(topic, id, route.index, disabled);
      // One step further: the other service's own sources or targets.
      for (const endpoint of link.endpoints) {
        const off2 = disabled || !endpoint.enabled;
        if (upstream) edge(system(0, endpoint, route.index, off2), id, route.index, off2);
        else edge(id, system(4, endpoint, route.index, off2), route.index, off2);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], ownGroup };
}

/**
 * What lies on a path through `id`: the nodes it is reached from and the nodes it leads to, and
 * the lines between them. Hovering a node highlights exactly that.
 */
export function pathThrough(
  graph: RouteGraph,
  id: string,
): { nodes: Set<string>; edges: Set<string> } {
  const walk = (start: string, next: (from: string) => string[]) => {
    const seen = new Set<string>();
    const queue = [start];
    for (let current = queue.pop(); current !== undefined; current = queue.pop()) {
      for (const n of next(current)) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    return seen;
  };
  const after = walk(id, (n) => graph.edges.filter((e) => e.from === n).map((e) => e.to));
  const before = walk(id, (n) => graph.edges.filter((e) => e.to === n).map((e) => e.from));
  const downstream = new Set([id, ...after]);
  const upstream = new Set([id, ...before]);
  const edges = graph.edges.filter(
    (e) =>
      (downstream.has(e.from) && downstream.has(e.to)) ||
      (upstream.has(e.from) && upstream.has(e.to)),
  );
  return { nodes: new Set([...downstream, ...upstream]), edges: new Set(edges.map((e) => e.id)) };
}
