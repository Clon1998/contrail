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

export function ctxKey(ctx: AwsCtx): string {
  return `${ctx.profile}|${ctx.region ?? ""}`;
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

  /** Switches to `ctx` (clearing everything if it changed) and loads its clusters. */
  activate: (ctx: AwsCtx) => Promise<void>;
  reset: () => void;
  toggleCluster: (clusterArn: string) => Promise<void>;
  loadServices: (clusterArn: string) => Promise<void>;
  /** Loads the services of every cluster (for the palette). */
  loadAllServices: () => Promise<void>;
  openService: (service: ServiceRef) => Promise<void>;
  /** Shows no service (the last tab was closed). */
  closeService: () => void;
  /** Reloads the open service's detail and tasks, keeping the old data visible meanwhile. */
  refreshService: () => Promise<void>;
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
} satisfies Partial<EcsState>;

export const useEcs = create<EcsState>((set, get) => {
  /** Whether the answer to a call made for `ctx` still applies (the user may have switched). */
  const current = (ctx: AwsCtx) => {
    const now = get().ctx;
    return now !== null && ctxKey(now) === ctxKey(ctx);
  };

  async function loadServiceData(ctx: AwsCtx, service: ServiceRef) {
    set((s) => ({ detail: loading(s.detail), tasks: loading(s.tasks) }));
    const [detail, tasks] = await Promise.all([
      commands.describeService(ctx, service),
      commands.listTasks(ctx, service, get().includeStopped),
    ]);
    if (!current(ctx) || !sameService(get().selected, service)) return;
    set((s) => ({ detail: settle(s.detail, detail), tasks: settle(s.tasks, tasks) }));
  }

  return {
    ...EMPTY,
    includeStopped: true,

    activate: async (ctx) => {
      const previous = get().ctx;
      if (previous && ctxKey(previous) === ctxKey(ctx) && get().clusters.state !== "error") {
        return;
      }
      set({ ...EMPTY, ctx, clusters: { state: "loading" } });
      const result = await commands.listClusters(ctx);
      if (!current(ctx)) return;
      set((s) => ({ clusters: settle(s.clusters, result) }));
      // Open the only cluster right away; with several, the user picks.
      if (result.status === "ok" && result.data.length === 1 && result.data[0]) {
        await get().toggleCluster(result.data[0].arn);
      }
    },

    reset: () => set(EMPTY),

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
      set((s) => ({
        selected: service,
        detail: IDLE,
        tasks: IDLE,
        expanded: { ...s.expanded, [service.clusterArn]: true },
      }));
      void usePrefs.getState().addRecent(ctx.profile, service);
      if (get().services[service.clusterArn]?.state !== "ok") {
        void get().loadServices(service.clusterArn);
      }
      await loadServiceData(ctx, service);
    },

    closeService: () => set({ selected: null, detail: IDLE, tasks: IDLE }),

    refreshService: async () => {
      const { ctx, selected } = get();
      if (ctx && selected) await loadServiceData(ctx, selected);
    },

    setIncludeStopped: async (includeStopped) => {
      set({ includeStopped });
      await get().refreshService();
    },
  };
});
