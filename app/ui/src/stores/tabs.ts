import { create } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ServiceRef } from "@/bindings";
import { createLogsStore, type LogsState } from "./logs";
import { usePrefs } from "./prefs";

/** More open services than this: opening another closes the one used longest ago. */
export const MAX_TABS = 10;

/** An open service: its log view (and live tail) stays open while the tab exists. */
export interface ServiceTab {
  key: string;
  service: ServiceRef;
  logs: StoreApi<LogsState>;
  /** When the tab was last shown (for closing the oldest). */
  lastActive: number;
}

interface TabsState {
  tabs: ServiceTab[];
  activeKey: string | null;
  /** Shows the tab of `service`, opening one if needed. */
  activate: (service: ServiceRef) => void;
  /** Closes a tab; returns the tab to show next (the neighbour), if any. */
  close: (key: string) => ServiceTab | null;
  closeAll: () => void;
}

/** What a service's view looked like when its tab closed (search, window, tab, task). */
type ViewMemory = Pick<LogsState, "search" | "timeWindow" | "tab" | "taskFilter">;

/**
 * The views of closed tabs, by tab key, for this session (not saved to disk): reopening a service
 * brings back its search, time window, Overview/Logs choice and task.
 */
const remembered = new Map<string, ViewMemory>();

function remember(tab: ServiceTab) {
  const { search, timeWindow, tab: shown, taskFilter } = tab.logs.getState();
  remembered.set(tab.key, { search, timeWindow, tab: shown, taskFilter });
}

export function tabKey(service: ServiceRef): string {
  return `${service.clusterArn}|${service.serviceName}`;
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeKey: null,

  activate: (service) => {
    const key = tabKey(service);
    const now = Date.now();
    let tabs = get().tabs;
    if (tabs.some((t) => t.key === key)) {
      tabs = tabs.map((t) => (t.key === key ? { ...t, lastActive: now } : t));
    } else {
      if (tabs.length >= MAX_TABS) {
        const oldest = tabs.reduce((a, b) => (a.lastActive <= b.lastActive ? a : b));
        remember(oldest);
        void oldest.logs.getState().close();
        tabs = tabs.filter((t) => t !== oldest);
      }
      const minutes = usePrefs.getState().prefs.settings.backfillMinutes;
      const logs = createLogsStore({ kind: "last", minutes });
      const memory = remembered.get(key);
      if (memory) logs.setState(memory);
      tabs = [...tabs, { key, service, logs, lastActive: now }];
    }
    set({ tabs, activeKey: key });
  },

  close: (key) => {
    const { tabs, activeKey } = get();
    const index = tabs.findIndex((t) => t.key === key);
    const tab = tabs[index];
    if (!tab) return null;
    remember(tab);
    void tab.logs.getState().close();
    const rest = tabs.filter((t) => t.key !== key);
    if (key !== activeKey) {
      set({ tabs: rest });
      return null;
    }
    const next = rest[Math.min(index, rest.length - 1)] ?? null;
    set({ tabs: rest, activeKey: next?.key ?? null });
    return next;
  },

  closeAll: () => {
    for (const tab of get().tabs) {
      remember(tab);
      void tab.logs.getState().close();
    }
    set({ tabs: [], activeKey: null });
  },
}));
