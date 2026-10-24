import { useEffect, useMemo, useState } from "react";
import { Loader2Icon, NetworkIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
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
import { buildRouteGraph, type RouteGraph, type RouteNode } from "@/lib/routes";
import { useEcs } from "@/stores/ecs";
import { SecretValue, Value } from "./Environment";
import { OverviewCard } from "./OverviewCard";
import { GraphView } from "./RouteGraphView";

/** The same in every service's graph; the service shown is in "Written by" or "Read by". */
const COLUMN_TITLES = ["Sources", "Written by", "Topics", "Read by", "Targets"] as const;
const columnTitle = (column: number) => COLUMN_TITLES[column] ?? null;

/**
 * The routes of a routing-framework service (rebuilt from its environment in Rust), drawn as a
 * graph around its topics: the systems and services writing them, the services and systems
 * reading them, each system once. The service itself is selected at first, so its paths stand
 * out; on request the other services on its topics join in. That scan is kept for the session
 * (in Rust, per cluster), so the next service through the graph shows them right away. A click on
 * a topic or one of its systems shows the settings.
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
  const self = selected?.serviceName ?? "";
  // `undefined` until the user picks a node: then the service itself is selected.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const graph = useMemo(
    () => buildRouteGraph(self, routes, links.kind === "done" ? links.links : []),
    [self, routes, links],
  );
  const topics = useMemo(
    () => [...new Set(routes.flatMap((r) => (r.topic ? [r.topic] : [])))],
    [routes],
  );

  // The cluster's last scan, if there was one: no AWS call.
  useEffect(() => {
    if (!ctx || !selected || topics.length === 0) return;
    let current = true;
    void commands
      .servicesOnTopics(ctx, selected.clusterArn, topics, selected.serviceName, "cached")
      .then((result) => {
        if (!current || result.status === "error") return;
        const cached = result.data;
        // A scan started meanwhile has the newer answer.
        setLinks((links) =>
          links.kind === "loading"
            ? links
            : cached
              ? { kind: "done", links: cached }
              : { kind: "idle" },
        );
      });
    return () => {
      current = false;
    };
  }, [ctx, selected, topics]);

  if (routes.length === 0) return null;
  const focus = picked === undefined ? graph.selfId : picked;
  const focused = graph.nodes.find((n) => n.id === focus) ?? null;

  const find = async () => {
    if (!ctx || !selected) return;
    setLinks({ kind: "loading" });
    const result = await commands.servicesOnTopics(
      ctx,
      selected.clusterArn,
      topics,
      selected.serviceName,
      "fresh",
    );
    setLinks(
      result.status === "ok"
        ? { kind: "done", links: result.data ?? [] }
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
          tooltip={
            links.kind === "done"
              ? "Look through the cluster's services again (they're kept for the session)"
              : "Look through the cluster's services for routes on the same topics"
          }
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
      <p className="mb-2 text-xs text-muted-foreground">
        {graph.direction === "in" ? (
          <>
            <span className="font-medium text-foreground">Input service</span>: reads external
            systems and writes Kafka topics.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">Output service</span>: reads Kafka topics
            {graph.ownGroup && (
              <>
                {" "}
                as consumer group{" "}
                <span className="font-mono text-foreground">{graph.ownGroup}</span>
              </>
            )}{" "}
            and writes to external systems.
          </>
        )}
      </p>
      <GraphView
        graph={graph}
        columnTitle={columnTitle}
        focus={focus}
        onFocus={(id) => setPicked(focus === id ? null : id)}
      />
      {focused && !focused.self ? (
        <NodeDetails node={focused} graph={graph} routes={routes} onClose={() => setPicked(null)} />
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {focused?.self
            ? `${self}'s paths are highlighted; click it again to show all evenly. `
            : ""}
          Click a topic or system for its settings.
        </p>
      )}
    </OverviewCard>
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
  // This service's topic or one of its systems: their settings are shown here.
  const own =
    node.kind === "topic" ||
    (node.kind === "system" &&
      graph.edges.some(
        (e) =>
          (e.from === node.id && e.to === graph.selfId) ||
          (e.to === node.id && e.from === graph.selfId),
      ));
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
