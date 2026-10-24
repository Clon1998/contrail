import { useEffect, type ReactNode } from "react";
import { NetworkIcon, RouteIcon, XIcon } from "lucide-react";
import { useStore } from "zustand";
import { cn } from "cn";
import { useAutoPause } from "@/hooks/useAutoPause";
import { nameFromArn } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";
import { LogsContext, useLogs } from "@/stores/logs";
import { useTabs, type RoutesTab, type ServiceTab, type Tab, type TraceTab } from "@/stores/tabs";

/** Shows a tab: a service tab also selects its service (the sidebar follows it). */
function show(tab: Tab) {
  if (tab.kind !== "service") {
    useTabs.getState().show(tab.key);
    return;
  }
  useTabs.getState().activate(tab.service);
  void useEcs.getState().openService(tab.service);
}

/** Closes a tab and shows its neighbour (or nothing). */
function closeTab(key: string) {
  const wasActive = useTabs.getState().activeKey === key;
  const next = useTabs.getState().close(key);
  if (!wasActive) return;
  if (next) show(next);
  else useEcs.getState().closeService();
}

const DOT: Record<string, string> = {
  live: "bg-success",
  polling: "bg-warning",
  reconnecting: "bg-warning",
  failed: "bg-destructive",
};

/** A service's tab; also auto-pauses its live tail while it's in the background. */
function ServiceTabItem({ tab, active }: { tab: ServiceTab; active: boolean }) {
  const state = useLogs((s) => s.live?.state);
  useAutoPause(active);
  return (
    <TabShell
      tab={tab}
      active={active}
      label={tab.service.serviceName}
      title={`${tab.service.serviceName} · ${nameFromArn(tab.service.clusterArn)}`}
      icon={
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            DOT[state ?? ""] ?? "bg-muted-foreground/40",
          )}
        />
      }
    />
  );
}

/** A trace's tab: the ID it follows. */
function TraceTabItem({ tab, active }: { tab: TraceTab; active: boolean }) {
  const request = useStore(tab.trace, (s) => s.request);
  return (
    <TabShell
      tab={tab}
      active={active}
      label={`Trace ${request.id}`}
      title={`Trace ${request.id} · from ${request.origin}`}
      icon={<RouteIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
    />
  );
}

/** A cluster's route map. */
function RoutesTabItem({ tab, active }: { tab: RoutesTab; active: boolean }) {
  const cluster = nameFromArn(tab.clusterArn);
  return (
    <TabShell
      tab={tab}
      active={active}
      label={`Routes ${cluster}`}
      title={`Route map of ${cluster}`}
      icon={<NetworkIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />}
    />
  );
}

/** The look and behaviour every tab shares: click shows it, middle click or × closes it. */
function TabShell({
  tab,
  active,
  label,
  title,
  icon,
}: {
  tab: Tab;
  active: boolean;
  label: string;
  title: string;
  icon: ReactNode;
}) {
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={label}
      title={title}
      tabIndex={active ? 0 : -1}
      onClick={() => show(tab)}
      // Middle click closes (on mousedown: WebKit sends no auxclick, and it stops autoscroll).
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          closeTab(tab.key);
        }
      }}
      onKeyDown={(e) => e.key === "Enter" && show(tab)}
      className={cn(
        "group flex max-w-48 shrink-0 cursor-default items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs",
        active
          ? "bg-background text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={(e) => {
          e.stopPropagation();
          closeTab(tab.key);
        }}
        className={cn(
          "rounded p-0.5 hover:bg-accent hover:text-foreground",
          !active && "opacity-0 group-hover:opacity-100",
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}

/** The open services. Ctrl/⌘+1…9 shows a tab, Ctrl+Tab / Ctrl+Shift+Tab cycles. */
export function ServiceTabs() {
  const tabs = useTabs((s) => s.tabs);
  const activeKey = useTabs((s) => s.activeKey);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const { tabs, activeKey } = useTabs.getState();
      if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        const tab = event.key === "9" ? tabs.at(-1) : tabs[Number(event.key) - 1];
        if (tab) {
          event.preventDefault();
          show(tab);
        }
      } else if (event.ctrlKey && event.key === "Tab" && tabs.length > 1) {
        event.preventDefault();
        const index = tabs.findIndex((t) => t.key === activeKey);
        const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length];
        if (next) show(next);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Open tabs"
      className="flex overflow-x-auto border-b border-border bg-muted/30"
    >
      {tabs.map((tab) =>
        tab.kind === "service" ? (
          <LogsContext.Provider key={tab.key} value={tab.logs}>
            <ServiceTabItem tab={tab} active={tab.key === activeKey} />
          </LogsContext.Provider>
        ) : tab.kind === "trace" ? (
          <TraceTabItem key={tab.key} tab={tab} active={tab.key === activeKey} />
        ) : (
          <RoutesTabItem key={tab.key} tab={tab} active={tab.key === activeKey} />
        ),
      )}
    </div>
  );
}
