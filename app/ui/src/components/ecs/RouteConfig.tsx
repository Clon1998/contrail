import { ArrowRightIcon, LockIcon } from "lucide-react";
import { cn } from "cn";
import type { RouteProperty } from "@/bindings";
import { Badge } from "@/components/ui/badge";
import type { ClusterNode, EndpointConfig } from "@/lib/clusterGraph";
import { looksSecret } from "@/lib/ecs";

/** A secret's value never reaches the map: it is shown as such, without a way to reveal it. */
function isMasked(p: RouteProperty) {
  return p.valueFrom !== null || looksSecret(p.variable);
}

/** The consumer group all of `config` share, if they do (an output service has one). */
function sharedGroup(config: EndpointConfig[]): string | null {
  const groups = new Set(config.map((c) => c.group));
  const [only] = groups;
  return groups.size === 1 ? (only ?? null) : null;
}

/**
 * The route ends at a node of the route map with their settings, one block per route: for a
 * service its own routes, for a system the routes of every service using it. Each block's title
 * runs in the direction the data flows (`system → topic` into Kafka, `topic → system` out of it).
 * `compact` (the hover card) leaves out the settings of switched-off routes.
 */
export function ConfigList({
  config,
  node,
  compact = false,
}: {
  config: EndpointConfig[];
  node: ClusterNode;
  compact?: boolean;
}) {
  const group = node.kind === "service" ? sharedGroup(config) : null;
  return (
    <div className="flex flex-col gap-2 text-xs">
      {compact && (
        <header className="flex items-baseline gap-2">
          <span className="font-medium">{node.label}</span>
          <span className="text-muted-foreground">
            {node.detail}
            {group && ` · group ${group}`}
          </span>
        </header>
      )}
      <ul aria-label={`Routes of ${node.label}`} className="flex flex-col gap-1.5">
        {config.map((c, i) => (
          <li
            key={i}
            className={cn(
              "rounded-md border border-border bg-muted/40 px-2 py-1.5",
              !c.enabled && "opacity-60",
            )}
          >
            <RouteTitle config={c} node={node} showGroup={group === null} />
            {c.properties.length > 0 && !(compact && !c.enabled) && (
              <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-[11px]">
                {c.properties.map((p) => (
                  <div key={p.variable} className="contents">
                    <dt className="text-muted-foreground">{p.key}</dt>
                    <dd className="min-w-0 break-all">
                      {isMasked(p) ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <LockIcon className="size-3" /> secret
                        </span>
                      ) : (
                        p.value
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One route's ends in the direction the data flows, with the system's type and its state. */
function RouteTitle({
  config: c,
  node,
  showGroup,
}: {
  config: EndpointConfig;
  node: ClusterNode;
  showGroup: boolean;
}) {
  const topic = <span className="font-mono">{c.topic}</span>;
  // On a system's card the other end is the service; on a service's card it is the system.
  const other =
    node.kind === "system" ? (
      <span className="font-medium">{c.service}</span>
    ) : (
      <span className="font-medium">{c.system ?? c.kind ?? "?"}</span>
    );
  const [from, to] = c.side === "source" ? [other, topic] : [topic, other];
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {from}
      <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" />
      {to}
      {node.kind === "service" && c.kind && (
        <Badge variant="outline" className="px-1 py-0 font-mono text-[10px]">
          {c.kind}
        </Badge>
      )}
      {showGroup && c.group && <span className="text-muted-foreground">group {c.group}</span>}
      {!c.enabled && (
        <Badge variant="outline" className="border-warning/50 px-1 py-0 text-[10px] text-warning">
          disabled
        </Badge>
      )}
    </p>
  );
}
