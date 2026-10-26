import { LockIcon } from "lucide-react";
import { cn } from "cn";
import type { RouteProperty } from "@/bindings";
import type { ClusterNode, EndpointConfig } from "@/lib/clusterGraph";
import { looksSecret } from "@/lib/ecs";

/** A secret's value never reaches the map: it is shown as such, without a way to reveal it. */
function isMasked(p: RouteProperty) {
  return p.valueFrom !== null || looksSecret(p.variable);
}

/**
 * The route ends at a node of the route map with their settings: for a service, its own routes
 * (topic and the system at the other end); for a system, the routes of every service using it.
 * `compact` (the hover card) leaves out switched-off routes' details.
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
  return (
    <ul aria-label={`Routes of ${node.label}`} className="flex flex-col gap-2 text-xs">
      {config.map((c, i) => (
        <li key={i} className={cn(!c.enabled && "opacity-60")}>
          <p className="flex flex-wrap items-baseline gap-x-1.5">
            {node.kind === "system" && <span className="font-medium">{c.service}</span>}
            <span className="text-muted-foreground">
              {c.side === "source" ? "writes" : "reads"}
            </span>
            <span className="font-mono">{c.topic}</span>
            {node.kind === "service" && (
              <span className="text-muted-foreground">
                {c.side === "source" ? "from" : "to"} {c.system ?? c.kind ?? "?"}
                {c.system && c.kind && ` (${c.kind})`}
              </span>
            )}
            {c.group && <span className="text-muted-foreground">· group {c.group}</span>}
            {!c.enabled && <span className="text-warning">disabled</span>}
          </p>
          {c.properties.length > 0 && !(compact && !c.enabled) && (
            <dl className="mt-0.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 font-mono text-[11px]">
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
  );
}
