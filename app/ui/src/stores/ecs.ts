import { create } from "zustand";
import {
  commands,
  type ApiError,
  type AwsCtx,
  type ClusterSummary,
  type ServiceDetail,
  type ServiceRef,
  type ServiceSummary,
  type Task,
} from "@/bindings";
import { usePrefs } from "./prefs";

/**
 * A value loaded from the backend. `loading` and `error` keep the previous data, so a refresh
 * doesn't blank the screen.
 */
export type Loadable<T> =
  | { state: "idle" }
  | { state: "loading"; data?: T }
  | { state: "ok"; data: T }
  | { state: "error"; error: ApiError; data?: T };

const IDLE = { state: "idle" } as const;

function loading<T>(previous: Loadable<T>): Loadable<T> {
  return { state: "loading", data: "data" in previous ? previous.data : undefined };
}

function settle<T>(
  previous: Loadable<T>,
  result: { status: "ok"; data: T } | { status: "error"; error: ApiError },
): Loadable<T> {
  return result.status === "ok"
    ? { state: "ok", data: result.data }
    : {
        state: "error",
        error: result.error,
        data: "data" in previous ? previous.data : undefined,
      };
}

export function sameService(a: ServiceRef | null, b: ServiceRef | null): boolean {
  return a?.clusterArn === b?.clusterArn && a?.serviceName === b?.serviceName;
}

/** A service's detail and tasks as last loaded: switching back to its tab shows them at once. */
interface CachedService {
  detail: ServiceDetail;
  tasks: Task[];
  includeStopped: boolean;
  loadedAt: number;
}

/** Cached service data younger than this is shown without loading it again. */
export const FRESH_MS = 30_000;

function serviceKey(service: ServiceRef): string {
  return `${service.clusterArn}|${service.serviceName}`;
}

export function ctxKey(ctx: AwsCtx): string {
  return `${ctx.profile}|${ctx.region ?? ""}`;
}

/** What is kept of a profile + region while another one is browsed. */
interface Snapshot {
  clusters: Loadable<ClusterSummary[]>;
  services: Record<string, Loadable<ServiceSummary[]>>;
  expanded: Record<string, boolean>;
  cache: Record<string, CachedService>;
}

interface EcsState {
  /** The profile + region everything below belongs to. */
  ctx: AwsCtx | null;
  clusters: Loadable<ClusterSummary[]>;
  /** Services per cluster ARN, loaded when a cluster is expanded (or for the palette). */
  services: Record<string, Loadable<ServiceSummary[]>>;
  expanded: Record<string, boolean>;
  selected: ServiceRef | null;
  detail: Loadable<ServiceDetail>;
  tasks: Loadable<Task[]>;
  includeStopped: boolean;
  /** The services opened before, by cluster ARN and name. */
  cache: Record<string, CachedService>;
  /** What was loaded for the profiles + regions browsed before, by `ctxKey`. */
  kept: Record<string, Snapshot>;

  /**
   * Switches to `ctx` and loads its clusters. What was loaded for the profile + region left is
   * kept: coming back shows it at once and refreshes it in the background.
   */
  activate: (ctx: AwsCtx) => Promise<void>;
  /** Forgets everything loaded for the current profile + region (reload from scratch). */
  reset: () => void;
  /** Stops browsing (the profile isn't connected), keeping what was loaded for coming back. */
  leave: () => void;
  toggleCluster: (clusterArn: string) => Promise<void>;
  loadServices: (clusterArn: string) => Promise<void>;
  /** Loads the services of every cluster (for the palette). */
  loadAllServices: () => Promise<void>;
  openService: (service: ServiceRef) => Promise<void>;
  /** Shows no service (the last tab was closed). */
  closeService: () => void;
  /**
   * Reloads the open service's detail and tasks, keeping the old data visible meanwhile. `quiet`
   * (a background refresh) doesn't show it as loading.
   */
  refreshService: (options?: { quiet?: boolean }) => Promise<void>;
  setIncludeStopped: (include: boolean) => Promise<void>;
}

const EMPTY = {
  ctx: null,
  clusters: IDLE,
  services: {},
  expanded: {},
  selected: null,
  detail: IDLE,
  tasks: IDLE,
  cache: {},
} satisfies Partial<EcsState>;

