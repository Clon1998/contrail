import { ChevronRightIcon, Loader2Icon, RefreshCwIcon, StarIcon } from "lucide-react";
import { cn } from "cn";
import type { ServiceRef } from "@/bindings";
import { Button } from "@/components/ui/button";
import { nameFromArn } from "@/lib/ecs";
import { openServiceKey } from "@/lib/navigation";
import { sameService, useEcs } from "@/stores/ecs";
import { usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";
import { HealthDot } from "./HealthDot";

/** Favorites of the selected profile and the Cluster → Service tree. */
export function Sidebar() {
  const profile = useProfiles((s) => s.selected);
  // Select the stored array (stable between renders) and filter here: a selector returning a
  // new array each time would make zustand re-render endlessly.
  const allFavorites = usePrefs((s) => s.prefs.favorites);
  const favorites = allFavorites.filter((f) => f.profile === profile);
  const clusters = useEcs((s) => s.clusters);
  const ctx = useEcs((s) => s.ctx);
  const activate = useEcs((s) => s.activate);
  const reset = useEcs((s) => s.reset);

  return (
    <aside
      aria-label="Clusters and services"
      className="flex w-72 shrink-0 flex-col overflow-y-auto border-r border-border text-sm"
    >
      {favorites.length > 0 && (
        <section aria-label="Favorites" className="border-b border-border py-2">
          <h2 className="px-3 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            Favorites
          </h2>
          {favorites.map((key) => (
            <button
              key={`${key.clusterArn}/${key.serviceName}`}
              type="button"
              onClick={() => void openServiceKey(key)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent"
            >
              <StarIcon className="size-3 shrink-0 fill-amber-400 text-amber-400" />
              <span className="truncate">{key.serviceName}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">
                {nameFromArn(key.clusterArn)}
              </span>
            </button>
          ))}
        </section>
      )}

      <div className="flex items-center justify-between px-3 pt-2 pb-1">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Clusters
        </h2>
        {ctx && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Reload clusters"
            onClick={() => {
              reset();
              void activate(ctx);
            }}
          >
            <RefreshCwIcon className={clusters.state === "loading" ? "animate-spin" : undefined} />
          </Button>
        )}
      </div>

      {clusters.state === "loading" && !clusters.data && (
        <p className="flex items-center gap-2 px-3 py-1 text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> Loading clusters…
        </p>
      )}
      {clusters.state === "error" && (
        <p className="px-3 py-1 text-xs text-destructive">{clusters.error.message}</p>
      )}
      {"data" in clusters && clusters.data?.length === 0 && (
        <p className="px-3 py-1 text-muted-foreground">No clusters in this region.</p>
      )}
      <ul role="tree" aria-label="Clusters" className="pb-2">
        {"data" in clusters &&
          clusters.data?.map((cluster) => <ClusterNode key={cluster.arn} arn={cluster.arn} />)}
      </ul>
    </aside>
  );
}

function ClusterNode({ arn }: { arn: string }) {
  const cluster = useEcs((s) =>
    "data" in s.clusters ? s.clusters.data?.find((c) => c.arn === arn) : undefined,
  );
  const expanded = useEcs((s) => s.expanded[arn] ?? false);
  const services = useEcs((s) => s.services[arn]);
  const toggle = useEcs((s) => s.toggleCluster);
  if (!cluster) return null;

  return (
    <li role="treeitem" aria-expanded={expanded} aria-label={cluster.name}>
      <button
        type="button"
        onClick={() => void toggle(arn)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left hover:bg-accent"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
        <span className="truncate font-medium">{cluster.name}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {cluster.activeServices} svc · {cluster.runningTasks} tasks
        </span>
      </button>
      {expanded && (
        <ul role="group">
          {services?.state === "loading" && !services.data && (
            <li className="flex items-center gap-2 py-1 pl-8 text-xs text-muted-foreground">
              <Loader2Icon className="size-3 animate-spin" /> Loading…
            </li>
          )}
          {services?.state === "error" && (
            <li className="py-1 pr-2 pl-8 text-xs text-destructive">{services.error.message}</li>
          )}
          {services && "data" in services && services.data?.length === 0 && (
            <li className="py-1 pl-8 text-xs text-muted-foreground">No services</li>
          )}
          {services &&
            "data" in services &&
            services.data?.map((service) => (
              <ServiceNode
                key={service.arn}
                service={{ clusterArn: arn, serviceName: service.name }}
                counts={service}
              />
            ))}
        </ul>
      )}
    </li>
  );
}

function ServiceNode({
  service,
  counts,
}: {
  service: ServiceRef;
  counts: { desired: number; running: number; pending: number };
}) {
  const selected = useEcs((s) => sameService(s.selected, service));
  const open = useEcs((s) => s.openService);

  return (
    <li role="treeitem" aria-selected={selected} aria-label={service.serviceName}>
      <button
        type="button"
        onClick={() => void open(service)}
        className={cn(
          "flex w-full items-center gap-2 py-1 pr-2 pl-8 text-left hover:bg-accent",
          selected && "bg-accent text-accent-foreground",
        )}
      >
        <HealthDot service={counts} />
        <span className="truncate">{service.serviceName}</span>
        <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
          {counts.running}/{counts.desired}
        </span>
      </button>
    </li>
  );
}
