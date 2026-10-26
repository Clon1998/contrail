import type { Viewport } from "@xyflow/react";
import type { ApiError, ServiceTopology, TopicLink } from "@/bindings";
import type { PathScope } from "@/lib/clusterGraph";
import type { Position } from "@/lib/mapLayout";

/** The cluster's routes, as the map loaded them. */
export type RouteScan =
  { kind: "loading" } | { kind: "done"; links: TopicLink[] } | { kind: "error"; error: ApiError };

/** The transformers found in startup lines (read after the routes, it takes longer). */
export type TopologyScan =
  | { kind: "loading" }
  | { kind: "done"; found: ServiceTopology[] }
  | { kind: "error"; error: ApiError };

/** Where the canvas was: its zoom and position, and every node (dragged ones where they were put). */
export interface CanvasMemory {
  /** Which nodes were shown (the positions only apply to the same ones). */
  graphKey: string;
  positions: Map<string, Position>;
  viewport: Viewport;
}

/** What a route map tab looked like, so it comes back the same after showing another tab. */
export interface RouteMapMemory {
  scan: RouteScan;
  topology: TopologyScan;
  query: string;
  focus: string | null;
  scope: { id: string; scope: PathScope } | null;
  hideDisabled: boolean;
  canvas: CanvasMemory | null;
}

/**
 * The route map tabs' memory, by tab key, for this session. Switching tabs unmounts the map (only
 * the active tab is rendered); this brings back the scan, the search, the selection and the
 * canvas without loading or laying anything out again. Closing the tab forgets it.
 */
const memory = new Map<string, RouteMapMemory>();

export function recallRouteMap(key: string): RouteMapMemory | undefined {
  return memory.get(key);
}

export function rememberRouteMap(key: string, change: Partial<RouteMapMemory>) {
  const current = memory.get(key) ?? {
    scan: { kind: "loading" },
    topology: { kind: "loading" },
    query: "",
    focus: null,
    scope: null,
    hideDisabled: false,
    canvas: null,
  };
  memory.set(key, { ...current, ...change });
}

export function forgetRouteMap(key: string) {
  memory.delete(key);
}
