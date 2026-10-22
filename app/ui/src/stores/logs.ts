import { create } from "zustand";
import {
  commands,
  type ApiError,
  type AwsCtx,
  type LogEvent,
  type LogViewInfo,
  type ServiceRef,
} from "@/bindings";

/** The debug view shows at most this many of the newest events (M4 reads windows on demand). */
export const DEBUG_ROW_LIMIT = 1_000;

interface LogsState {
  /** The open view, or `null`. */
  view: LogViewInfo | null;
  /** The service the view belongs to. */
  service: ServiceRef | null;
  rows: LogEvent[];
  loading: boolean;
  error: ApiError | null;

  /** Opens `service`'s logs for the last `minutes`, closing the previous view. */
  open: (ctx: AwsCtx, service: ServiceRef, minutes: number) => Promise<void>;
  close: () => Promise<void>;
}

/** Counts each `open` call, so an older, slower one can't overwrite a newer one. */
let generation = 0;

export const useLogs = create<LogsState>((set, get) => ({
  view: null,
  service: null,
  rows: [],
  loading: false,
  error: null,

  open: async (ctx, service, minutes) => {
    const mine = ++generation;
    await get().close();
    set({ service, loading: true, error: null, rows: [] });

    const opened = await commands.openServiceLogs(ctx, service, minutes, null);
    if (mine !== generation) {
      if (opened.status === "ok") void commands.closeLogView(opened.data.viewId);
      return;
    }
    if (opened.status === "error") {
      set({ loading: false, error: opened.error });
      return;
    }
    const view = opened.data;
    const offset = Math.max(0, view.stats.total - DEBUG_ROW_LIMIT);
    const rows = await commands.getLogRows(view.viewId, offset, DEBUG_ROW_LIMIT);
    if (mine !== generation) return;
    set({
      view,
      loading: false,
      rows: rows.status === "ok" ? rows.data : [],
      error: rows.status === "error" ? rows.error : null,
    });
  },

  close: async () => {
    const view = get().view;
    set({ view: null, rows: [], service: null });
    if (view) await commands.closeLogView(view.viewId);
  },
}));
