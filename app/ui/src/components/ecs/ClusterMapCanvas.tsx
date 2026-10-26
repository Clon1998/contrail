import { createContext, use, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Handle,
  MiniMap,
  Position as Side,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import {
  LayoutGridIcon,
  MaximizeIcon,
  PlugIcon,
  ServerIcon,
  WavesIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { routePath, type ClusterGraph, type ClusterNode, type PathScope } from "@/lib/clusterGraph";
import { layoutClusterGraph, NODE_HEIGHT, nodeWidth, type Position } from "@/lib/mapLayout";
import type { CanvasMemory } from "@/stores/routeMaps";
import { ConfigList } from "./RouteConfig";

/** Lines feeding into the selected node (upstream), and lines it feeds (downstream). */
export const UPSTREAM_COLOR = "oklch(0.7 0.17 300)";
export const DOWNSTREAM_COLOR = "var(--primary)";

/** What a node can ask the map for (its menu and its click). */
interface MapActions {
  select: (id: string) => void;
  scope: (id: string, scope: PathScope) => void;
  openService: (name: string) => void;
  editTopics: (name: string) => void;
}

/**
 * The actions reach the nodes through a context, not their data: React Flow compares node data
 * to decide what to redraw, and new callbacks on every render would redraw every node.
 */
const Actions = createContext<MapActions | null>(null);

/** How a node is drawn relative to the selection. */
type Tone = "selected" | "upstream" | "downstream" | "both" | "dimmed" | null;

type MapNodeData = {
  node: ClusterNode;
  tone: Tone;
  match: string | null;
  /** The search match last jumped to. */
  current: boolean;
};
type MapNode = Node<MapNodeData, "map">;

const NODE_ICON = { system: PlugIcon, service: ServerIcon, topic: WavesIcon } as const;

/**
 * One service, topic or system: its route settings on hover, its options on right-click. Every
 * node has the same height (for the layout); one-line nodes (topics) are centred in it.
 */
function MapNodeView({ data }: NodeProps<MapNode>) {
  const { node, tone, match, current } = data;
  const actions = use(Actions);
  const Icon = NODE_ICON[node.kind];
  const box = (
    <button
      type="button"
      aria-label={`${node.kind} ${node.label}${node.disabled ? " (disabled)" : ""}`}
      aria-pressed={tone === "selected"}
      onClick={() => actions?.select(node.id)}
      style={{ width: nodeWidth(node), height: NODE_HEIGHT }}
      className={cn(
        "flex min-w-0 items-center gap-2 border bg-card px-2.5 py-1.5 text-left text-xs transition-opacity duration-150 hover:bg-accent",
        node.kind === "topic" ? "rounded-full border-primary/40 bg-primary/5" : "rounded-md",
        node.kind === "service" && "border-dashed border-border",
        node.kind === "service" && node.transformer && "border-solid",
        node.kind === "system" && "border-border",
        node.disabled && "border-dashed opacity-60",
        tone === "selected" && "ring-2 ring-primary",
        tone === "upstream" && "border-solid border-[color:var(--map-upstream)]",
        (tone === "downstream" || tone === "both") && "border-solid border-primary",
        tone === "dimmed" && "opacity-30",
        match !== null && "ring-2 ring-warning/70",
        current && "bg-warning/15 ring-4 ring-warning",
      )}
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            "truncate font-medium",
            node.kind === "topic" && "font-mono",
            node.disabled && "line-through",
          )}
        >
          {node.label}
        </span>
        {match !== null && match !== "name" ? (
          <span className="truncate text-[11px] text-warning">{match}</span>
        ) : (
          (node.detail !== null || node.disabled) && (
            <span className="truncate text-[11px] text-muted-foreground">
              {node.detail}
              {node.disabled && <span className="text-warning"> disabled</span>}
            </span>
          )
        )}
      </span>
    </button>
  );

  return (
    <>
      <Handle type="target" position={Side.Left} isConnectable={false} className="invisible" />
      {/* Both triggers pass their props down to the button (Radix `asChild`), so the hover card
          and the right-click menu share it. */}
      <ContextMenu>
        {node.config.length > 0 ? (
          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild>{box}</ContextMenuTrigger>
            </TooltipTrigger>
            {/* A card in the popover colours rather than the inverted tooltip ones. */}
            <TooltipContent
              side="bottom"
              sideOffset={6}
              arrow={false}
              className="max-w-[28rem] border border-border bg-popover p-2 text-popover-foreground shadow-lg"
            >
              <ConfigList config={node.config} node={node} compact />
            </TooltipContent>
          </Tooltip>
        ) : (
          <ContextMenuTrigger asChild>{box}</ContextMenuTrigger>
        )}
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => actions?.scope(node.id, "path")}>
            Only this path
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => actions?.scope(node.id, "upstream")}>
            Only what feeds into it
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => actions?.scope(node.id, "downstream")}>
            Only what it feeds
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => actions?.select(node.id)}>Show details</ContextMenuItem>
          {node.kind === "service" && (
            <ContextMenuItem onSelect={() => actions?.openService(node.label)}>
              Open {node.label}
            </ContextMenuItem>
          )}
          {node.kind === "service" && (
            <ContextMenuItem onSelect={() => actions?.editTopics(node.label)}>
              {node.origin === "logs"
                ? "Override topics"
                : node.transformer
                  ? "Edit topics"
                  : "Enter as transformer"}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <Handle type="source" position={Side.Right} isConnectable={false} className="invisible" />
    </>
  );
}

