import { describe, expect, it } from "vitest";
import type { Endpoint, Route } from "@/bindings";
import { buildRouteGraph } from "./routes";

const endpoint = (kind: string, system: string, enabled = true): Endpoint => ({
  kind,
  system,
  enabled,
  properties: [],
});

const route = (index: number, topic: string, extra: Partial<Route> = {}): Route => ({
  index,
  topic,
  enabled: true,
  group: null,
  input: null,
  outputs: [],
  settings: [],
  ...extra,
});

describe("buildRouteGraph", () => {
  it("draws a system several routes write to as one node", () => {
    const billing = endpoint("mq", "Billing");
    const graph = buildRouteGraph([
      route(0, "orders.created", { group: "out", outputs: [billing] }),
      route(1, "orders.cancelled", { group: "out", outputs: [billing] }),
    ]);
    const targets = graph.nodes.filter((n) => n.column === 2);
    expect(targets).toEqual([
      expect.objectContaining({ label: "Billing", detail: "mq", routes: [0, 1], disabled: false }),
    ]);
    expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => n.detail)).toEqual([
      "out",
      "out",
    ]);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ["topic:orders.created", "system:2:mq|Billing"],
      ["topic:orders.cancelled", "system:2:mq|Billing"],
    ]);
  });

  it("marks switched-off routes and targets", () => {
    const graph = buildRouteGraph([
      route(0, "events", {
        input: endpoint("sftp", "Partner"),
        outputs: [endpoint("s3", "Archive"), endpoint("http", "Partner API", false)],
      }),
      route(1, "old", { enabled: false, outputs: [endpoint("s3", "Archive")] }),
    ]);
    const disabled = (label: string) => graph.nodes.find((n) => n.label === label)?.disabled;
    expect(disabled("Partner API")).toBe(true);
    // Still used by an active route.
    expect(disabled("Archive")).toBe(false);
    expect(disabled("old")).toBe(true);
    expect(graph.edges.find((e) => e.from === "topic:old")?.disabled).toBe(true);
    expect(graph.nodes.find((n) => n.label === "Partner")?.column).toBe(0);
  });

  it("adds the services on the other side of each topic", () => {
    const graph = buildRouteGraph(
      [route(0, "events", { outputs: [endpoint("s3", "Archive")] })],
      [
        { topic: "events", service: "ingest", direction: "in" },
        { topic: "events", service: "auditor", direction: "out" },
        { topic: "other", service: "unrelated", direction: "out" },
      ],
    );
    expect(graph.nodes.map((n) => [n.kind, n.label, n.column])).toEqual([
      ["topic", "events", 1],
      ["system", "Archive", 2],
      ["service", "ingest", 0],
      ["service", "auditor", 2],
    ]);
  });
});
