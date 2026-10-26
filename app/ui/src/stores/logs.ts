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
  type TimeWindow,
} from "@/bindings";
import { liveMode } from "@/lib/logs";
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
  /** The query is one regular expression, not query syntax. */
  regex: boolean;
  hiddenLevels: Level[];
  /** Hide lines matching the service's noise list. */
  hideNoise: boolean;
}

export const EMPTY_SEARCH: Search = {
  query: "",
  mode: "filter",
  raw: false,
  regex: false,
  hiddenLevels: [],
  hideNoise: true,
};

export interface LogsState {
  /** The open view, or `null`. Its `stats` follow the live updates. */
  view: LogViewInfo | null;
  /** The service (and task, for a task view) the view belongs to. */
  service: ServiceRef | null;
  taskId: string | null;
  /** The profile the view was opened with (noise lists and field mappings are per profile). */
  profile: string | null;
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
  /** The time window the view was opened with. */
  timeWindow: TimeWindow;
  /** Which tab of the service view is shown. */
  tab: "overview" | "logs";
  /** A task to show alone, set from the task list ("Logs" on a task row). */
  taskFilter: { service: ServiceRef; taskId: string } | null;
  /** Expanded rows, by sequence number. */
  expanded: Record<number, boolean>;
  /** Loading older events of the window (the view starts with the newest). */
  older: { loading: boolean; full: boolean; error: ApiError | null };
  /** Rows that just arrived live (by sequence number): they fade in briefly. */
  fresh: Record<number, true>;
  /** Rows just put in front of the list (`nonce` makes each load count), for keeping the scroll. */
  prepended: { count: number; nonce: number } | null;
  /**
   * Where the list was scrolled when it was last hidden (Overview tab, another service tab), so it
   * comes back there; `null` follows the newest event.
   */
  scrollAnchor: ScrollAnchor | null;
  /** The Fields panel is shown (remembered per service for the session, like the search). */
  fieldsOpen: boolean;
  /** Fields whose values the panel lists. */
  fieldsExpanded: string[];
  /** Counts the searches applied, so the Fields panel knows when to count again. */
  searchRevision: number;

  /**
   * Opens the logs of `service` (or one task of it) for `timeWindow`, then follows new events (live,
   * paused or not at all, see `liveMode`).
   */
  open: (
    ctx: AwsCtx,
    service: ServiceRef,
    timeWindow: TimeWindow,
    taskId: string | null,
  ) => Promise<void>;
  /** Like `open`, unless the view is already open (or opening) with exactly these arguments. */
  ensureOpen: (
    ctx: AwsCtx,
    service: ServiceRef,
    timeWindow: TimeWindow,
    taskId: string | null,
  ) => Promise<void>;
  setWindow: (timeWindow: TimeWindow) => void;
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
  setScrollAnchor: (anchor: ScrollAnchor | null) => void;
  setFieldsOpen: (open: boolean) => void;
  toggleFieldExpanded: (key: string) => void;
  /** Shows only `taskId`'s logs, or all tasks again with `null`. */
  showTask: (service: ServiceRef, taskId: string | null) => void;
  toggleExpanded: (seq: number) => void;
  /** Loads the next older events of the window, unless all are loaded or the buffer is full. */
  loadOlder: () => Promise<void>;
  /** Loads older events until the whole window is loaded (or the buffer is full). */
  loadAll: () => Promise<void>;
}

/** The event at the top of the list (by sequence number) and how far it was scrolled past. */
export interface ScrollAnchor {
  seq: number;
  offset: number;
}

/** The buffer index of the cached event `seq`, if it is loaded. */
export function cachedIndexOf(pages: Map<number, LogEvent[]>, seq: number): number | undefined {
  for (const [page, rows] of pages) {
    const i = rows.findIndex((e) => e.seq === seq);
    if (i >= 0) return page * PAGE_SIZE + i;
  }
  return undefined;
}

const NO_PAUSE: Record<PauseReason, boolean> = { user: false, hidden: false, background: false };
const NO_OLDER = { loading: false, full: false, error: null };
/** How long a row that just arrived live stays highlighted. */
const FRESH_MS = 1_500;

/**
 * The cached rows after a live update. Evicted rows shift every index down (the cached rows move
 * along instead of being dropped); rows from `firstChanged` on moved or are new: the rows that came
 * with the update take their place, so new rows show without a fetch (no placeholder flash), and
 * the page holding `firstChanged` keeps its rows before it (an expanded row stays open). Anything
 * that doesn't fit contiguously is left for the list to fetch.
 */