const NODE_TYPES = { map: MapNodeView };

/**
 * The cluster's route map on a canvas: zoom and pan, nodes laid out by ELK and draggable,
 * "Re-layout" puts them back. Selecting a node colours what feeds into it and what it feeds.
 */
export function ClusterMapCanvas(props: {
  graph: ClusterGraph;
  selected: string | null;
  actions: MapActions;
  /** Where the canvas was when it was last shown; it starts there if the same nodes are drawn. */
  saved: CanvasMemory | null;
  /** Called when the canvas goes away (another tab is shown), with where it was. */
  onSave: (memory: CanvasMemory) => void;
  /** A search match to centre and zoom to (`nonce` makes jumping to it again work). */
  jump: { id: string; nonce: number } | null;
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

/** Which nodes a graph has: a saved canvas only applies to the same ones. */
const graphKey = (graph: ClusterGraph) =>
  graph.nodes
    .map((n) => n.id)
    .sort()
    .join("\n");

function Canvas({
  graph,
  selected,
  actions,
  saved,
  onSave,
  jump,
}: Parameters<typeof ClusterMapCanvas>[0]) {
  const flow = useReactFlow();
  const key = useMemo(() => graphKey(graph), [graph]);
  // Back where it was (a saved canvas of the same nodes), or laid out by ELK below.
  const [layout, setLayout] = useState<{
    graph: ClusterGraph;
    at: Map<string, Position>;
    viewport?: Viewport;
  } | null>(() =>
    saved?.graphKey === key ? { graph, at: saved.positions, viewport: saved.viewport } : null,
  );
  const restoredGraph = useRef(layout ? graph : null);
  // The node a restored canvas was saved with is already in view: no automatic pan for it.
  const restoredSelection = useRef(layout ? selected : null);
  // Bumped by "Re-layout": the same graph laid out again, dragged nodes back in place.
  const [round, setRound] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);
  // The map's element, and where the map was before an automatic pan (see below).
  const box = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Viewport | null>(null);
  const userMoved = () => {
    restoreRef.current = null;
  };

  useEffect(() => {
    if (restoredGraph.current === graph && round === 0) return;
    restoredGraph.current = null;
    let current = true;
    void layoutClusterGraph(graph).then((at) => current && setLayout({ graph, at }));
    return () => {
      current = false;
    };
  }, [graph, round]);

  // Saved when the canvas goes away. The ref is updated after every render, so the cleanup (which
  // runs once, at the end) sees the latest nodes and callback.
  const latest = useRef({ nodes, key, onSave });
  useEffect(() => {
    latest.current = { nodes, key, onSave };
  });
  useEffect(
    () => () => {
      const { nodes: last, key: shown, onSave: save } = latest.current;
      if (last.length === 0) return;
      save({
        graphKey: shown,
        positions: new Map(last.map((n) => [n.id, n.position])),
        viewport: flow.getViewport(),
      });
    },
    [flow],
  );

  const path = useMemo(
    () =>
      selected && graph.nodes.some((n) => n.id === selected) ? routePath(graph, selected) : null,
    [graph, selected],
  );
  const toneOf = (id: string): Tone => {
    if (!path) return null;
    if (id === selected) return "selected";
    const up = path.upstream.nodes.has(id);
    const down = path.downstream.nodes.has(id);
    return up && down ? "both" : up ? "upstream" : down ? "downstream" : "dimmed";
  };

  // A new layout (another graph, or "Re-layout") places every node; dragging moves them until
  // the next one. A new selection only changes how they look (below).
  useEffect(() => {
    if (!layout) return;
    restoreRef.current = null;
    setNodes(
      layout.graph.nodes.map((node) => ({
        id: node.id,
        type: "map",
        position: layout.at.get(node.id) ?? { x: 0, y: 0 },
        data: { node, tone: null, match: null, current: false },
      })),
    );
  }, [layout, setNodes]);
  // Selecting a node opens the details next to the map, which gets narrower: if that pushed the
  // node out of view (or it was partly outside already), pan it to the centre, keeping the zoom.
  // Closing the details undoes that pan, unless the user moved the map since: `restoreRef` is where
  // the map was before the first automatic pan, cleared by any move of the user's own.
  useEffect(() => {
    if (!selected) {
      if (restoreRef.current) void flow.setViewport(restoreRef.current, { duration: 300 });
      restoreRef.current = null;
      restoredSelection.current = null;
      return;
    }
    if (selected === restoredSelection.current) {
      restoredSelection.current = null;
      return;
    }
    // After the panel has opened and the map has its new width.
    const timer = setTimeout(() => {
      const node = flow.getInternalNode(selected);
      const element = box.current;
      if (!node || !element) return;
      const { x, y, zoom } = flow.getViewport();
      const at = node.internals.positionAbsolute;
      const width = node.measured.width ?? 0;
      const height = node.measured.height ?? 0;
      const left = at.x * zoom + x;
      const top = at.y * zoom + y;
      const visible =
        left >= 0 &&
        top >= 0 &&
        left + width * zoom <= element.clientWidth &&
        top + height * zoom <= element.clientHeight;
      if (!visible) {
        restoreRef.current ??= { x, y, zoom };
        void flow.setCenter(at.x + width / 2, at.y + height / 2, { zoom, duration: 300 });
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [selected, flow]);

  // Jumping to a search match: centre it and zoom in to at least 100 %. A move the user asked
  // for, so closing the details won't undo it.
  useEffect(() => {
    if (!jump) return;
    const node = flow.getInternalNode(jump.id);
    if (!node) return;
    userMoved();
    const at = node.internals.positionAbsolute;
    const zoom = Math.max(flow.getViewport().zoom, 1);
    void flow.setCenter(
      at.x + (node.measured.width ?? 0) / 2,
      at.y + (node.measured.height ?? 0) / 2,
      { zoom, duration: 300 },
    );
  }, [jump, flow]);

  // Fit once the nodes of a new layout are measured (React Flow needs their sizes for it); a
  // restored canvas goes back to its zoom and position instead.
  const measured = useNodesInitialized();
  useEffect(() => {
    if (!layout || !measured) return;
    if (layout.viewport) void flow.setViewport(layout.viewport);
    else void flow.fitView({ padding: 0.1, duration: 200, maxZoom: 1 });
  }, [layout, measured, flow]);

  const styled = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      tone: toneOf(n.id),
      match: graph.matches?.get(n.id) ?? null,
      current: n.id === jump?.id,
    },
  }));
  const edges: Edge[] = graph.edges.map((e) => {
    const up = path?.upstream.edges.has(e.id) ?? false;
    const down = path?.downstream.edges.has(e.id) ?? false;
    const lit = up || down;
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      style: {
        stroke: down ? DOWNSTREAM_COLOR : up ? UPSTREAM_COLOR : "var(--muted-foreground)",
        strokeWidth: lit ? 2 : 1.25,
        strokeDasharray: e.disabled ? "4 4" : undefined,
        opacity: path && !lit ? 0.15 : lit ? 1 : 0.5,
      },
      zIndex: lit ? 1 : 0,
    };
  });

  if (!layout) {
    return (
      <div aria-busy className="grid h-full grid-cols-5 gap-6 p-6">
        {Array.from({ length: 5 }, (_, column) => (
          <div key={column} className="flex flex-col justify-center gap-3">
            {Array.from({ length: 4 + (column % 3) }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <Actions value={actions}>
      <div
        ref={box}
        role="group"
        aria-label="Cluster route map"
        className="relative h-full [--map-upstream:oklch(0.7_0.17_300)]"
      >
        <ReactFlow
          nodes={styled}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onPaneClick={() => actions.select("")}
          // Only the user's own moves come with an event (not the automatic pans).
          onMoveStart={(event) => event && userMoved()}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          minZoom={0.05}
          maxZoom={2}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: false }}
          className="bg-background"
        >
          <Background gap={24} size={1} color="var(--border)" />
          <MiniMap
            pannable
            zoomable
            ariaLabel="Overview of the route map"
            className="!bg-card rounded-md border border-border"
            maskColor="color-mix(in oklab, var(--background) 70%, transparent)"
            nodeColor={(n) =>
              (n.data as MapNodeData).node.kind === "topic"
                ? "var(--primary)"
                : "var(--muted-foreground)"
            }
          />
        </ReactFlow>
        <div className="absolute top-2 left-2 flex gap-1 rounded-md border border-border bg-card/90 p-0.5 shadow-sm">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            onClick={() => {
              userMoved();
              void flow.zoomIn();
            }}
          >
            <ZoomInIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() => {
              userMoved();
              void flow.zoomOut();
            }}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Fit the map"
            onClick={() => {
              userMoved();
              void flow.fitView({ padding: 0.1, duration: 200, maxZoom: 1 });
            }}
          >
            <MaximizeIcon />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            tooltip="Lay the map out again (dragged nodes go back)"
            onClick={() => setRound((r) => r + 1)}
          >
            <LayoutGridIcon /> Re-layout
          </Button>
        </div>
      </div>
    </Actions>
  );
}
