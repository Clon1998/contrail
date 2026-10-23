import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  commands,
  type ApiError,
  type AwsCtx,
  type LiveUpdate,
  type LogEvent,
  type LogViewInfo,
  type ServiceRef,
} from "@/bindings";

/** Optional columns of the log list (time, level, task and message are always shown). */
export type OptionalColumn = "logger" | "thread" | "correlation";

/** Why a live tail is paused; it runs only while none applies. */
export type PauseReason = "user" | "hidden" | "background";

/** Rows are fetched from the Rust buffer in pages of this size. */
export const PAGE_SIZE = 100;

interface LogsState {
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
  /** Which tab of the service view is shown. */
  tab: "overview" | "logs";
  /** A task to show alone, set from the task list ("Logs" on a task row). */
  taskFilter: { service: ServiceRef; taskId: string } | null;
  columns: Record<OptionalColumn, boolean>;
  /** Expanded rows, by sequence number. */
  expanded: Record<number, boolean>;

  /** Opens the logs of `service` (or one task of it) for the last `minutes`, then goes live. */
  open: (ctx: AwsCtx, service: ServiceRef, minutes: number, taskId: string | null) => Promise<void>;
  close: () => Promise<void>;
  /** Makes sure the rows `from..=to` are (being) loaded. */
  fetchRows: (from: number, to: number) => void;
  setPaused: (reason: PauseReason, paused: boolean) => void;
  setTab: (tab: "overview" | "logs") => void;
  /** Shows only `taskId`'s logs, or all tasks again with `null`. */
  showTask: (service: ServiceRef, taskId: string | null) => void;
  setColumn: (column: OptionalColumn, shown: boolean) => void;
  toggleExpanded: (seq: number) => void;
}

/** Counts each `open` call, so an older, slower one can't overwrite a newer one. */
let generation = 0;
/** Pages being fetched right now, as "view:page". */
const inFlight = new Set<string>();

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

export const useLogs = create<LogsState>((set, get) => ({
  view: null,
  service: null,
  taskId: null,
  loading: false,
  error: null,
  live: null,
  pauseReasons: NO_PAUSE,
  pages: new Map(),
  tab: "overview",
  taskFilter: null,
  columns: { logger: false, thread: false, correlation: false },
  expanded: {},

  open: async (ctx, service, minutes, taskId) => {
    const mine = ++generation;
    const previous = get().view;
    set({
      service,
      taskId,
      loading: true,
      error: null,
      expanded: {},
      live: null,
      pages: new Map(),
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
    set({ view, loading: false });

    // Live updates for this view: new state and counts, and which cached rows are stale.
    const channel = new Channel<LiveUpdate>((update) => {
      const current = get().view;
      if (current?.viewId !== view.viewId) return;
      set({
        live: update,
        view: { ...current, stats: update.stats },
        pages: keepValidPages(get().pages, update),
      });
    });
    await commands.startLive(view.viewId, channel);
    // Auto-pause may already apply (e.g. opened while hidden).
    if (Object.values(get().pauseReasons).some(Boolean)) {
      void commands.pauseLive(view.viewId);
    }
  },

  close: async () => {
    generation++;
    const view = get().view;
    set({
      view: null,
      service: null,
      taskId: null,
      loading: false,
      expanded: {},
      live: null,
      pages: new Map(),
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

  setTab: (tab) => set({ tab }),
  showTask: (service, taskId) =>
    set({ taskFilter: taskId ? { service, taskId } : null, tab: "logs" }),
  setColumn: (column, shown) => set((s) => ({ columns: { ...s.columns, [column]: shown } })),
  toggleExpanded: (seq) => set((s) => ({ expanded: { ...s.expanded, [seq]: !s.expanded[seq] } })),
}));
