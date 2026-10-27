import { useEffect, useState } from "react";
import { BookmarkIcon, HistoryIcon, StarIcon } from "lucide-react";
import { cn } from "cn";
import type { SavedSearch, ServiceKey } from "@/bindings";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { nameFromArn } from "@/lib/ecs";
import { openServiceKey } from "@/lib/navigation";
import { matchWords } from "@/lib/search";
import { useEcs } from "@/stores/ecs";
import { isSameService, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";
import { useTabs } from "@/stores/tabs";
import { HealthDot } from "./HealthDot";

/**
 * Runs a saved search: one saved for a service opens that service first; one for all services
 * runs in the service tab shown (if any). Either way the Logs tab is shown with the search set.
 */
async function runSavedSearch(saved: SavedSearch) {
  if (saved.service) await openServiceKey(saved.service);
  const service = useEcs.getState().selected;
  if (!service) return;
  // The tab of the service (the app opens it too, a moment later; activating twice is harmless).
  useTabs.getState().activate(service);
  const tabs = useTabs.getState();
  const tab = tabs.tabs.find((t) => t.key === tabs.activeKey);
  if (tab?.kind !== "service") return;
  const logs = tab.logs.getState();
  logs.setTab("logs");
  await logs.setSearch({
    query: saved.search.query,
    regex: saved.search.regex,
    raw: saved.search.raw,
  });
}

/**
 * ⌘K / Ctrl+K: jump to any service of the current profile (all clusters), or to a recently
 * opened one of any profile, or run a saved search.
 */
export function ServicePalette() {
  const [open, setOpen] = useState(false);
  const profile = useProfiles((s) => s.selected);
  const clusters = useEcs((s) => s.clusters);
  const services = useEcs((s) => s.services);
  const loadAllServices = useEcs((s) => s.loadAllServices);
  const recent = usePrefs((s) => s.prefs.recent);
  const favorites = usePrefs((s) => s.prefs.favorites);
  const savedSearches = usePrefs((s) => s.prefs.savedSearches);
  // A search for all services needs a service tab to run in.
  const inService = useTabs((s) => s.tabs.find((t) => t.key === s.activeKey)?.kind === "service");
  const runnable = savedSearches.filter((s) => s.service !== null || inService);

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
      description="Search services of this profile, recently opened ones and saved searches"
      filter={matchWords}
    >
      <CommandInput placeholder="Go to service…" />
      <CommandList>
        <CommandEmpty>No service found.</CommandEmpty>
        {runnable.length > 0 && (
          <CommandGroup heading="Saved searches">
            {runnable.map((saved) => {
              const id = `search:${saved.name}:${saved.service?.profile ?? ""}:${saved.service?.clusterArn ?? ""}:${saved.service?.serviceName ?? "*"}`;
              return (
                <CommandItem
                  key={id}
                  value={id}
                  keywords={[saved.name, saved.search.query, saved.service?.serviceName ?? "all"]}
                  onSelect={() => {
                    setOpen(false);
                    void runSavedSearch(saved);
                  }}
                >
                  <BookmarkIcon className="text-muted-foreground" />
                  <span className="truncate">{saved.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {saved.search.query}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {saved.service ? saved.service.serviceName : "this service"}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
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
              <div
                role="status"
                aria-label="Loading services"
                className="flex flex-col gap-2.5 px-2 py-2"
              >
                {["w-2/3", "w-1/2", "w-3/5"].map((width) => (
                  <Skeleton key={width} className={cn("h-4", width)} />
                ))}
              </div>
            )}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
