import { describe, expect, it } from "vitest";
import type { Endpoint, Route, TopicLink } from "@/bindings";
import { buildRouteGraph, filterRouteGraph, layerColumns, pathThrough } from "./routes";

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
  rawTopic: false,
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
  raw: false,
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
      [2, "topic", "orders.created", "integration"],
      [3, "service", "gateway", "group gateway"],
      [4, "system", "Billing", "mq"],
      [2, "topic", "orders.cancelled", "integration"],
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
      [2, "topic", "events", "integration"],
      [1, "service", "ingest", null],
      [0, "system", "Partner", "sftp"],
    ]);
  });

  it("keeps a plain Kafka topic apart from the integration topic of the same name", () => {
    const graph = buildRouteGraph(
      "mirror",
      [route(0, "events", { rawTopic: true, group: "mirror" })],
      [
        link("ingest", "in", []),
        link("archiver", "out", []),
        link("raw-reader", "out", [], { raw: true }),
      ],
    );
    // Only the other reader of the plain topic joins; the integration topic's services don't.
    expect(shape(graph)).toEqual([
      [2, "topic", "events", "kafka"],
      [3, "service", "mirror", "group mirror"],
      [3, "service", "raw-reader", "group raw-reader"],
    ]);
    expect(graph.nodes[0]?.id).toBe("topic:kafka:events");
  });

  it("shows groups on topics only when the service's routes differ", () => {
    const graph = buildRouteGraph("out", [
      route(0, "a", { group: "first" }),
      route(1, "b", { group: "second" }),
    ]);
    expect(graph.ownGroup).toBeNull();
    expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => n.detail)).toEqual([
      "integration · group first",
      "integration · group second",
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
      [2, "topic", "events", "integration"],
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

describe("filterRouteGraph", () => {
  const routes = [
    route(0, "events", {
      outputs: [
        {
          ...endpoint("sftp", "Archive"),
          properties: [
            { key: "host", value: "files.example.com", valueFrom: null, variable: "R0_HOST" },
          ],
        },
      ],
    }),
    route(1, "orders", { outputs: [endpoint("http", "Index")] }),
  ];
  const graph = buildRouteGraph("gateway", routes, [
    link("ingest", "in", [endpoint("sftp", "Partner")]),
  ]);
  const labels = (g: typeof graph) => g.nodes.map((n) => n.label).sort();

  it("keeps the paths through a node matching by name, and says what matched", () => {
    const { graph: found, matches } = filterRouteGraph(graph, routes, "ORDERS");
    // The other route of the service stays out.
    expect(labels(found)).toEqual(["Index", "gateway", "orders"]);
    expect([...matches]).toEqual([["topic:orders", "name"]]);
    expect(found.edges.every((e) => found.nodes.some((n) => n.id === e.to))).toBe(true);
  });

  it("finds a system by a setting of the routes to it", () => {
    const { graph: found, matches } = filterRouteGraph(graph, routes, "files.example");
    expect(labels(found)).toEqual(["Archive", "Partner", "events", "gateway", "ingest"]);
    expect([...matches.values()]).toEqual(["host: files.example.com"]);
  });

  it("finds an integration topic by its name on Kafka", () => {
    const { matches } = filterRouteGraph(graph, routes, "integration.orders");
    expect([...matches.keys()]).toEqual(["topic:orders"]);
  });

  it("keeps the whole graph without a query, and nothing when nothing matches", () => {
    expect(filterRouteGraph(graph, routes, "  ").graph).toBe(graph);
    expect(filterRouteGraph(graph, routes, "nope").graph.nodes).toEqual([]);
  });
});

describe("layerColumns", () => {
  const edges = (pairs: [string, string][]) => pairs.map(([from, to]) => ({ from, to }));

  it("puts each node right of the furthest node leading to it", () => {
    // source → input → topic A → transformer → topic B → output → target, and a reader of A.
    const columns = layerColumns(
      ["source", "input", "a", "transformer", "b", "output", "reader", "target"],
      edges([
        ["source", "input"],
        ["input", "a"],
        ["a", "transformer"],
        ["transformer", "b"],
        ["b", "output"],
        ["a", "reader"],
        ["output", "target"],
      ]),
    );
    expect(Object.fromEntries(columns)).toEqual({
      source: 0,
      input: 1,
      a: 2,
      transformer: 3,
      reader: 3,
      b: 4,
      output: 5,
      target: 6,
    });
  });

  it("moves a start right, next to where it leads", () => {
    // A topic only one late service reads.
    const columns = layerColumns(
      ["input", "a", "reader", "b", "late", "only-read"],
      edges([
        ["input", "a"],
        ["a", "reader"],
        ["reader", "b"],
        ["b", "late"],
        ["only-read", "late"],
      ]),
    );
    expect(columns.get("late")).toBe(4);
    expect(columns.get("only-read")).toBe(3);
    expect(columns.get("input")).toBe(0);
  });

  it("lines up targets in the last column", () => {
    const columns = layerColumns(
      ["input", "a", "reader", "early", "b", "output", "late"],
      edges([
        ["input", "a"],
        ["a", "reader"],
        ["reader", "early"],
        ["a", "b"],
        ["b", "output"],
        ["output", "late"],
      ]),
      new Set(["early", "late"]),
    );
    expect(columns.get("early")).toBe(4);
    expect(columns.get("late")).toBe(4);
  });

  it("stops on a cycle", () => {
    const columns = layerColumns(
      ["service", "topic"],
      edges([
        ["service", "topic"],
        ["topic", "service"],
      ]),
    );
    // Finite: a few columns, not one per round of an endless loop.
    expect(columns.size).toBe(2);
    expect(Math.max(...columns.values())).toBeLessThan(10);
  });
});
