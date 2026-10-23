import { describe, expect, it } from "vitest";
import type { Endpoint, Route, TopicLink } from "@/bindings";
import { buildRouteGraph, pathThrough } from "./routes";

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

const link = (
  service: string,
  direction: "in" | "out",
  endpoints: Endpoint[],
  extra: Partial<TopicLink> = {},
): TopicLink => ({
  topic: "events",
  service,
  direction,
  group: direction === "out" ? service : null,
  enabled: true,
  endpoints,
  ...extra,
});

/** column, kind, label and detail of each node, for compact expectations. */
const shape = (graph: ReturnType<typeof buildRouteGraph>) =>
  graph.nodes.map((n) => [n.column, n.kind, n.label, n.detail]);

describe("buildRouteGraph", () => {
  it("draws an output service between its topics and its systems, each system once", () => {
    const billing = endpoint("mq", "Billing");
    const graph = buildRouteGraph("gateway", [
      route(0, "orders.created", { group: "gateway", outputs: [billing] }),
      route(1, "orders.cancelled", { group: "gateway", outputs: [billing] }),
    ]);
    expect(graph.direction).toBe("out");
    expect(graph.ownGroup).toBe("gateway");
    expect(shape(graph)).toEqual([
      [2, "topic", "orders.created", null],
      [3, "service", "gateway", "group gateway"],
      [4, "system", "Billing", "mq"],
      [2, "topic", "orders.cancelled", null],
    ]);
    expect(graph.nodes.find((n) => n.id === graph.selfId)?.self).toBe(true);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ["topic:orders.created", "service:3:gateway"],
      ["service:3:gateway", "system:4:mq|Billing"],
      ["topic:orders.cancelled", "service:3:gateway"],
    ]);
  });

  it("draws an input service between its systems and its topics", () => {
    const graph = buildRouteGraph("ingest", [
      route(0, "events", { input: endpoint("sftp", "Partner") }),
    ]);
    expect(graph.direction).toBe("in");
    expect(shape(graph)).toEqual([
      [2, "topic", "events", null],
      [1, "service", "ingest", null],
      [0, "system", "Partner", "sftp"],
    ]);
  });

  it("shows groups on topics only when the service's routes differ", () => {
    const graph = buildRouteGraph("out", [
      route(0, "a", { group: "first" }),
      route(1, "b", { group: "second" }),
    ]);
    expect(graph.ownGroup).toBeNull();
    expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => n.detail)).toEqual([
      "group first",
      "group second",
    ]);
  });

  it("marks switched-off routes and targets", () => {
    const graph = buildRouteGraph("gateway", [
      route(0, "events", {
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
  });

  it("puts the other services next to the shown one, each with its own systems", () => {
    const archive = endpoint("s3", "Archive");
    const graph = buildRouteGraph(
      "ingest",
      [route(0, "events", { input: endpoint("sftp", "Partner") })],
      [
        link("archiver", "out", [archive, endpoint("http", "Index")]),
        link("auditor", "out", [archive]),
        link("poller", "in", [endpoint("http", "Portal")]),
        link("unrelated", "out", [], { topic: "other" }),
      ],
    );
    expect(shape(graph)).toEqual([
      [2, "topic", "events", null],
      [1, "service", "ingest", null],
      [0, "system", "Partner", "sftp"],
      [3, "service", "archiver", "group archiver"],
      [4, "system", "Archive", "s3"],
      [4, "system", "Index", "http"],
      [3, "service", "auditor", "group auditor"],
      // Another input service writing the same topic sits next to the shown one.
      [1, "service", "poller", null],
      [0, "system", "Portal", "http"],
    ]);
    // Both readers write to the same archive: one node, two lines into it.
    expect(graph.edges.filter((e) => e.to === "system:4:s3|Archive").map((e) => e.from)).toEqual([
      "service:3:archiver",
      "service:3:auditor",
    ]);
  });
});

describe("pathThrough", () => {
  it("follows the shown service's data, not its neighbours' other branches", () => {
    const graph = buildRouteGraph(
      "gateway",
      [route(0, "events", { group: "gateway", outputs: [endpoint("s3", "Archive")] })],
      [
        link("ingest", "in", [endpoint("sftp", "Partner")]),
        link("auditor", "out", [endpoint("http", "Index")]),
      ],
    );
    const path = pathThrough(graph, graph.selfId);
    expect([...path.nodes].sort()).toEqual([
      "service:1:ingest",
      "service:3:gateway",
      "system:0:sftp|Partner",
      "system:4:s3|Archive",
      "topic:events",
    ]);
    // The other reader of the same topic isn't on the way.
    expect(path.edges.has("topic:events->service:3:auditor")).toBe(false);
  });
});
