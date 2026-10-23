import { useState } from "react";
import { ArrowRightIcon, Loader2Icon, NetworkIcon } from "lucide-react";
import { cn } from "cn";
import {
  commands,
  type ApiError,
  type ContainerDefinitionInfo,
  type Endpoint,
  type Route,
  type TopicLink,
} from "@/bindings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEcs } from "@/stores/ecs";
import { Value } from "./Environment";
import { OverviewCard } from "./OverviewCard";

/**
 * The routes of a routing-framework service (rebuilt from its environment in Rust): each route as
 * source → topic → targets, and on request the services on the other side of each topic.
 */
export function Routes({ containers }: { containers: ContainerDefinitionInfo[] }) {
  const routes = containers.flatMap((c) => c.routes?.routes ?? []);
  const ctx = useEcs((s) => s.ctx);
  const selected = useEcs((s) => s.selected);
  const [links, setLinks] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "done"; links: TopicLink[] }
    | { kind: "error"; error: ApiError }
  >({ kind: "idle" });
  if (routes.length === 0) return null;
  const topics = [...new Set(routes.flatMap((r) => (r.topic ? [r.topic] : [])))];

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
      <div className="space-y-3">
        {routes.map((route) => (
          <RouteFlow
            key={route.index}
            route={route}
            links={
              links.kind === "done" ? links.links.filter((l) => l.topic === route.topic) : null
            }
          />
        ))}
      </div>
    </OverviewCard>
  );
}

function RouteFlow({ route, links }: { route: Route; links: TopicLink[] | null }) {
  const selected = useEcs((s) => s.selected);
  const open = useEcs((s) => s.openService);
  // The other side: input services feed this topic, output services read it.
  const others = (links ?? []).map((link) => (
    <Button
      key={`${link.service}-${link.direction}`}
      variant="outline"
      size="xs"
      className="w-fit"
      onClick={() =>
        selected && void open({ clusterArn: selected.clusterArn, serviceName: link.service })
      }
    >
      {link.service}
      <span className="text-muted-foreground">{link.direction === "in" ? "input" : "output"}</span>
    </Button>
  ));
  const none = links !== null && links.length === 0 && (
    <span className="text-xs text-muted-foreground">no other service on this topic</span>
  );

  return (
    <div
      role="group"
      aria-label={`Route ${route.index}`}
      className={cn(
        "grid items-start gap-2 rounded-md border border-border p-2 md:grid-cols-[minmax(0,1fr)_auto_auto_auto_minmax(0,1fr)]",
        !route.enabled && "opacity-60",
      )}
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        {route.input ? <EndpointBox endpoint={route.input} /> : others}
        {!route.input && none}
      </div>
      <ArrowRightIcon className="mt-2 hidden size-4 text-muted-foreground md:block" />
      <div className="flex flex-col items-center gap-1 pt-1">
        <Badge variant="secondary" className="font-mono">
          {route.topic ?? "—"}
        </Badge>
        {route.group && (
          <span className="text-[11px] text-muted-foreground">group {route.group}</span>
        )}
        {!route.enabled && <span className="text-[11px] text-warning">route disabled</span>}
      </div>
      <ArrowRightIcon className="mt-2 hidden size-4 text-muted-foreground md:block" />
      <div className="flex min-w-0 flex-col gap-1.5">
        {route.outputs.length > 0
          ? route.outputs.map((endpoint, i) => <EndpointBox key={i} endpoint={endpoint} />)
          : others}
        {route.outputs.length === 0 && none}
      </div>
    </div>
  );
}

/** One source or target: its type and system, and its settings (credentials masked). */
function EndpointBox({ endpoint }: { endpoint: Endpoint }) {
  return (
    <div
      className={cn(
        "rounded border border-border/70 px-2 py-1 text-xs",
        !endpoint.enabled && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="font-mono">
          {endpoint.kind ?? "?"}
        </Badge>
        <span className="font-medium">{endpoint.system}</span>
        {!endpoint.enabled && <span className="text-warning">disabled</span>}
      </div>
      {endpoint.properties.length > 0 && (
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 font-mono text-[11px]">
          {endpoint.properties.map((p) => (
            <div key={p.variable} className="contents">
              <dt className="text-muted-foreground">{p.key}</dt>
              <dd className="min-w-0 break-all">
                <Value name={p.variable} value={p.value} />
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
