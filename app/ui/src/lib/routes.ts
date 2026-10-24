import type { Endpoint, Route, TopicLink } from "@/bindings";

/**
 * Left to right, the same in every service's graph: 0 the systems input services read, 1 the
 * input services writing the topics, 2 the topics, 3 the output services reading them, 4 the
 * systems those write to. The service shown is one of the services in column 1 or 3.
 */
export type RouteColumn = 0 | 1 | 2 | 3 | 4;

/** A box of a drawn graph: an external system, a service or a topic, in one column. */
export interface GraphNode {
  id: string;
  /** Left to right, from 0. */
  column: number;
  kind: "system" | "service" | "topic";
  label: string;
  /** A second, smaller line (an endpoint type, a consumer group). */
  detail: string | null;
  /** Drawn dashed and faded: switched off. */
  disabled: boolean;
  /** The service the graph is about (highlighted). */
  self: boolean;
  /** A state badge (a service's last state in a trace). */
  state?: string | null;
  /** Expected here but not seen (a service that logged nothing about a traced document). */
  missing?: boolean;
}

/** How the step a line stands for ended: done, still waiting, failed. */
export type EdgeTone = "done" | "waiting" | "failed";

/** A line between two nodes, drawn from left to right. */
export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  disabled: boolean;
  /** Coloured by how its step ended. */
  tone?: EdgeTone | null;
  /** Drawn dashed: leads to a node that is `missing`. */
  missing?: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RouteNode extends GraphNode {
  column: RouteColumn;
  /**
   * A system's endpoint type (`sftp`, `artemis_mq`, …); a service's consumer group; a topic's
   * group only when this service's routes use different groups.
   */
  detail: string | null;
  /** Every route through this node is switched off (or this endpoint is, on all of them). */
  disabled: boolean;
  /** The shown service's routes through this node, by index. */
  routes: number[];
}

export interface RouteEdge extends GraphEdge {
  routes: number[];
}

export interface RouteGraph extends Graph {
  nodes: RouteNode[];
  edges: RouteEdge[];
  /** The node of the service shown. */
  selfId: string;
  /** The consumer group of all this service's output routes, when they share one. */
  ownGroup: string | null;
  /**
   * An input service (external systems → topics) or an output service (topics → external
   * systems). A route-generator service has one kind of route only.
   */
  direction: "in" | "out";
}

/** The node id of a service in its column (input services left of the topics, output right). */
const serviceId = (direction: "in" | "out", name: string) =>
  `service:${direction === "in" ? 1 : 3}:${name}`;

/**
 * The routes of service `self` as a graph around its topics: who writes them, who reads them, and
 * the external systems on either end. A system that several routes use is one node, so the graph
 * shows fan-in and fan-out. Without `links` (from "Find connected services") that is the service,
 * its systems and its topics; with them, the other services on those topics join their column,
 * each with its own systems.
 */
