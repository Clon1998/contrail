import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Loader2Icon,
  NetworkIcon,
  PlugIcon,
  ServerIcon,
  SquareArrowOutUpRightIcon,
  WavesIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import {
  commands,
  type ApiError,
  type ContainerDefinitionInfo,
  type Endpoint,
  type Route,
  type RouteProperty,
  type TopicLink,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildRouteGraph, pathThrough, type RouteGraph, type RouteNode } from "@/lib/routes";
import { useEcs } from "@/stores/ecs";
import { SecretValue, Value } from "./Environment";
import { OverviewCard } from "./OverviewCard";

const COLUMN_TITLES = ["Their sources", "From", "Topics", "To", "Their targets"] as const;

/**
 * The routes of a routing-framework service (rebuilt from its environment in Rust), drawn as a
 * graph: where data comes from → the topics → where it goes, each system once. A click on a node
 * shows the settings of its routes. On request, the services on the other side of each topic.
 */
export function Routes({ containers }: { containers: ContainerDefinitionInfo[] }) {
  const routes = useMemo(() => containers.flatMap((c) => c.routes?.routes ?? []), [containers]);
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const [links, setLinks] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done"; links: TopicLink[] }
    | { kind: "error"; error: ApiError }
  >({ kind: "idle" });
  const [focus, setFocus] = useState<string | null>(null);
  const graph = useMemo(
    () => buildRouteGraph(routes, links.kind === "done" ? links.links : []),
    [routes, links],
  );
  if (routes.length === 0) return null;
  const topics = [...new Set(routes.flatMap((r) => (r.topic ? [r.topic] : [])))];
  const focused = graph.nodes.find((n) => n.id === focus) ?? null;

  const find = async () => {
    if (!ctx || !selected) return;
    setLinks({ kind: "loading" });
    const result = await commands.servicesOnTopics(
      ctx,
      selected.clusterArn,
      topics,
      selected.serviceName,
    );
    setLinks(
      result.status === "ok"
        ? { kind: "done", links: result.data }
        : { kind: "error", error: result.error },
    );
  };

  return (
    <OverviewCard
      title="Routes"
      count={routes.length}
      action={
        <Button
          variant="outline"
          size="xs"
          disabled={links.kind === "loading"}
          tooltip="Look through the cluster's services for routes on the same topics"
          onClick={() => void find()}
        >
          {links.kind === "loading" ? <Loader2Icon className="animate-spin" /> : <NetworkIcon />}
          Find connected services
        </Button>
      }
    >
      {links.kind === "error" && (
        <p className="mb-2 text-xs text-destructive">{links.error.message}</p>
      )}
      {links.kind === "done" && links.links.length === 0 && (
        <p className="mb-2 text-xs text-muted-foreground">
          No other service of the cluster uses these topics.
        </p>
      )}
      {graph.ownGroup && (
        <p className="mb-2 text-xs text-muted-foreground">
          Reads its topics as consumer group{" "}
          <span className="font-mono text-foreground">{graph.ownGroup}</span>
        </p>
      )}
      <GraphView graph={graph} focus={focus} onFocus={(id) => setFocus(focus === id ? null : id)} />
      {focused ? (
        <NodeDetails node={focused} graph={graph} routes={routes} onClose={() => setFocus(null)} />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          Click a topic or system for its settings.
        </p>
      )}
    </OverviewCard>
  );
}

interface Path {
  id: string;
  d: string;
}

/**
 * The three columns of nodes as HTML, and the lines between them as an SVG drawn over them. The
 * lines are measured from the rendered nodes after layout (and again when the card resizes), so
 * the nodes can be ordinary, wrapping, accessible buttons.
 */
