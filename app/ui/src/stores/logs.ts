import { create } from "zustand";
import {
  commands,
  type ApiError,
  type AwsCtx,
  type LogViewInfo,
  type ServiceRef,
} from "@/bindings";

/** Optional columns of the log list (time, level, task and message are always shown). */
export type OptionalColumn = "logger" | "thread" | "correlation";

interface LogsState {
  /** The open view, or `null`. */
  view: LogViewInfo | null;
  /** The service (and task, for a task view) the view belongs to. */
  service: ServiceRef | null;
  taskId: string | null;
  loading: boolean;
  error: ApiError | null;
  /** Which tab of the service view is shown. */
  tab: "overview" | "logs";
  /** A task to show alone, set from the task list ("Logs" on a task row). */
  taskFilter: { service: ServiceRef; taskId: string } | null;
  columns: Record<OptionalColumn, boolean>;
  /** Expanded rows, by sequence number. */
  expanded: Record<number, boolean>;

  /** Opens the logs of `service` (or one task of it) for the last `minutes`. */
  open: (ctx: AwsCtx, service: ServiceRef, minutes: number, taskId: string | null) => Promise<void>;
  close: () => Promise<void>;
  setTab: (tab: "overview" | "logs") => void;
  /** Shows only `taskId`'s logs, or all tasks again with `null`. */
  showTask: (service: ServiceRef, taskId: string | null) => void;
  setColumn: (column: OptionalColumn, shown: boolean) => void;
  toggleExpanded: (seq: number) => void;
}

/** Counts each `open` call, so an older, slower one can't overwrite a newer one. */
let generation = 0;

export const useLogs = create<LogsState>((set, get) => ({
  view: null,
  service: null,
  taskId: null,
  loading: false,
  error: null,
  tab: "overview",
  taskFilter: null,
  columns: { logger: false, thread: false, correlation: false },
  expanded: {},

  open: async (ctx, service, minutes, taskId) => {
    const mine = ++generation;
    const previous = get().view;
    set({ service, taskId, loading: true, error: null, expanded: {} });
    if (previous) void commands.closeLogView(previous.viewId);

    const opened = await commands.openServiceLogs(ctx, service, minutes, taskId);
    if (mine !== generation) {
      if (opened.status === "ok") void commands.closeLogView(opened.data.viewId);
      return;
    }
    set(
      opened.status === "ok"
        ? { view: opened.data, loading: false }
        : { view: null, loading: false, error: opened.error },
    );
  },

  close: async () => {
    generation++;
    const view = get().view;
    set({ view: null, service: null, taskId: null, loading: false, expanded: {} });
    if (view) await commands.closeLogView(view.viewId);
  },

  setTab: (tab) => set({ tab }),
  showTask: (service, taskId) =>
    set({ taskFilter: taskId ? { service, taskId } : null, tab: "logs" }),
  setColumn: (column, shown) => set((s) => ({ columns: { ...s.columns, [column]: shown } })),
  toggleExpanded: (seq) => set((s) => ({ expanded: { ...s.expanded, [seq]: !s.expanded[seq] } })),
}));
