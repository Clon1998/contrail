import type { Endpoint, Route, TopicLink } from "@/bindings";

/** Sources (input systems, services writing to a topic), topics, targets (output systems, readers). */
export type RouteColumn = 0 | 1 | 2;

export interface RouteNode {
  id: string;
  column: RouteColumn;
  kind: "system" | "service" | "topic";
  label: string;
  /** The endpoint type of a system (`sftp`, `artemis_mq`, …); the consumer group(s) of a topic. */
  detail: string | null;
  /** Every route through this node is switched off (or this endpoint is, on all of them). */
  disabled: boolean;
  /** The routes through this node, by index. */
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
}

/**
 * The routes of a service as a graph of three columns: where data comes from, the topics, where
 * it goes. A system that several routes use is one node, so the graph shows fan-in and fan-out.
 * `links` (from "Find connected services") adds the other services on each topic.
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
  const systemId = (column: RouteColumn, e: Endpoint) =>
    `system:${column}:${e.kind ?? ""}|${e.system ?? e.kind ?? "?"}`;
  const system = (column: RouteColumn, e: Endpoint) => ({
    column,
    kind: "system" as const,
    label: e.system ?? e.kind ?? "?",
    detail: e.system ? e.kind : null,
  });

  for (const route of routes) {
    const off = !route.enabled;
    const topic = route.topic ? `topic:${route.topic}` : `topic:#${route.index}`;
    node(
      topic,
      { column: 1, kind: "topic", label: route.topic ?? "—", detail: null },
      route.index,
      off,
    );
    if (route.group) {
      const t = nodes.get(topic);
      if (t) t.detail = [...new Set([...(t.detail?.split(", ") ?? []), route.group])].join(", ");
    }
    if (route.input) {
      const id = systemId(0, route.input);
      const disabled = off || !route.input.enabled;
      node(id, system(0, route.input), route.index, disabled);
      edge(id, topic, route.index, disabled);
    }
    for (const output of route.outputs) {
      const id = systemId(2, output);
      const disabled = off || !output.enabled;
      node(id, system(2, output), route.index, disabled);
      edge(topic, id, route.index, disabled);
    }
    for (const link of links.filter((l) => l.topic === route.topic)) {
      const column: RouteColumn = link.direction === "in" ? 0 : 2;
      const id = `service:${column}:${link.service}`;
      node(id, { column, kind: "service", label: link.service, detail: null }, route.index, off);
      if (column === 0) edge(id, topic, route.index, off);
      else edge(topic, id, route.index, off);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
