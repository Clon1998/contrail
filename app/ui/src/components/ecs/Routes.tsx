import { Fragment, useState } from "react";
import { ArrowRightIcon, ChevronRightIcon, Loader2Icon, NetworkIcon } from "lucide-react";
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
import { useEcs } from "@/stores/ecs";
import { SecretValue, Value } from "./Environment";
import { OverviewCard } from "./OverviewCard";

/**
 * The routes of a routing-framework service (rebuilt from its environment in Rust): one compact
 * row per route (source system → topic → target systems, and an output route's group); a click
 * shows the rest (types, properties, settings). On request, the services on the other side of
 * each topic.
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
      <ul className="divide-y divide-border rounded-md border border-border">
        {routes.map((route) => (
          <RouteRow
            key={route.index}
            route={route}
            links={
              links.kind === "done" ? links.links.filter((l) => l.topic === route.topic) : null
            }
          />
        ))}
      </ul>
    </OverviewCard>
  );
}

/** What a route's row names an endpoint by: its system, else its type. */
function endpointName(endpoint: Endpoint): string {
  return endpoint.system ?? endpoint.kind ?? "?";
}

function RouteRow({ route, links }: { route: Route; links: TopicLink[] | null }) {
  const [open, setOpen] = useState(false);
  const selected = useEcs((s) => s.selected);
  const openService = useEcs((s) => s.openService);

  return (
    <li role="group" aria-label={`Route ${route.index}`} className="text-xs">
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5",
          !route.enabled && "opacity-60",
        )}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Route ${route.index}: ${route.topic ?? "no topic"}`}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 rounded text-left hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          {route.input && (
            <>
              <EndpointName endpoint={route.input} />
              <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
            </>
          )}
          <span className="font-mono font-medium break-all">{route.topic ?? "—"}</span>
          {route.outputs.length > 0 && (
            <>
              <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                {route.outputs.map((endpoint, i) => (
                  <Fragment key={i}>
                    {i > 0 && ", "}
                    <EndpointName endpoint={endpoint} />
                  </Fragment>
                ))}
              </span>
            </>
          )}
          {!route.enabled && <span className="shrink-0 text-warning">route disabled</span>}
          {route.group && (
            <span className="ml-auto shrink-0 text-muted-foreground">group {route.group}</span>
          )}
        </button>
        {links?.map((link) => (
          <Button
            key={`${link.service}-${link.direction}`}
            variant="outline"
            size="xs"
            tooltip={
              link.direction === "in"
                ? `${link.service} writes to ${route.topic ?? "this topic"}`
                : `${link.service} reads ${route.topic ?? "this topic"}`
            }
            onClick={() =>
              selected &&
              void openService({ clusterArn: selected.clusterArn, serviceName: link.service })
            }
          >
            {link.direction === "in" ? "from" : "to"} {link.service}
          </Button>
        ))}
        {links?.length === 0 && (
          <span className="shrink-0 text-muted-foreground">no other service</span>
        )}
      </div>
      {open && <RouteDetails route={route} />}
    </li>
  );
}

function EndpointName({ endpoint }: { endpoint: Endpoint }) {
  if (endpoint.enabled) return <span className="font-medium">{endpointName(endpoint)}</span>;
  return (
    <span>
      <span className="font-medium text-muted-foreground line-through">
        {endpointName(endpoint)}
      </span>{" "}
      <span className="text-warning">disabled</span>
    </span>
  );
}

/** Everything else about a route: each endpoint's type and properties, and its own settings. */
function RouteDetails({ route }: { route: Route }) {
  const settings: RouteProperty[] = route.settings;
  return (
    <div className="grid gap-3 border-t border-border/60 bg-muted/30 px-7 py-2 md:grid-cols-2">
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
          <h4 className="mb-1 font-medium text-muted-foreground">Route settings</h4>
          <Properties properties={settings} />
        </section>
      )}
    </div>
  );
}

function EndpointDetails({ title, endpoint }: { title: string; endpoint: Endpoint }) {
  return (
    <section aria-label={title} className={cn(!endpoint.enabled && "opacity-60")}>
      <h4 className="mb-1 flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-muted-foreground">{title}</span>
        {endpoint.kind && (
          <Badge variant="outline" className="font-mono">
            {endpoint.kind}
          </Badge>
        )}
        {endpoint.system && <span className="font-medium">{endpoint.system}</span>}
        {!endpoint.enabled && <span className="text-warning">disabled</span>}
      </h4>
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