export function applyLiveRows(
  pages: Map<number, LogEvent[]>,
  update: Pick<LiveUpdate, "firstChanged" | "evicted" | "rows">,
): Map<number, LogEvent[]> {
  const current = update.evicted > 0 ? shiftPages(pages, update.evicted) : pages;
  const first = update.firstChanged;
  if (first === null) return current;
  const next = new Map<number, LogEvent[]>();
  for (const [page, rows] of current) {
    const start = page * PAGE_SIZE;
    // The page that new rows continue gets a copy: `appendRow` extends it.
    if (start + rows.length <= first)
      next.set(page, start + PAGE_SIZE > first ? rows.slice() : rows);
    else if (start < first) next.set(page, rows.slice(0, first - start));
  }
  update.rows.forEach((event, i) => appendRow(next, first + i, event));
  return next;
}

/**
 * The cached rows after `load_older` put `added` rows in front: every cached row moves back by
 * `added`, and the rows that came along (listed rows from `rowsFrom`, around the previous first
 * row) are placed, so the rows on screen stay rendered.
 */
export function placeOlderRows(
  pages: Map<number, LogEvent[]>,
  older: { added: number; rowsFrom: number; rows: LogEvent[] },
): Map<number, LogEvent[]> {
  const next = shiftPages(pages, -older.added);
  older.rows.forEach((event, i) => putRow(next, older.rowsFrom + i, event));
  return next;
}

/**
 * How listed rows moved while a row fetch was in flight: `shift` rows were dropped in front
 * (negative: added in front), and rows from `valid` on (current indices) changed.
 */
export interface FetchDrift {
  shift: number;
  valid: number;
}

/**
 * The cache with the rows of a fetched page added: each row moves by `drift.shift`, and rows that
 * changed while the fetch was in flight are left out (they are fetched again).
 */
export function mergeFetchedRows(
  pages: Map<number, LogEvent[]>,
  page: number,
  rows: LogEvent[],
  drift: FetchDrift,
): Map<number, LogEvent[]> {
  const next = new Map(pages);
  const copied = new Set<number>();
  rows.forEach((event, i) => {
    const index = page * PAGE_SIZE + i - drift.shift;
    if (index < 0 || index >= drift.valid) return;
    const target = Math.floor(index / PAGE_SIZE);
    const existing = next.get(target);
    if (existing && !copied.has(target)) next.set(target, existing.slice());
    copied.add(target);
    putRow(next, index, event);
  });
  return next;
}

/** A page cache holding the rows of `blocks` (rows not starting a page are left for a fetch). */
export function pagesFromBlocks(blocks: { offset: number; rows: LogEvent[] }[]) {
  const pages = new Map<number, LogEvent[]>();
  for (const block of blocks) {
    block.rows.forEach((event, i) => putRow(pages, block.offset + i, event));
  }
  return pages;
}

/** Like `appendRow`, but also replaces a row already cached at `index`. */
function putRow(pages: Map<number, LogEvent[]>, index: number, event: LogEvent) {
  const rows = pages.get(Math.floor(index / PAGE_SIZE));
  const offset = index % PAGE_SIZE;
  if (rows && offset < rows.length) rows[offset] = event;
  else appendRow(pages, index, event);
}

/** The cached rows with every index lowered by `by` (rows below 0 are gone; `by` < 0 raises). */
function shiftPages(pages: Map<number, LogEvent[]>, by: number): Map<number, LogEvent[]> {
  const next = new Map<number, LogEvent[]>();
  const ordered = [...pages].sort(([a], [b]) => a - b);
  for (const [page, rows] of ordered) {
    rows.forEach((event, i) => {
      const index = page * PAGE_SIZE + i - by;
      if (index >= 0) appendRow(next, index, event);
    });
  }
  return next;
}

/**
 * Puts `event` at list position `index` if that continues its page's rows (pages hold rows from
 * their start without gaps); the arrays in `pages` must be fresh copies, they are extended.
 */
function appendRow(pages: Map<number, LogEvent[]>, index: number, event: LogEvent) {
  const page = Math.floor(index / PAGE_SIZE);
  const offset = index % PAGE_SIZE;
  const rows = pages.get(page) ?? (offset === 0 ? [] : undefined);
  if (rows === undefined || rows.length !== offset) return;
  if (!pages.has(page)) pages.set(page, rows);
  rows.push(event);
}

/** Whether a cached page holds all of its rows (the last page only has the rest). */
export function isPageComplete(
  rows: LogEvent[] | undefined,
  page: number,
  visible: number,
): boolean {
  return rows !== undefined && rows.length >= Math.min(PAGE_SIZE, visible - page * PAGE_SIZE);
}

/**
 * Creates the state of one service tab's log view. Every open tab has its own store (a
 * zustand "vanilla" store, i.e. not bound to a React hook); components read the store of the
 * tab they render in through `LogsContext` with `useLogs`.
 */
