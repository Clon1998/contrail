import { createContext, useContext } from "react";
import { Channel } from "@tauri-apps/api/core";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  commands,
  type ApiError,
  type AwsCtx,
  type FilterMode,
  type Level,
  type LiveUpdate,
  type LogEvent,
  type LogViewInfo,
  type QueryError,
  type ServiceRef,
} from "@/bindings";
import { noiseKey, usePrefs } from "./prefs";

/** Why a live tail is paused; it runs only while none applies. */
export type PauseReason = "user" | "hidden" | "background";

/** Rows are fetched from the Rust buffer in pages of this size. */
export const PAGE_SIZE = 100;

/** The search of a log view. */
export interface Search {
  query: string;
  mode: FilterMode;
  /** Search the whole raw line, not just the message. */
  raw: boolean;
  hiddenLevels: Level[];
  /** Hide lines matching the service's noise list. */
  hideNoise: boolean;
}

export const EMPTY_SEARCH: Search = {
  query: "",
  mode: "filter",
  raw: false,
  hiddenLevels: [],
  hideNoise: true,
};

export interface LogsState {
  /** The open view, or `null`. Its `stats` follow the live updates. */
  view: LogViewInfo | null;
  /** The service (and task, for a task view) the view belongs to. */
  service: ServiceRef | null;
  taskId: string | null;
  loading: boolean;
  error: ApiError | null;
  /** The latest live update (state, sampled, message), `null` before the tail started. */
  live: LiveUpdate | null;
  pauseReasons: Record<PauseReason, boolean>;
  /** Loaded rows by page (`index / PAGE_SIZE`). */
  pages: Map<number, LogEvent[]>;
  /** How many rows the list shows (all events, or the matches when filtering). */
  visible: number;
  search: Search;
  /** Matching events when a search is set. */
  matches: number | null;
  queryError: QueryError | null;
  /** Words to highlight in messages. */
  highlightTerms: string[];
  /** In highlight mode: the listed rows that match, ascending. */
  matchPositions: number[];
  /** The match last jumped to (index into `matchPositions`), or -1. */
  currentMatch: number;
  /** A row the list should scroll to (`nonce` makes repeated jumps to the same row work). */
  scrollTarget: { index: number; nonce: number } | null;
  /** The time window (minutes back) the view was opened with. */
  minutes: number;
  /** Which tab of the service view is shown. */
  tab: "overview" | "logs";
  /** A task to show alone, set from the task list ("Logs" on a task row). */
  taskFilter: { service: ServiceRef; taskId: string } | null;
  /** Expanded rows, by sequence number. */
  expanded: Record<number, boolean>;

  /** Opens the logs of `service` (or one task of it) for the last `minutes`, then goes live. */
  open: (ctx: AwsCtx, service: ServiceRef, minutes: number, taskId: string | null) => Promise<void>;
  /** Like `open`, unless the view is already open (or opening) with exactly these arguments. */
  ensureOpen: (
    ctx: AwsCtx,
    service: ServiceRef,
    minutes: number,
    taskId: string | null,
  ) => Promise<void>;
  setMinutes: (minutes: number) => void;
  close: () => Promise<void>;
  /** Makes sure the rows `from..=to` are (being) loaded. */
  fetchRows: (from: number, to: number) => void;
  setPaused: (reason: PauseReason, paused: boolean) => void;
  /** Tries a stopped live tail again (e.g. after logging in). */
  retryLive: () => void;
  /** Changes the search and applies it to the open view. */
  setSearch: (change: Partial<Search>) => Promise<void>;
  /** Applies the current search to the open view (e.g. after the noise list changed). */
  applySearch: () => Promise<void>;
  /** Jumps to the next (1) or previous (-1) match after/before `fromIndex`. */
  gotoMatch: (direction: 1 | -1, fromIndex: number) => Promise<void>;
  setTab: (tab: "overview" | "logs") => void;
  /** Shows only `taskId`'s logs, or all tasks again with `null`. */
  showTask: (service: ServiceRef, taskId: string | null) => void;
  toggleExpanded: (seq: number) => void;
}

const NO_PAUSE: Record<PauseReason, boolean> = { user: false, hidden: false, background: false };

/** The pages still valid after a live update: rows from `firstChanged` on moved or are new. */
export function keepValidPages(
  pages: Map<number, LogEvent[]>,
  update: Pick<LiveUpdate, "firstChanged" | "evicted">,
): Map<number, LogEvent[]> {
  if (update.evicted > 0) return new Map();
  const first = update.firstChanged;
  if (first === null) return pages;
  return new Map([...pages].filter(([page]) => (page + 1) * PAGE_SIZE <= first));
}

