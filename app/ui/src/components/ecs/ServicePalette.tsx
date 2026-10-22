import { useEffect, useState } from "react";
import { HistoryIcon, Loader2Icon, StarIcon } from "lucide-react";
import type { ServiceKey } from "@/bindings";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { nameFromArn } from "@/lib/ecs";
import { openServiceKey } from "@/lib/navigation";
import { matchWords } from "@/lib/search";
import { useEcs } from "@/stores/ecs";
import { isSameService, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";
import { HealthDot } from "./HealthDot";

/**
 * ⌘K / Ctrl+K: jump to any service of the current profile (all clusters), or to a recently
 * opened one of any profile.
 */
export function ServicePalette() {
  const [open, setOpen] = useState(false);
  const profile = useProfiles((s) => s.selected);
  const clusters = useEcs((s) => s.clusters);
  const services = useEcs((s) => s.services);
  const loadAllServices = useEcs((s) => s.loadAllServices);
  const recent = usePrefs((s) => s.prefs.recent);
  const favorites = usePrefs((s) => s.prefs.favorites);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((wasOpen) => !wasOpen);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Services of collapsed clusters aren't loaded yet; the palette needs all of them.
  useEffect(() => {
    if (open) void loadAllServices();
  }, [open, loadAllServices, clusters]);

  function go(key: ServiceKey) {
    setOpen(false);
    void openServiceKey(key);
  }

  const clusterList = "data" in clusters ? (clusters.data ?? []) : [];
  const loading = Object.values(services).some((s) => s.state === "loading");

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Go to service"
      description="Search services of this profile and recently opened ones"
      filter={matchWords}
    >
      <CommandInput placeholder="Go to service…" />
      <CommandList>
        <CommandEmpty>No service found.</CommandEmpty>
        {recent.length > 0 && (
          <CommandGroup heading="Recent">
            {recent.map((key) => (
              <CommandItem
                key={`recent:${key.profile}:${key.clusterArn}:${key.serviceName}`}
                value={`recent:${key.profile}:${key.clusterArn}:${key.serviceName}`}
                keywords={[key.serviceName, nameFromArn(key.clusterArn), key.profile]}
                onSelect={() => go(key)}
              >
                <HistoryIcon className="text-muted-foreground" />
                <span className="truncate">{key.serviceName}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {nameFromArn(key.clusterArn)}
                </span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {key.profile} · {key.region}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {profile && (
          <CommandGroup heading={`Services · ${profile}`}>
            {clusterList.flatMap((cluster) => {
              const list = services[cluster.arn];
              if (!list || !("data" in list) || !list.data) return [];
              return list.data.map((service) => {
                const ref = { clusterArn: cluster.arn, serviceName: service.name };
                // `arn:aws:ecs:<region>:…`: the service's own region, like ServiceKey::new.
                const region = cluster.arn.split(":")[3] ?? "";
                const pinned = favorites.some((f) => isSameService(f, profile, ref));
                return (
                  <CommandItem
                    key={service.arn}
                    value={service.arn}
                    keywords={[service.name, cluster.name]}
                    onSelect={() => go({ profile, region, ...ref })}
                  >
                    <HealthDot service={service} />
                    <span className="truncate">{service.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{cluster.name}</span>
                    {pinned && <StarIcon className="fill-amber-400 text-amber-400" />}
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {service.running}/{service.desired}
                    </span>
                  </CommandItem>
                );
              });
            })}
            {loading && (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Loader2Icon className="size-3 animate-spin" /> Loading services…
              </div>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
