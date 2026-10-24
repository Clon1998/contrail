import { useLayoutEffect, useRef, useState } from "react";
import { PlugIcon, ServerIcon, WavesIcon } from "lucide-react";
import { cn } from "cn";
import { StateBadge } from "@/components/logs/StateBadge";
import { pathThrough, type EdgeTone, type Graph, type GraphNode } from "@/lib/routes";

const EDGE_TONE: Record<EdgeTone, string> = {
  done: "stroke-success/70",
  waiting: "stroke-warning",
  failed: "stroke-destructive",
};

interface Path {
  id: string;
  d: string;
}

/**
 * A graph's columns of nodes as HTML, and the lines between them as an SVG drawn over them. The
 * lines are measured from the rendered nodes after layout (and again when the card resizes), so
 * the nodes can be ordinary, wrapping, accessible buttons.
 */
export function GraphView({
  graph,
  label = "Route graph",
  columnTitle,
  focus,
  onFocus,
}: {
  graph: Graph;
  /** The accessible name of the whole graph. */
  label?: string;
  /** The heading above a column, if it has one. */
  columnTitle: (column: number) => string | null;
  focus: string | null;
  onFocus: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  // Refs to the node elements by node id, filled while rendering (a callback ref per node).
  const nodeElements = useRef(new Map<string, HTMLElement>());
  const [paths, setPaths] = useState<Path[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);

  // `useLayoutEffect` runs after React has put the nodes into the page but before the browser
  // paints, so the lines appear together with the nodes.
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      setPaths(
        graph.edges.flatMap((edge) => {
          const from = nodeElements.current.get(edge.from)?.getBoundingClientRect();
          const to = nodeElements.current.get(edge.to)?.getBoundingClientRect();
          if (!from || !to) return [];
          const x1 = from.right - box.left;
          const y1 = from.top + from.height / 2 - box.top;
          const x2 = to.left - box.left;
          const y2 = to.top + to.height / 2 - box.top;
          const bend = Math.max(16, (x2 - x1) / 2);
          return [
            { id: edge.id, d: `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}` },
          ];
        }),
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [graph]);

  // What to highlight: the paths through the hovered node, else through the selected one.
  const activeId = hovered ?? focus;
  const active = activeId ? pathThrough(graph, activeId) : null;
  const columns = [...new Set(graph.nodes.map((n) => n.column))]
    .sort((a, b) => a - b)
    .map((column) => ({ column, nodes: graph.nodes.filter((n) => n.column === column) }));

  return (
    <div
      ref={container}
      role="group"
      aria-label={label}
      className={cn("relative grid py-1", columns.length > 3 ? "gap-x-8" : "gap-x-12")}
      // Columns as wide as their names need, shrinking evenly when the card is too narrow.
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, auto))` }}
    >
      <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
        {paths.map((path) => {
          const edge = graph.edges.find((e) => e.id === path.id);
          if (!edge) return null;
          const lit = active?.edges.has(edge.id) ?? false;
          return (
            <path
              key={path.id}
              d={path.d}
              fill="none"
              strokeWidth={lit || edge.tone ? 2 : 1.5}
              strokeDasharray={edge.disabled || edge.missing ? "4 4" : undefined}
              className={cn(
                "transition-[opacity,stroke] duration-150",
                edge.tone
                  ? EDGE_TONE[edge.tone]
                  : lit
                    ? "stroke-primary"
                    : "stroke-muted-foreground/45",
                active && !lit && "opacity-25",
              )}
            />
          );
        })}
      </svg>
      {columns.map(({ column, nodes }) => (
        <div key={column} className="flex min-w-0 flex-col">
          <h4 className="mb-2 min-h-4 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {columnTitle(column)}
          </h4>
          <div className="flex flex-1 flex-col justify-center gap-2">
            {nodes.map((node) => (
              <GraphNodeButton
                key={node.id}
                node={node}
                ref={(element) => {
                  if (element) nodeElements.current.set(node.id, element);
                  else nodeElements.current.delete(node.id);
                }}
                selected={focus === node.id}
                dimmed={active ? !active.nodes.has(node.id) : false}
                onClick={() => onFocus(node.id)}
                onHover={(on) => setHovered(on ? node.id : null)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const NODE_ICON = { system: PlugIcon, service: ServerIcon, topic: WavesIcon } as const;

function GraphNodeButton({
  node,
  ref,
  selected,
  dimmed,
  onClick,
  onHover,
}: {
  node: GraphNode;
  ref: (element: HTMLButtonElement | null) => void;
  selected: boolean;
  dimmed: boolean;
  onClick: () => void;
  onHover: (on: boolean) => void;
}) {
  const Icon = NODE_ICON[node.kind];
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${node.kind} ${node.label}${node.self ? " (this service)" : ""}${node.disabled ? " (disabled)" : ""}${node.state ? ` (${node.state})` : ""}${node.missing ? " (no event)" : ""}`}
      aria-pressed={selected}
      title={node.label}
      onClick={onClick}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      className={cn(
        "relative flex min-w-0 items-start gap-2 border bg-card px-2.5 py-1.5 text-left text-xs transition-opacity duration-150 hover:bg-accent",
        node.kind === "topic" ? "rounded-full border-primary/40 bg-primary/5" : "rounded-md",
        node.kind === "service" && !node.self && "border-dashed border-border",
        node.kind === "system" && "border-border",
        node.self && "border-primary/60 bg-primary/10",
        node.disabled && "border-dashed opacity-60",
        node.missing && "border-dashed border-warning/60 bg-transparent",
        selected && "ring-2 ring-primary",
        dimmed && "opacity-40",
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
        {node.state && <StateBadge state={node.state} className="mt-0.5 self-start" />}
        {(node.detail !== null || node.disabled || node.self) && (
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground",
              node.missing && "text-warning",
            )}
          >
            {/* Its own group is in the line above the graph. */}
            {node.self ? <span className="text-primary">this service</span> : node.detail}
            {node.disabled && <span className="text-warning"> disabled</span>}
          </span>
        )}
      </span>
    </button>
  );
}