export function createLogsStore(timeWindow: TimeWindow): StoreApi<LogsState> {
  /** Counts each `open` call, so an older, slower one can't overwrite a newer one. */
  let generation = 0;
  /** What the view was last opened with (see `ensureOpen`). */
  let openedWith = "";
  /**
   * Pages being fetched right now, as "view:page", with how the rows moved since (live updates,
   * older rows put in front, a new search). A slow fetch keeps the rows that are still valid
   * instead of being thrown away whenever anything changed (with live updates every second and a
   * slower round trip, nothing would ever load).
   */
  const inFlight = new Map<string, FetchDrift>();
  /** The highest sequence number seen (rows above it that come live are new). */
  let newestSeq = 0;
  /** The rows the list asked for last (on screen plus its prefetch margin). */
  let lastRange = { from: 0, to: PAGE_SIZE - 1 };
  /** Records a change for the fetches in flight: `shift` rows dropped in front, rows from `from` changed. */
  function rowsMoved(shift: number, from: number | null) {
    for (const drift of inFlight.values()) {
      drift.shift += shift;
      drift.valid = Math.min(drift.valid - shift, from ?? Infinity);
    }
  }
  let matchRefresh: ReturnType<typeof setTimeout> | undefined;

  const store = createStore<LogsState>((set, get) => ({
    view: null,
    service: null,
    taskId: null,
    profile: null,
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
    timeWindow,
    tab: "overview",
    taskFilter: null,
    fieldsOpen: false,
    fieldsExpanded: [],
    searchRevision: 0,
    expanded: {},
    older: NO_OLDER,
    prepended: null,
    fresh: {},
    scrollAnchor: null,

    open: async (ctx, service, timeWindow, taskId) => {
      const mine = ++generation;
      openedWith = openKey(ctx, service, timeWindow, taskId);
      const previous = get().view;
      set({
        service,
        taskId,
        profile: ctx.profile,
        loading: true,
        error: null,
        expanded: {},
        scrollAnchor: null,
        live: null,
        pages: new Map(),
        matchPositions: [],
        currentMatch: -1,
        older: NO_OLDER,
        prepended: null,
        pauseReasons: { ...get().pauseReasons, user: false },
      });
      if (previous) void commands.closeLogView(previous.viewId);

      const opened = await commands.openServiceLogs(ctx, service, timeWindow, taskId);
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

      const mode = liveMode(timeWindow);
      if (mode === "off") return;
      if (mode === "paused") set({ pauseReasons: { ...get().pauseReasons, user: true } });

      // Live updates for this view: new state and counts, and which cached rows are stale.
      const channel = new Channel<LiveUpdate>((update) => {
        const current = get().view;
        if (current?.viewId !== view.viewId) return;
        // Rows newer than any seen before arrived live: mark them fresh for a moment.
        const arrived = update.rows.filter((e) => e.seq > newestSeq).map((e) => e.seq);
        newestSeq = Math.max(newestSeq, ...update.rows.map((e) => e.seq));
        if (arrived.length > 0) {
          set({
            fresh: { ...get().fresh, ...Object.fromEntries(arrived.map((seq) => [seq, true])) },
          });
          setTimeout(() => {
            const done = new Set(arrived);
            const fresh = Object.entries(get().fresh).filter(([seq]) => !done.has(Number(seq)));
            set({ fresh: Object.fromEntries(fresh) as Record<number, true> });
          }, FRESH_MS);
        }
        set({
          live: update,
          view: { ...current, stats: update.stats },
          visible: update.visible,
          matches: update.matches,
          pages: applyLiveRows(get().pages, update),
        });
        rowsMoved(update.evicted, update.firstChanged);
        if (get().search.mode === "highlight" && update.firstChanged !== null) {
          scheduleMatchRefresh();
        }
      });
      // Starts paused when a pause applies already (long window, window hidden, background tab),
      // so no Live Tail session is opened for nothing.
      await commands.startLive(
        view.viewId,
        channel,
        Object.values(get().pauseReasons).some(Boolean),
      );
    },

    ensureOpen: async (ctx, service, timeWindow, taskId) => {
      if (openedWith === openKey(ctx, service, timeWindow, taskId)) return;
      await get().open(ctx, service, timeWindow, taskId);
    },

    setWindow: (timeWindow) => set({ timeWindow }),

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
      lastRange = { from, to };
      for (let page = Math.floor(from / PAGE_SIZE); page <= Math.floor(to / PAGE_SIZE); page++) {
        const key = `${view.viewId}:${page}`;
        if (isPageComplete(get().pages.get(page), page, get().visible) || inFlight.has(key))
          continue;
        const drift: FetchDrift = { shift: 0, valid: Infinity };
        inFlight.set(key, drift);
        void commands.getLogRows(view.viewId, page * PAGE_SIZE, PAGE_SIZE).then((result) => {
          inFlight.delete(key);
          if (result.status !== "ok" || get().view?.viewId !== view.viewId) return;
          newestSeq = Math.max(newestSeq, ...result.data.map((e) => e.seq));
          // Always a new map: rows left out make the list fetch again.
          set({ pages: mergeFetchedRows(get().pages, page, result.data, drift) });
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
      const { view, service, search, profile } = get();
      if (!view || !service) return;
      const noise =
        search.hideNoise && profile
          ? (usePrefs.getState().prefs.noise[noiseKey(profile, service)] ?? [])
          : [];
      // The rows the list showed last (same positions), and the newest (where following stays):
      // they come back with the result, so the list switches to the new rows in one step.
      const from = Math.floor(lastRange.from / PAGE_SIZE) * PAGE_SIZE;
      const span = Math.min(1000, lastRange.to - from + 1);
      const result = await commands.setLogFilter(
        view.viewId,
        {
          query: search.query,
          mode: search.mode,
          hiddenLevels: search.hiddenLevels,
          searchRaw: search.raw,
          regex: search.regex,
          noise,
        },
        [
          { offset: from, limit: span, fromEnd: false },
          { offset: 0, limit: span, fromEnd: true },
        ],
      );
      if (get().view?.viewId !== view.viewId || result.status !== "ok") return;
      const outcome = result.data;
      if (outcome.kind === "invalid") {
        set({ queryError: outcome.error });
        return;
      }
      rowsMoved(0, 0); // a new search lists other rows: nothing fetched before is valid
      set({
        queryError: null,
        visible: outcome.visible,
        matches: outcome.matches,
        highlightTerms: outcome.highlightTerms,
        // Every listed row may be different now: only the rows that came along are known.
        pages: pagesFromBlocks(outcome.rows),
        expanded: {},
        currentMatch: -1,
        matchPositions: [],
        searchRevision: get().searchRevision + 1,
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
    setScrollAnchor: (scrollAnchor) => set({ scrollAnchor }),
    setFieldsOpen: (fieldsOpen) => set({ fieldsOpen }),
    toggleFieldExpanded: (key) => {
      const expanded = get().fieldsExpanded;
      set({
        fieldsExpanded: expanded.includes(key)
          ? expanded.filter((k) => k !== key)
          : [...expanded, key],
      });
    },
    showTask: (service, taskId) =>
      set({ taskFilter: taskId ? { service, taskId } : null, tab: "logs" }),
    toggleExpanded: (seq) => set((s) => ({ expanded: { ...s.expanded, [seq]: !s.expanded[seq] } })),

    loadOlder: async () => {
      const { view, older } = get();
      if (!view || view.complete || older.loading || older.full) return;
      set({ older: { ...older, loading: true, error: null } });
      const result = await commands.loadOlder(view.viewId);
      const current = get().view;
      if (current?.viewId !== view.viewId) return;
      if (result.status === "error") {
        set({ older: { loading: false, full: false, error: result.error } });
        return;
      }
      const loaded = result.data;
      newestSeq = Math.max(newestSeq, ...loaded.rows.map((e) => e.seq));
      rowsMoved(-loaded.added, null); // the rows in flight moved back by what came in front
      set({
        view: {
          ...current,
          stats: loaded.stats,
          loadedFrom: loaded.loadedFrom,
          complete: loaded.complete,
        },
        visible: loaded.visible,
        matches: loaded.matches,
        pages: placeOlderRows(get().pages, loaded),
        older: { loading: false, full: loaded.full, error: null },
        prepended:
          loaded.added > 0
            ? { count: loaded.added, nonce: (get().prepended?.nonce ?? 0) + 1 }
            : get().prepended,
      });
      if (get().search.mode === "highlight") scheduleMatchRefresh();
    },

    loadAll: async () => {
      const viewId = get().view?.viewId;
      while (viewId !== undefined && get().view?.viewId === viewId) {
        const { view, older } = get();
        if (!view || view.complete || older.full || older.error) return;
        await get().loadOlder();
      }
    },
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

function openKey(ctx: AwsCtx, service: ServiceRef, timeWindow: TimeWindow, taskId: string | null) {
  const range =
    timeWindow.kind === "last" ? timeWindow.minutes : `${timeWindow.from}/${timeWindow.to}`;
  return [ctx.profile, ctx.region, service.clusterArn, service.serviceName, range, taskId].join(
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