function GraphView({
  graph,
  focus,
  onFocus,
}: {
  graph: RouteGraph;
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
  const columns = ([0, 1, 2, 3, 4] as const)
    .map((column) => ({ column, nodes: graph.nodes.filter((n) => n.column === column) }))
    .filter((c) => c.nodes.length > 0);

  return (
    <div
      ref={container}
      role="group"
      aria-label="Route graph"
      className={cn("relative grid py-1", columns.length > 3 ? "gap-x-8" : "gap-x-12")}
      style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
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
              strokeWidth={lit ? 2 : 1.5}
              strokeDasharray={edge.disabled ? "4 4" : undefined}
              className={cn(
                "transition-[opacity,stroke] duration-150",
                lit ? "stroke-primary" : "stroke-muted-foreground/45",
                active && !lit && "opacity-25",
              )}
            />
          );
        })}
      </svg>
      {columns.map(({ column, nodes }) => (
        <div key={column} className="flex min-w-0 flex-col">
          <h4 className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {COLUMN_TITLES[column]}
          </h4>
          <div className="flex flex-1 flex-col justify-center gap-2">
            {nodes.map((node) => (
              <GraphNode
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

function GraphNode({
  node,
  ref,
  selected,
  dimmed,
  onClick,
  onHover,
}: {
  node: RouteNode;
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
      aria-label={`${node.kind} ${node.label}${node.disabled ? " (disabled)" : ""}`}
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
        node.kind === "service" ? "border-dashed border-border" : "border-border",
        node.disabled && "border-dashed opacity-60",
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
        {(node.detail ?? node.disabled) && (
          <span className="truncate text-[11px] text-muted-foreground">
            {node.detail}
            {node.disabled && <span className="text-warning"> disabled</span>}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * The settings of this service's routes through the selected node. Another service, or a system
 * only another service uses, links to that service instead (its settings are in its overview).
 */
function NodeDetails({
  node,
  graph,
  routes,
  onClose,
}: {
  node: RouteNode;
  graph: RouteGraph;
  routes: Route[];
  onClose: () => void;
}) {
  const selected = useEcs((s) => s.selected);
  const openService = useEcs((s) => s.openService);
  const through = routes.filter((r) => node.routes.includes(r.index));
  const own = node.kind !== "service" && node.column >= 1 && node.column <= 3;
  // The other services this node belongs to: itself, or the services next to it.
  const services =
    node.kind === "service"
      ? [node]
      : graph.edges
          .flatMap((e) => (e.from === node.id ? [e.to] : e.to === node.id ? [e.from] : []))
          .map((id) => graph.nodes.find((n) => n.id === id))
          .filter((n): n is RouteNode => n?.kind === "service");
  return (
    <section
      aria-label="Route details"
      className="mt-3 space-y-2 rounded-md border border-border bg-muted/30 p-3 text-xs"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">{node.label}</span>
        {own && (
          <span className="text-muted-foreground">
            {through.length} {through.length === 1 ? "route" : "routes"}
          </span>
        )}
        {!own &&
          selected &&
          services.map((service) => (
            <Button
              key={service.id}
              variant="outline"
              size="xs"
              onClick={() =>
                void openService({ clusterArn: selected.clusterArn, serviceName: service.label })
              }
            >
              <SquareArrowOutUpRightIcon /> Open {service.label}
            </Button>
          ))}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close route details"
          className="ml-auto"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      {!own && (
        <p className="text-muted-foreground">
          {node.kind === "service"
            ? `${node.detail ? `Reads as ${node.detail}. ` : ""}Its routes and settings are in its own overview.`
            : `Used by ${services.map((s) => s.label).join(", ")}: the settings are in that service's overview.`}
        </p>
      )}
      {own && node.kind === "system" && <SystemDetails node={node} routes={through} />}
      {own &&
        node.kind === "topic" &&
        through.map((route) => <RouteDetails key={route.index} route={route} />)}
    </section>
  );
}

/** The same property on every endpoint: same value, or the same secret. */
const sameProperty = (a: RouteProperty, b: RouteProperty) =>
  a.value === b.value && a.valueFrom === b.valueFrom;

/**
 * A system several routes use: what they share once (the connection, usually), then per route
 * its topic and what differs (a queue, a path).
 */
function SystemDetails({ node, routes }: { node: RouteNode; routes: Route[] }) {
  // The endpoints this node stands for: inputs or outputs of that type and system.
  const uses = routes.flatMap((route) =>
    (node.column === 0 ? (route.input ? [route.input] : []) : route.outputs)
      .filter(
        (e) =>
          (e.system ?? e.kind ?? "?") === node.label && (e.system ? e.kind : null) === node.detail,
      )
      .map((endpoint) => ({ route, endpoint })),
  );
  const first = uses[0]?.endpoint;
  if (!first) return null;
  const shared = first.properties.filter((p) =>
    uses.every(({ endpoint }) =>
      endpoint.properties.some((q) => q.key === p.key && sameProperty(p, q)),
    ),
  );
  const sharedKeys = new Set(shared.map((p) => p.key));

  return (
    <div className="space-y-3">
      {shared.length > 0 && (
        <section aria-label="Shared settings">
          <h5 className="mb-1 font-medium text-muted-foreground">
            {uses.length > 1 ? `Shared by all ${uses.length} routes` : "Settings"}
          </h5>
          <Properties properties={shared} />
        </section>
      )}
      <table aria-label="Routes to this system" className="w-full text-left">
        <thead className="text-[11px] text-muted-foreground">
          <tr>
            <th className="pr-3 pb-1 font-medium">Topic</th>
            <th className="pb-1 font-medium">{uses.length > 1 ? "Differs per route" : ""}</th>
          </tr>
        </thead>
        <tbody>
          {uses.map(({ route, endpoint }, i) => {
            const own = endpoint.properties.filter((p) => !sharedKeys.has(p.key));
            return (
              <tr
                key={`${route.index}-${i}`}
                className={cn(
                  "border-t border-border/60 align-top",
                  (!route.enabled || !endpoint.enabled) && "opacity-60",
                )}
              >
                <td className="py-1 pr-3 font-mono font-medium">
                  {route.topic ?? "—"}
                  {!route.enabled && <span className="ml-1 text-warning">route disabled</span>}
                  {route.enabled && !endpoint.enabled && (
                    <span className="ml-1 text-warning">disabled</span>
                  )}
                </td>
                <td className="py-1">{own.length > 0 && <Properties properties={own} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One route: its topic, each endpoint's type and properties, and its own settings. */
function RouteDetails({ route }: { route: Route }) {
  const settings: RouteProperty[] = route.settings;
  return (
    <div
      role="group"
      aria-label={`Route ${route.index}`}
      className={cn("rounded border border-border/60 bg-card p-2", !route.enabled && "opacity-60")}
    >
      <h4 className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">Route {route.index}</span>
        <span className="font-mono font-medium">{route.topic ?? "—"}</span>
        {route.group && <span className="text-muted-foreground">group {route.group}</span>}
        {!route.enabled && <span className="text-warning">route disabled</span>}
      </h4>
      <div className="grid gap-3 md:grid-cols-2">
        {route.input && <EndpointDetails title="Input" endpoint={route.input} />}
        {route.outputs.map((endpoint, i) => (
          <EndpointDetails
            key={i}
            title={route.outputs.length > 1 ? `Output ${i + 1}` : "Output"}
            endpoint={endpoint}
          />
        ))}
        {settings.length > 0 && (
          <section aria-label="Route settings">
            <h5 className="mb-1 font-medium text-muted-foreground">Route settings</h5>
            <Properties properties={settings} />
          </section>
        )}
      </div>
    </div>
  );
}

function EndpointDetails({ title, endpoint }: { title: string; endpoint: Endpoint }) {
  return (
    <section aria-label={title} className={cn(!endpoint.enabled && "opacity-60")}>
      <h5 className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-muted-foreground">{title}</span>
        {endpoint.kind && (
          <Badge variant="outline" className="font-mono">
            {endpoint.kind}
          </Badge>
        )}
        {endpoint.system && <span className="font-medium">{endpoint.system}</span>}
        {!endpoint.enabled && <span className="text-warning">disabled</span>}
      </h5>
      {endpoint.properties.length > 0 && <Properties properties={endpoint.properties} />}
    </section>
  );
}

/**
 * Settings as key/value pairs: credential-looking values masked like in the environment list,
 * values from Secrets Manager or SSM as their reference with Reveal.
 */
function Properties({ properties }: { properties: RouteProperty[] }) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
      {properties.map((p) => (
        <div key={p.variable} className="contents">
          <dt className="text-muted-foreground">{p.key}</dt>
          <dd className="min-w-0 break-all">
            {p.valueFrom ? (
              <SecretValue valueFrom={p.valueFrom} />
            ) : (
              <Value name={p.variable} value={p.value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
