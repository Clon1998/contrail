import type { ELK, ElkNode } from "elkjs/lib/elk.bundled.js";
import type { ClusterGraph, ClusterNode } from "./clusterGraph";

/** A node's top-left corner on the canvas, in pixels. */
export interface Position {
  x: number;
  y: number;
}

/** The height of every node on the map (one or two lines of text). */
export const NODE_HEIGHT = 44;

/** A node's width: room for its name (monospace for topics), within limits. */
export function nodeWidth(node: Pick<ClusterNode, "kind" | "label">): number {
  const perChar = node.kind === "topic" ? 7.2 : 6.8;
  return Math.round(Math.min(300, Math.max(140, 48 + node.label.length * perChar)));
}

/**
 * The input ELK lays out: every node with its size, every line, left to right in layers (a
 * node one layer right of what leads to it), with room between layers for the lines.
 */
export function toElkGraph(graph: Pick<ClusterGraph, "nodes" | "edges">): ElkNode {
  return {
    id: "map",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.layered.spacing.nodeNodeBetweenLayers": "90",
      "elk.spacing.nodeNode": "14",
      "elk.spacing.componentComponent": "40",
      // Fewer crossings, and nodes in the order the graph lists them where it's a tie, so the
      // same cluster comes out the same way every time.
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    },
    children: graph.nodes.map((n) => ({ id: n.id, width: nodeWidth(n), height: NODE_HEIGHT })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
}

/**
 * One layout engine for the app (it keeps no state between layouts), loaded the first time a map
 * is laid out: ELK is a large script that most sessions never need.
 */
let engine: Promise<ELK> | null = null;

/** Where each node goes: ELK's layered layout of the graph. */
export async function layoutClusterGraph(
  graph: Pick<ClusterGraph, "nodes" | "edges">,
): Promise<Map<string, Position>> {
  engine ??= import("elkjs/lib/elk.bundled.js").then(({ default: Elk }) => new Elk());
  const result = await (await engine).layout(toElkGraph(graph));
  return new Map((result.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }]));
}
