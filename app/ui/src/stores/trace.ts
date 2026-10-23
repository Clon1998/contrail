import { createStore, type StoreApi } from "zustand/vanilla";
import { commands, type ApiError, type AwsCtx, type Trace, type TraceHit } from "@/bindings";

/** How far around the event's time the services are searched, in minutes. */
export const TRACE_SPANS = [15, 60, 360] as const;

/** What a trace follows: one ID, found in one service's event. */
export interface TraceRequest {
  /** A document's correlation ID or an API's trace ID. */
  id: string;
  /** The search that lists the ID in one service (`correlation:<id>` or the quoted ID). */
  term: string;
  /** The time of the event the trace started from (ISO 8601). */
  at: string;
  clusterArn: string;
  /** The service the trace started from. */
  origin: string;
}

export type TraceResult =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "done"; trace: Trace }
  | { kind: "error"; error: ApiError };

export interface TraceState {
  request: TraceRequest;
  /** The services to search. */
  chosen: string[];
  /** Minutes before and after the event. */
  span: number;
  /** Search with Logs Insights instead of FilterLogEvents. */
  insights: boolean;
  result: TraceResult;
  /** Show only this service's events (a click on it in the path), or all. */
  only: string | null;
  /** Expanded events, by `hitKey`. */
  expanded: Record<string, boolean>;
  /** The service picker is shown (until the first result, then on request). */
  pickerOpen: boolean;

  toggleService: (name: string, on: boolean) => void;
  setChosen: (names: string[]) => void;
  setSpan: (minutes: number) => void;
  setInsights: (on: boolean) => void;
  setOnly: (service: string | null) => void;
  toggleExpanded: (key: string) => void;
  setPickerOpen: (open: boolean) => void;
  search: (ctx: AwsCtx) => Promise<void>;
}

/** Identifies an event of a trace (sequence numbers are per service). */
export function hitKey(hit: TraceHit): string {
  return `${hit.service}-${hit.event.seq}-${hit.event.cwTimestamp}`;
}

/**
 * The state of one trace tab. A store per tab (like the logs store of a service tab), so the
 * result, the chosen services and the expanded events survive switching tabs.
 */
export function createTraceStore(request: TraceRequest): StoreApi<TraceState> {
  // Only the latest search may set the result (an older one can finish later).
  let run = 0;
  return createStore<TraceState>((set, get) => ({
    request,
    chosen: [request.origin],
    span: 60,
    insights: false,
    result: { kind: "idle" },
    only: null,
    expanded: {},
    pickerOpen: true,

    toggleService: (name, on) =>
      set((s) => ({
        chosen: on
          ? [...s.chosen.filter((n) => n !== name), name]
          : s.chosen.filter((n) => n !== name),
      })),
    setChosen: (chosen) => set({ chosen }),
    setSpan: (span) => set({ span }),
    setInsights: (insights) => set({ insights }),
    setOnly: (only) => set({ only }),
    toggleExpanded: (key) => set((s) => ({ expanded: { ...s.expanded, [key]: !s.expanded[key] } })),
    setPickerOpen: (pickerOpen) => set({ pickerOpen }),

    search: async (ctx) => {
      const { request, chosen, span, insights } = get();
      const current = ++run;
      set({ result: { kind: "loading" } });
      const time = Date.parse(request.at);
      const result = await commands.traceId(
        ctx,
        chosen.map((serviceName) => ({ clusterArn: request.clusterArn, serviceName })),
        request.id,
        {
          kind: "range",
          from: new Date(time - span * 60_000).toISOString(),
          to: new Date(time + span * 60_000).toISOString(),
        },
        insights,
      );
      if (current !== run) return;
      if (result.status === "ok") {
        set({
          result: { kind: "done", trace: result.data },
          pickerOpen: false,
          only: null,
          expanded: {},
        });
      } else {
        set({ result: { kind: "error", error: result.error } });
      }
    },
  }));
}
