import type { Endpoint, ServiceTrace, TopicLink, TraceHop } from "@/bindings";
import { layerColumns, type EdgeTone, type GraphEdge, type GraphNode } from "./routes";

export interface TraceNode extends GraphNode {
  /** A service's last state in the trace (its badge). */
  state: string | null;
  /**
   * A service on one of the topics (from the route scan) that logged nothing about the ID, or
   * that wasn't searched (`detail` tells which).
   */
  missing: boolean;
}

export interface TraceEdge extends GraphEdge {
  tone: EdgeTone | null;
  missing: boolean;
}

export interface TraceGraph {
  nodes: TraceNode[];
  edges: TraceEdge[];
  /** Services in the trace without a status event on a topic (an API with a trace ID). */
  others: string[];
}

export const serviceNodeId = (name: string) => `service:${name}`;

const TERMINAL_DONE = ["COMPLETED", "PUBLISHED"];

/** Completed or published: done; failed: failed; anything else (consuming, retrying): waiting. */
export function hopTone(state: string): EdgeTone {
  const upper = state.toUpperCase();
  if (upper === "FAILED") return "failed";
  return TERMINAL_DONE.includes(upper) ? "done" : "waiting";
}

/**
 * The way a document took, as a graph: the services that wrote it to a topic, the topics, the
 * services that read it there (a transformer reads one topic and writes the next), each line in
 * the colour of how that hop ended. With `links` from the cluster's route scan, the external
 * systems at both ends join in, and so do services on the same topics that logged nothing about
 * the document: those are where it may be missing (or they weren't among the `searched`).
 */
export function buildTraceGraph(
  hops: TraceHop[],
  services: ServiceTrace[],
  links: TopicLink[] = [],
  searched: string[] = [],
): TraceGraph {
  const nodes = new Map<string, Omit<TraceNode, "column">>();
  const edges = new Map<string, TraceEdge>();
  const state = new Map(services.map((s) => [s.service, s.lastState]));

  const addNode = (node: Omit<TraceNode, "column">) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = (from: string, to: string, tone: EdgeTone | null, disabled = false) => {
    const id = `${from}->${to}`;
    if (!edges.has(id)) edges.set(id, { id, from, to, tone, disabled, missing: false });
  };
  const topic = (name: string) =>
    addNode({
      id: `topic:${name}`,
      kind: "topic",
      label: name,
      detail: null,
      disabled: false,
      self: false,
      state: null,
      missing: false,
    });
  const service = (name: string, group: string | null, missing: boolean, disabled = false) => {
    const id = serviceNodeId(name);
    const existing = nodes.get(id);
    if (existing) {
      // A reader's group, once it is known (its writing hop has none).
      if (group && !existing.detail) existing.detail = `group ${group}`;
      return id;
    }
    return addNode({
      id,
      kind: "service",
      label: name,
      detail: missing
        ? searched.includes(name)
          ? "no event"
          : "not searched"
        : group
          ? `group ${group}`
          : null,
      disabled,
      self: false,
      state: state.get(name) ?? null,
      missing,
    });
  };
  const system = (side: "source" | "target", endpoint: Endpoint, disabled: boolean) => {
    const label = endpoint.system ?? endpoint.kind ?? "?";
    const id = addNode({
      id: `system:${side}:${endpoint.kind ?? ""}|${label}`,
      kind: "system",
      label,
      detail: endpoint.system ? endpoint.kind : null,
      disabled,
      self: false,
      state: null,
      missing: false,
    });
    return id;
  };

  for (const hop of hops) {
    const t = topic(hop.topic);
    const tone = hopTone(hop.lastState);
    if (hop.direction === "writes") addEdge(service(hop.service, null, false), t, tone);
    else addEdge(t, service(hop.service, hop.group, false), tone);
  }

  const topics = new Set(hops.map((h) => h.topic));
  const inTrace = new Set(hops.map((h) => h.service));
  for (const link of links) {
    if (!topics.has(link.topic)) continue;
    const t = `topic:${link.topic}`;
    const known = inTrace.has(link.service);
    const disabled = !link.enabled;
    // A route that is switched off isn't where the document went missing, and neither is another
    // writer of the topic (a sibling of the one that wrote the document).
    if (!known && (disabled || link.direction === "in")) continue;
    const id = service(link.service, link.group, !known, disabled);
    if (link.direction === "in") {
      for (const e of link.endpoints)
        addEdge(system("source", e, !e.enabled), id, null, !e.enabled);
    } else {
      if (!known) addEdge(t, id, null);
      for (const e of link.endpoints)
        addEdge(id, system("target", e, !e.enabled), null, !e.enabled);
    }
  }

  // Targets right next to their service: lined up at the end, the lines of early readers would
  // cross the rest of the way.
  const columns = layerColumns([...nodes.keys()], [...edges.values()]);
  const missing = (id: string) => nodes.get(id)?.missing ?? false;
  return {
    nodes: [...nodes.values()].map((n) => ({ ...n, column: columns.get(n.id) ?? 0 })),
    edges: [...edges.values()].map((e) => ({ ...e, missing: missing(e.from) || missing(e.to) })),
    others: services.map((s) => s.service).filter((s) => !inTrace.has(s)),
  };
}
