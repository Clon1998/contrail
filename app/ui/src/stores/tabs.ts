import { create } from "zustand";
import type { StoreApi } from "zustand/vanilla";
import type { ServiceRef } from "@/bindings";
import { createLogsStore, type LogsState } from "./logs";
import { usePrefs } from "./prefs";
import { createTraceStore, type TraceRequest, type TraceState } from "./trace";

/** More open tabs than this: opening another closes the one used longest ago. */
export const MAX_TABS = 10;

/** An open service: its log view (and live tail) stays open while the tab exists. */
export interface ServiceTab {
  kind: "service";
  key: string;
  service: ServiceRef;
  logs: StoreApi<LogsState>;
  /** When the tab was last shown (for closing the oldest). */
  lastActive: number;
}

/** A trace across services: it keeps its result until the tab is closed (it isn't live). */
export interface TraceTab {
  kind: "trace";
  key: string;
  trace: StoreApi<TraceState>;
  lastActive: number;
}

/**
 * An open tab. A union with a `kind` tag (a "discriminated union"): checking `tab.kind` tells
 * TypeScript which of the two it is, a bit like a sealed interface with pattern matching in Java.
 */
export type Tab = ServiceTab | TraceTab;

interface TabsState {
  tabs: Tab[];
  activeKey: string | null;
  /** Shows the tab of `service`, opening one if needed. */
  activate: (service: ServiceRef) => void;
  /** Shows the trace of `request.id` in its cluster, opening a tab if needed. */
  openTrace: (request: TraceRequest) => void;
  /** Shows an open tab. */
  show: (key: string) => void;
  /** Closes a tab; returns the tab to show next (the neighbour), if any. */
  close: (key: string) => Tab | null;
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

/** Tracing the same ID in the same cluster again shows its tab. */
export function traceKey(request: Pick<TraceRequest, "clusterArn" | "id">): string {
  return `trace|${request.clusterArn}|${request.id}`;
}

/** Ends what a tab keeps running (a service's log view and live tail). */
function release(tab: Tab) {
  if (tab.kind === "service") {
    remember(tab);
    void tab.logs.getState().close();
  }
}

/** `tabs` with room for one more: beyond the limit, the tab used longest ago is closed. */
function withRoom(tabs: Tab[]): Tab[] {
  if (tabs.length < MAX_TABS) return tabs;
  const oldest = tabs.reduce((a, b) => (a.lastActive <= b.lastActive ? a : b));
  release(oldest);
  return tabs.filter((t) => t !== oldest);
}

/** `tabs` with `key` marked as just shown. */
function touched(tabs: Tab[], key: string): Tab[] {
  const now = Date.now();
  return tabs.map((t) => (t.key === key ? { ...t, lastActive: now } : t));
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeKey: null,

  activate: (service) => {
    const key = tabKey(service);
    let tabs = get().tabs;
    if (tabs.some((t) => t.key === key)) {
      tabs = touched(tabs, key);
    } else {
      const minutes = usePrefs.getState().prefs.settings.backfillMinutes;
      const logs = createLogsStore({ kind: "last", minutes });
      const memory = remembered.get(key);
      if (memory) logs.setState(memory);
      tabs = [...withRoom(tabs), { kind: "service", key, service, logs, lastActive: Date.now() }];
    }
    set({ tabs, activeKey: key });
  },

  openTrace: (request) => {
    const key = traceKey(request);
    let tabs = get().tabs;
    if (tabs.some((t) => t.key === key)) {
      tabs = touched(tabs, key);
    } else {
      const trace = createTraceStore(request);
      tabs = [...withRoom(tabs), { kind: "trace", key, trace, lastActive: Date.now() }];
    }
    set({ tabs, activeKey: key });
  },

  show: (key) => {
    if (!get().tabs.some((t) => t.key === key)) return;
    set({ tabs: touched(get().tabs, key), activeKey: key });
  },

  close: (key) => {
    const { tabs, activeKey } = get();
    const index = tabs.findIndex((t) => t.key === key);
    const tab = tabs[index];
    if (!tab) return null;
    release(tab);
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
    for (const tab of get().tabs) release(tab);
    set({ tabs: [], activeKey: null });
  },
}));
