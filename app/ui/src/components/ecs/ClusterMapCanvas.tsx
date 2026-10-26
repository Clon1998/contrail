import { createContext, use, useEffect, useMemo, useState } from "react";
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

type MapNodeData = { node: ClusterNode; tone: Tone; match: string | null };
type MapNode = Node<MapNodeData, "map">;

const NODE_ICON = { system: PlugIcon, service: ServerIcon, topic: WavesIcon } as const;

/** One service, topic or system: its route settings on hover, its options on right-click. */
function MapNodeView({ data }: NodeProps<MapNode>) {
  const { node, tone, match } = data;
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
        "flex min-w-0 items-start gap-2 border bg-card px-2.5 py-1.5 text-left text-xs transition-opacity duration-150 hover:bg-accent",
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
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
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
            <TooltipContent side="bottom" className="max-w-[28rem] p-2">
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
}) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

function Canvas({
  graph,
  selected,
  actions,
}: {
  graph: ClusterGraph;
  selected: string | null;
  actions: MapActions;
}) {
  const flow = useReactFlow();
  const [layout, setLayout] = useState<{ graph: ClusterGraph; at: Map<string, Position> } | null>(
    null,
  );
  // Bumped by "Re-layout": the same graph laid out again, dragged nodes back in place.
  const [round, setRound] = useState(0);
  const [nodes, setNodes, onNodesChange] = useNodesState<MapNode>([]);

  useEffect(() => {
    let current = true;
    void layoutClusterGraph(graph).then((at) => current && setLayout({ graph, at }));
    return () => {
      current = false;
    };
  }, [graph, round]);

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
    setNodes(
      layout.graph.nodes.map((node) => ({
        id: node.id,
        type: "map",
        position: layout.at.get(node.id) ?? { x: 0, y: 0 },
        data: { node, tone: null, match: null },
      })),
    );
  }, [layout, setNodes]);
  // Fit once the nodes of a new layout are measured (React Flow needs their sizes for it).
  const measured = useNodesInitialized();
  useEffect(() => {
    if (layout && measured) void flow.fitView({ padding: 0.1, duration: 200, maxZoom: 1 });
  }, [layout, measured, flow]);

  const styled = nodes.map((n) => ({
    ...n,
    data: { ...n.data, tone: toneOf(n.id), match: graph.matches?.get(n.id) ?? null },
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
            onClick={() => void flow.zoomIn()}
          >
            <ZoomInIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            onClick={() => void flow.zoomOut()}
          >
            <ZoomOutIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Fit the map"
            onClick={() => void flow.fitView({ padding: 0.1, duration: 200, maxZoom: 1 })}
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