export function buildRouteGraph(
  self: string,
  routes: Route[],
  links: TopicLink[] = [],
): RouteGraph {
  const nodes = new Map<string, RouteNode>();
  const edges = new Map<string, RouteEdge>();

  /** Adds a node, or adds the route (and its on/off state) to the existing one. */
  const node = (
    id: string,
    template: Omit<RouteNode, "id" | "routes" | "disabled" | "self">,
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
      nodes.set(id, { ...template, id, routes: [route], disabled, self: false });
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
  /** A system node: one per side, type and system, whoever uses it. */
  const system = (column: 0 | 4, e: Endpoint, route: number, disabled: boolean) => {
    const id = `system:${column}:${e.kind ?? ""}|${e.system ?? e.kind ?? "?"}`;
    const label = e.system ?? e.kind ?? "?";
    node(id, { column, kind: "system", label, detail: e.system ? e.kind : null }, route, disabled);
    return id;
  };
  /** A service and its systems, connected to `topic`. */
  const service = (
    name: string,
    direction: "in" | "out",
    group: string | null,
    endpoints: Endpoint[],
    topic: string,
    route: number,
    disabled: boolean,
  ) => {
    const id = serviceId(direction, name);
    const column = direction === "in" ? 1 : 3;
    const detail = group ? `group ${group}` : null;
    node(id, { column, kind: "service", label: name, detail }, route, disabled);
    if (direction === "in") edge(id, topic, route, disabled);
    else edge(topic, id, route, disabled);
    for (const endpoint of endpoints) {
      const off = disabled || !endpoint.enabled;
      if (direction === "in") edge(system(0, endpoint, route, off), id, route, off);
      else edge(id, system(4, endpoint, route, off), route, off);
    }
  };

  const direction = routes.some((r) => r.input) ? "in" : "out";
  const groups = new Set(routes.flatMap((r) => (r.group ? [r.group] : [])));
  const ownGroup = groups.size === 1 ? ([...groups][0] ?? null) : null;

  for (const route of routes) {
    const off = !route.enabled;
    const topic = route.topic ? `topic:${route.topic}` : `topic:#${route.index}`;
    const detail = groups.size > 1 && route.group ? `group ${route.group}` : null;
    node(topic, { column: 2, kind: "topic", label: route.topic ?? "—", detail }, route.index, off);
    const endpoints = route.input ? [route.input] : route.outputs;
    service(self, direction, route.group, endpoints, topic, route.index, off);
    for (const link of links.filter((l) => l.topic === route.topic)) {
      const disabled = off || !link.enabled;
      service(
        link.service,
        link.direction,
        link.group,
        link.endpoints,
        topic,
        route.index,
        disabled,
      );
    }
  }

  const selfId = serviceId(direction, self);
  const own = nodes.get(selfId);
  if (own) own.self = true;
  return { nodes: [...nodes.values()], edges: [...edges.values()], selfId, ownGroup, direction };
}

/**
 * What lies on a path through `id`: the nodes it is reached from and the nodes it leads to, and
 * the lines between them. Hovering a node highlights exactly that.
 */
export function pathThrough(graph: Graph, id: string): { nodes: Set<string>; edges: Set<string> } {
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

/**
 * Columns for a graph whose paths can be longer than the five fixed columns of one service's
 * routes (input → topic → transformer → topic → output): every node goes one column right of the
 * furthest node leading to it (the longest path from a start), so lines always run left to right.
 * Systems that only receive data are moved to the last column, so all targets line up. A cycle
 * (a service reading the topic it writes) can't push nodes further right forever: each node moves
 * at most once per node of the graph. Nodes nothing leads to then move right, next to where their
 * lines go.
 */
export function layerColumns(
  ids: string[],
  edges: Pick<GraphEdge, "from" | "to">[],
  sinks: Set<string> = new Set(),
): Map<string, number> {
  const columns = new Map(ids.map((id) => [id, 0]));
  for (let round = 0; round < ids.length; round++) {
    let moved = false;
    for (const { from, to } of edges) {
      const next = (columns.get(from) ?? 0) + 1;
      if (columns.has(to) && next > (columns.get(to) ?? 0)) {
        columns.set(to, next);
        moved = true;
      }
    }
    if (!moved) break;
  }
  // A node nothing leads to (a source, a topic only read here) moves right up to just before its
  // first successor, so its lines don't cross the graph.
  const led = new Set(edges.map((e) => e.to));
  for (const id of ids) {
    if (led.has(id)) continue;
    const next = edges.filter((e) => e.from === id).map((e) => columns.get(e.to) ?? 0);
    if (next.length > 0) columns.set(id, Math.max(0, Math.min(...next) - 1));
  }
  const last = Math.max(0, ...[...columns].filter(([id]) => !sinks.has(id)).map(([, c]) => c + 1));
  for (const id of sinks)
    if (columns.has(id)) columns.set(id, Math.max(last, columns.get(id) ?? 0));
  return columns;
}

/**
 * A column's heading from what it holds, for graphs whose length varies (a trace, a cluster):
 * sources, services, topics or targets; a column of mixed kinds has none.
 */
export function columnTitles(graph: Graph): (column: number) => string | null {
  const titles = new Map<number, string>();
  for (const column of new Set(graph.nodes.map((n) => n.column))) {
    const kinds = new Set(graph.nodes.filter((n) => n.column === column).map((n) => n.kind));
    // A column of mixed kinds (a topic next to an early reader's target) has no heading.
    const only = kinds.size === 1 ? [...kinds][0] : null;
    const title =
      only === "topic"
        ? "Topic"
        : only === "system"
          ? column === 0
            ? "Sources"
            : "Targets"
          : only === "service"
            ? "Services"
            : null;
    if (title) titles.set(column, title);
  }
  return (column) => titles.get(column) ?? null;
}
