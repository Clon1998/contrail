import { useEffect } from "react";
import { CircleAlertIcon, Loader2Icon, RefreshCwIcon, StarIcon } from "lucide-react";
import { LogViewer } from "@/components/logs/LogViewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { nameFromArn } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";
import { LogsContext, useLogs } from "@/stores/logs";
import { isSameService, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";
import { tabKey, useTabs } from "@/stores/tabs";
import { HealthDot } from "./HealthDot";
import { Overview } from "./Overview";
import { ServiceTabs } from "./ServiceTabs";

/** The open service is refreshed this often (only while it is shown). */
const REFRESH_MS = 30_000;

/** The selected service, inside the logs store of its tab. */
export function ServiceView() {
  const selected = useEcs((s) => s.selected);
  const tab = useTabs((s) => s.tabs.find((t) => t.key === s.activeKey));
  // Right after selecting another service its tab is activated (an effect in App): wait for it.
  const ready = selected && tab && tab.key === tabKey(selected);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <ServiceTabs />
      {ready && (
        <LogsContext.Provider value={tab.logs}>
          <ServicePane key={tab.key} />
        </LogsContext.Provider>
      )}
    </div>
  );
}

function ServicePane() {
  const selected = useEcs((s) => s.selected);
  const detail = useEcs((s) => s.detail);
  const refresh = useEcs((s) => s.refreshService);
  const tab = useLogs((s) => s.tab);
  const setTab = useLogs((s) => s.setTab);

  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh, selected]);

  if (!selected) return null;
  const data = "data" in detail ? detail.data : undefined;

  return (
    <main
      aria-label={`Service ${selected.serviceName}`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <Header />
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value === "logs" ? "logs" : "overview")}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList className="mx-4 mt-2">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="min-h-0 overflow-y-auto">
          {detail.state === "error" && (
            <p className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 p-2 text-sm text-destructive">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {detail.error.message}
                {detail.error.hint && (
                  <span className="block text-muted-foreground">{detail.error.hint}</span>
                )}
              </span>
            </p>
          )}
          {!data && detail.state === "loading" && (
            <p className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" /> Loading service…
            </p>
          )}
          {data && <Overview detail={data} />}
        </TabsContent>
        <TabsContent value="logs" className="flex min-h-0 flex-col">
          <LogViewer />
        </TabsContent>
      </Tabs>
    </main>
  );
}

function Header() {
  const selected = useEcs((s) => s.selected);
  const detail = useEcs((s) => s.detail);
  const refresh = useEcs((s) => s.refreshService);
  const profile = useProfiles((s) => s.selected);
  const favorites = usePrefs((s) => s.prefs.favorites);
  const toggleFavorite = usePrefs((s) => s.toggleFavorite);
  if (!selected || !profile) return null;

  const summary = "data" in detail ? detail.data?.summary : undefined;
  const pinned = favorites.some((f) => isSameService(f, profile, selected));

  return (
    <header className="flex items-center gap-2 border-b border-border px-4 py-2">
      {summary && <HealthDot service={summary} />}
      <h1 className="truncate text-base font-semibold">{selected.serviceName}</h1>
      <span className="truncate text-sm text-muted-foreground">
        {nameFromArn(selected.clusterArn)}
      </span>
      {summary && (
        <span className="ml-1 text-xs text-muted-foreground tabular-nums">
          {summary.running} of {summary.desired} running
          {summary.pending > 0 && (
            <span className="text-warning"> · {summary.pending} pending</span>
          )}
        </span>
      )}
      {summary && summary.status !== "ACTIVE" && <Badge variant="outline">{summary.status}</Badge>}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={pinned ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={pinned}
        onClick={() => void toggleFavorite(profile, selected)}
      >
        <StarIcon className={pinned ? "fill-amber-400 text-amber-400" : undefined} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label="Refresh service"
        onClick={() => void refresh()}
      >
        <RefreshCwIcon className={detail.state === "loading" ? "animate-spin" : undefined} />
      </Button>
    </header>
  );
}