/**
 * Creates the state of one service tab's log view. Every open tab has its own store (a
 * zustand "vanilla" store, i.e. not bound to a React hook); components read the store of the
 * tab they render in through `LogsContext` with `useLogs`.
 */
export function createLogsStore(minutes: number): StoreApi<LogsState> {
  /** Counts each `open` call, so an older, slower one can't overwrite a newer one. */
  let generation = 0;
  /** What the view was last opened with (see `ensureOpen`). */
  let openedWith = "";
  /** Pages being fetched right now, as "view:page". */
  const inFlight = new Set<string>();
  let matchRefresh: ReturnType<typeof setTimeout> | undefined;

  const store = createStore<LogsState>((set, get) => ({
    view: null,
    service: null,
    taskId: null,
    loading: false,
    error: null,
    live: null,
    pauseReasons: NO_PAUSE,
    pages: new Map(),
    visible: 0,
    search: EMPTY_SEARCH,
    matches: null,
    queryError: null,
    highlightTerms: [],
    matchPositions: [],
    currentMatch: -1,
    scrollTarget: null,
    minutes,
    tab: "overview",
    taskFilter: null,
    expanded: {},

    open: async (ctx, service, minutes, taskId) => {
      const mine = ++generation;
      openedWith = openKey(ctx, service, minutes, taskId);
      const previous = get().view;
      set({
        service,
        taskId,
        loading: true,
        error: null,
        expanded: {},
        live: null,
        pages: new Map(),
        matchPositions: [],
        currentMatch: -1,
        pauseReasons: { ...get().pauseReasons, user: false },
      });
      if (previous) void commands.closeLogView(previous.viewId);

      const opened = await commands.openServiceLogs(ctx, service, minutes, taskId);
      if (mine !== generation) {
        if (opened.status === "ok") void commands.closeLogView(opened.data.viewId);
        return;
      }
      if (opened.status === "error") {
        set({ view: null, loading: false, error: opened.error });
        return;
      }
      const view = opened.data;
      set({ view, loading: false, visible: view.stats.total, matches: null });
      // The search carries over to the new view.
      await get().applySearch();

      // Live updates for this view: new state and counts, and which cached rows are stale.
      const channel = new Channel<LiveUpdate>((update) => {
        const current = get().view;
        if (current?.viewId !== view.viewId) return;
        set({
          live: update,
          view: { ...current, stats: update.stats },
          visible: update.visible,
          matches: update.matches,
          pages: keepValidPages(get().pages, update),
        });
        if (get().search.mode === "highlight" && update.firstChanged !== null) {
          scheduleMatchRefresh();
        }
      });
      await commands.startLive(view.viewId, channel);
      // Auto-pause may already apply (e.g. opened while hidden).
      if (Object.values(get().pauseReasons).some(Boolean)) {
        void commands.pauseLive(view.viewId);
      }
    },

    ensureOpen: async (ctx, service, minutes, taskId) => {
      if (openedWith === openKey(ctx, service, minutes, taskId)) return;
      await get().open(ctx, service, minutes, taskId);
    },

    setMinutes: (minutes) => set({ minutes }),

    close: async () => {
      generation++;
      openedWith = "";
      const view = get().view;
      set({
        view: null,
        service: null,
        taskId: null,
        loading: false,
        expanded: {},
        live: null,
        pages: new Map(),
        matchPositions: [],
      });
      if (view) await commands.closeLogView(view.viewId);
    },

    fetchRows: (from, to) => {
      const view = get().view;
      if (!view) return;
      for (let page = Math.floor(from / PAGE_SIZE); page <= Math.floor(to / PAGE_SIZE); page++) {
        const key = `${view.viewId}:${page}`;
        if (get().pages.has(page) || inFlight.has(key)) continue;
        inFlight.add(key);
        void commands.getLogRows(view.viewId, page * PAGE_SIZE, PAGE_SIZE).then((result) => {
          inFlight.delete(key);
          if (result.status !== "ok" || get().view?.viewId !== view.viewId) return;
          set({ pages: new Map(get().pages).set(page, result.data) });
        });
      }
    },

    setPaused: (reason, paused) => {
      const before = Object.values(get().pauseReasons).some(Boolean);
      const pauseReasons = { ...get().pauseReasons, [reason]: paused };
      const after = Object.values(pauseReasons).some(Boolean);
      set({ pauseReasons });
      const view = get().view;
      if (!view || before === after) return;
      void (after ? commands.pauseLive(view.viewId) : commands.resumeLive(view.viewId));
    },

    retryLive: () => {
      const view = get().view;
      if (view) void commands.resumeLive(view.viewId);
    },

    setSearch: async (change) => {
      set({ search: { ...get().search, ...change } });
      await get().applySearch();
    },

    applySearch: async () => {
      const { view, service, search } = get();
      if (!view || !service) return;
      const profile = usePrefs.getState().prefs.lastProfile;
      const noise =
        search.hideNoise && profile
          ? (usePrefs.getState().prefs.noise[noiseKey(profile, service)] ?? [])
          : [];
      const result = await commands.setLogFilter(view.viewId, {
        query: search.query,
        mode: search.mode,
        hiddenLevels: search.hiddenLevels,
        searchRaw: search.raw,
        noise,
      });
      if (get().view?.viewId !== view.viewId || result.status !== "ok") return;
      const outcome = result.data;
      if (outcome.kind === "invalid") {
        set({ queryError: outcome.error });
        return;
      }
      set({
        queryError: null,
        visible: outcome.visible,
        matches: outcome.matches,
        highlightTerms: outcome.highlightTerms,
        // Every listed row may be different now.
        pages: new Map(),
        expanded: {},
        currentMatch: -1,
        matchPositions: [],
      });
      if (search.mode === "highlight") await refreshMatchPositions();
    },

    gotoMatch: async (direction, fromIndex) => {
      const { search, visible } = get();
      if (search.mode === "highlight") {
        await refreshMatchPositions();
        const positions = get().matchPositions;
        if (positions.length === 0) return;
        // The first match after (or before) the given row, wrapping around.
        let target =
          direction === 1
            ? positions.findIndex((p) => p > fromIndex)
            : lastBefore(positions, fromIndex);
        if (target === -1) target = direction === 1 ? 0 : positions.length - 1;
        const index = positions[target] ?? 0;
        set({ currentMatch: target, scrollTarget: { index, nonce: Date.now() } });
        return;
      }
      // Filtering: every listed row is a match; step row by row.
      if (visible === 0) return;
      const index = Math.min(Math.max(fromIndex + direction, 0), visible - 1);
      set({ scrollTarget: { index, nonce: Date.now() } });
    },

    setTab: (tab) => set({ tab }),
    showTask: (service, taskId) =>
      set({ taskFilter: taskId ? { service, taskId } : null, tab: "logs" }),
    toggleExpanded: (seq) => set((s) => ({ expanded: { ...s.expanded, [seq]: !s.expanded[seq] } })),
  }));

  /** Fetches the rows that match (highlight mode) for marking and navigation. */
  async function refreshMatchPositions() {
    const view = store.getState().view;
    if (!view) return;
    const result = await commands.getMatchPositions(view.viewId);
    if (result.status === "ok" && store.getState().view?.viewId === view.viewId) {
      store.setState({ matchPositions: result.data });
    }
  }

  /** Live updates arrive every second: refresh the match positions at most twice a second. */
  function scheduleMatchRefresh() {
    if (matchRefresh) return;
    matchRefresh = setTimeout(() => {
      matchRefresh = undefined;
      void refreshMatchPositions();
    }, 500);
  }

  return store;
}

function openKey(ctx: AwsCtx, service: ServiceRef, minutes: number, taskId: string | null) {
  return [ctx.profile, ctx.region, service.clusterArn, service.serviceName, minutes, taskId].join(
    "|",
  );
}

/** The logs store of the tab being rendered (provided by `ServiceView` and the tab bar). */
export const LogsContext = createContext<StoreApi<LogsState> | null>(null);

/** The logs store of the surrounding tab. */
export function useLogsStore(): StoreApi<LogsState> {
  const store = useContext(LogsContext);
  if (!store) throw new Error("useLogs needs a LogsContext provider (a service tab)");
  return store;
}

/** Reads from the surrounding tab's logs store, like a zustand hook: `useLogs((s) => s.view)`. */
export function useLogs<T>(selector: (state: LogsState) => T): T {
  return useStore(useLogsStore(), selector);
}

/** The index of the last position before `index`, or -1 (positions are ascending). */
function lastBefore(positions: number[], index: number): number {
  for (let i = positions.length - 1; i >= 0; i--) {
    if ((positions[i] ?? Infinity) < index) return i;
  }
  return -1;
}