export const useEcs = create<EcsState>((set, get) => {
  /** The snapshots, plus what is loaded for the current profile + region if it loaded fine. */
  function kept(): Record<string, Snapshot> {
    const { ctx, clusters, services, expanded, cache, kept } = get();
    if (!ctx || clusters.state !== "ok") return kept;
    return { ...kept, [ctxKey(ctx)]: { clusters, services, expanded, cache } };
  }

  /** Whether the answer to a call made for `ctx` still applies (the user may have switched). */
  const current = (ctx: AwsCtx) => {
    const now = get().ctx;
    return now !== null && ctxKey(now) === ctxKey(ctx);
  };

  async function loadServiceData(ctx: AwsCtx, service: ServiceRef, quiet: boolean) {
    if (!quiet) set((s) => ({ detail: loading(s.detail), tasks: loading(s.tasks) }));
    const includeStopped = get().includeStopped;
    const [detail, tasks] = await Promise.all([
      commands.describeService(ctx, service),
      commands.listTasks(ctx, service, includeStopped),
    ]);
    if (!current(ctx)) return;
    if (detail.status === "ok" && tasks.status === "ok") {
      const entry = {
        detail: detail.data,
        tasks: tasks.data,
        includeStopped,
        loadedAt: Date.now(),
      };
      set((s) => ({ cache: { ...s.cache, [serviceKey(service)]: entry } }));
    }
    if (!sameService(get().selected, service)) return;
    set((s) => ({ detail: settle(s.detail, detail), tasks: settle(s.tasks, tasks) }));
  }

  return {
    ...EMPTY,
    kept: {},
    includeStopped: true,

    activate: async (ctx) => {
      const previous = get().ctx;
      if (previous && ctxKey(previous) === ctxKey(ctx) && get().clusters.state !== "error") {
        return;
      }
      const all = kept();
      const snapshot = all[ctxKey(ctx)];
      if (snapshot) {
        // Shown at once; the clusters and the expanded clusters' services reload quietly
        // (`loading` keeps the data on screen).
        set({ ...EMPTY, ...snapshot, kept: all, ctx, clusters: loading(snapshot.clusters) });
        const result = await commands.listClusters(ctx);
        if (!current(ctx)) return;
        set((s) => ({ clusters: settle(s.clusters, result) }));
        const open = Object.keys(get().expanded).filter((arn) => get().expanded[arn]);
        await Promise.all(open.map((arn) => get().loadServices(arn)));
        return;
      }
      set({ ...EMPTY, kept: all, ctx, clusters: { state: "loading" } });
      const result = await commands.listClusters(ctx);
      if (!current(ctx)) return;
      set((s) => ({ clusters: settle(s.clusters, result) }));
      // Open the only cluster right away; with several, the user picks.
      if (result.status === "ok" && result.data.length === 1 && result.data[0]) {
        await get().toggleCluster(result.data[0].arn);
      }
    },

    reset: () => {
      const { ctx, kept } = get();
      const key = ctx ? ctxKey(ctx) : null;
      set({ ...EMPTY, kept: Object.fromEntries(Object.entries(kept).filter(([k]) => k !== key)) });
    },

    leave: () => set({ ...EMPTY, kept: kept() }),

    toggleCluster: async (clusterArn) => {
      const open = !get().expanded[clusterArn];
      set((s) => ({ expanded: { ...s.expanded, [clusterArn]: open } }));
      if (open && get().services[clusterArn]?.state !== "ok") {
        await get().loadServices(clusterArn);
      }
    },

    loadServices: async (clusterArn) => {
      const ctx = get().ctx;
      if (!ctx) return;
      set((s) => ({
        services: { ...s.services, [clusterArn]: loading(s.services[clusterArn] ?? IDLE) },
      }));
      const result = await commands.listServices(ctx, clusterArn);
      if (!current(ctx)) return;
      set((s) => ({
        services: {
          ...s.services,
          [clusterArn]: settle(s.services[clusterArn] ?? IDLE, result),
        },
      }));
    },

    loadAllServices: async () => {
      const clusters = get().clusters;
      if (clusters.state !== "ok") return;
      await Promise.all(
        clusters.data
          .filter((c) => get().services[c.arn]?.state !== "ok")
          .map((c) => get().loadServices(c.arn)),
      );
    },

    openService: async (service) => {
      const ctx = get().ctx;
      if (!ctx) return;
      const cached = get().cache[serviceKey(service)];
      set((s) => ({
        selected: service,
        detail: cached ? { state: "ok", data: cached.detail } : IDLE,
        tasks: cached ? { state: "ok", data: cached.tasks } : IDLE,
        expanded: { ...s.expanded, [service.clusterArn]: true },
      }));
      void usePrefs.getState().addRecent(ctx.profile, service);
      if (get().services[service.clusterArn]?.state !== "ok") {
        void get().loadServices(service.clusterArn);
      }
      // Seen a moment ago (switching tabs back and forth): no need to ask AWS again.
      const fresh =
        cached?.includeStopped === get().includeStopped && Date.now() - cached.loadedAt < FRESH_MS;
      if (!fresh) await loadServiceData(ctx, service, cached !== undefined);
    },

    closeService: () => set({ selected: null, detail: IDLE, tasks: IDLE }),

    refreshService: async (options) => {
      const { ctx, selected } = get();
      if (ctx && selected) await loadServiceData(ctx, selected, options?.quiet ?? false);
    },

    setIncludeStopped: async (includeStopped) => {
      set({ includeStopped });
      await get().refreshService();
    },
  };
});
