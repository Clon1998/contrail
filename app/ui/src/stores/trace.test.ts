import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Trace } from "@/bindings";
import { commands } from "@/bindings";
import { createTraceStore } from "./trace";

vi.mock("@/bindings", () => ({ commands: { traceId: vi.fn() } }));

const ctx = { profile: "demo-dev", region: null };
const request = {
  id: "doc-1",
  term: "correlation:doc-1",
  at: "2026-01-15T12:00:00Z",
  clusterArn: "arn:aws:ecs:eu-central-1:111122223333:cluster/demo",
  origin: "orders-api",
};
const trace: Trace = {
  hits: [],
  services: [],
  hops: [],
  outcome: "open",
  truncated: false,
  failures: [],
};

beforeEach(() => vi.mocked(commands.traceId).mockReset());

describe("trace store", () => {
  it("starts with the service it came from, searching ±1 h around the event", async () => {
    vi.mocked(commands.traceId).mockResolvedValue({ status: "ok", data: trace });
    const store = createTraceStore(request);
    store.getState().toggleService("payments-worker", true);
    await store.getState().search(ctx);

    expect(commands.traceId).toHaveBeenCalledWith(
      ctx,
      [
        { clusterArn: request.clusterArn, serviceName: "orders-api" },
        { clusterArn: request.clusterArn, serviceName: "payments-worker" },
      ],
      "doc-1",
      { kind: "range", from: "2026-01-15T11:00:00.000Z", to: "2026-01-15T13:00:00.000Z" },
      false,
    );
    // The result replaces the service picker.
    expect(store.getState().result).toEqual({ kind: "done", trace });
    expect(store.getState().pickerOpen).toBe(false);
  });

  it("keeps only the newest search's result", async () => {
    let finishFirst: (value: Awaited<ReturnType<typeof commands.traceId>>) => void = () => {};
    vi.mocked(commands.traceId)
      .mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce({ status: "ok", data: { ...trace, outcome: "failed" } });
    const store = createTraceStore(request);
    const first = store.getState().search(ctx);
    await store.getState().search(ctx);
    finishFirst({ status: "ok", data: trace });
    await first;
    expect(store.getState().result).toMatchObject({ kind: "done", trace: { outcome: "failed" } });
  });
});
