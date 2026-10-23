import { useEffect } from "react";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import { useAutoPause } from "@/hooks/useAutoPause";
import { nameFromArn } from "@/lib/ecs";
import { useEcs } from "@/stores/ecs";
import { LogsContext, useLogs } from "@/stores/logs";
import { useTabs, type ServiceTab } from "@/stores/tabs";

/** Shows a tab's service (the tabs follow the selected service). */
function show(tab: ServiceTab) {
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

/** One tab; also auto-pauses its live tail while it's in the background. */
function TabItem({ tab, active }: { tab: ServiceTab; active: boolean }) {
  const state = useLogs((s) => s.live?.state);
  useAutoPause(active);
  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={tab.service.serviceName}
      title={`${tab.service.serviceName} · ${nameFromArn(tab.service.clusterArn)}`}
      tabIndex={active ? 0 : -1}
      onClick={() => show(tab)}
      onAuxClick={(e) => e.button === 1 && closeTab(tab.key)}
      onKeyDown={(e) => e.key === "Enter" && show(tab)}
      className={cn(
        "group flex max-w-48 shrink-0 cursor-default items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs",
        active
          ? "bg-background text-foreground shadow-[inset_0_-2px_0_var(--primary)]"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          DOT[state ?? ""] ?? "bg-muted-foreground/40",
        )}
      />
      <span className="truncate">{tab.service.serviceName}</span>
      <button
        type="button"
        aria-label={`Close ${tab.service.serviceName}`}
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
      aria-label="Open services"
      className="flex overflow-x-auto border-b border-border bg-muted/30"
    >
      {tabs.map((tab) => (
        <LogsContext.Provider key={tab.key} value={tab.logs}>
          <TabItem tab={tab} active={tab.key === activeKey} />
        </LogsContext.Provider>
      ))}
    </div>
  );
}
