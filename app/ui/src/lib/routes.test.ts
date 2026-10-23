import { describe, expect, it } from "vitest";
import type { Endpoint, Route } from "@/bindings";
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

describe("buildRouteGraph", () => {
  it("draws a system several routes write to as one node", () => {
    const billing = endpoint("mq", "Billing");
    const graph = buildRouteGraph([
      route(0, "orders.created", { group: "out", outputs: [billing] }),
      route(1, "orders.cancelled", { group: "out", outputs: [billing] }),
    ]);
    const targets = graph.nodes.filter((n) => n.column === 3);
    expect(targets).toEqual([
      expect.objectContaining({ label: "Billing", detail: "mq", routes: [0, 1], disabled: false }),
    ]);
    // The service's own group once, not on every topic.
    expect(graph.ownGroup).toBe("out");
    expect(graph.nodes.filter((n) => n.kind === "topic").map((n) => n.detail)).toEqual([
      null,
      null,
    ]);
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([
      ["topic:orders.created", "system:3:mq|Billing"],
      ["topic:orders.cancelled", "system:3:mq|Billing"],
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
    expect(graph.nodes.find((n) => n.label === "Partner")?.column).toBe(1);
  });

  it("shows groups on topics only when the service's routes differ", () => {
    const graph = buildRouteGraph([
      route(0, "a", { group: "first" }),
      route(1, "b", { group: "second" }),
    ]);
    expect(graph.ownGroup).toBeNull();
    expect(graph.nodes.map((n) => n.detail)).toEqual(["group first", "group second"]);
  });

  it("adds the services on each topic, their groups and where they send the data", () => {
    const archive = endpoint("s3", "Archive");
    const graph = buildRouteGraph(
      [route(0, "events", { input: endpoint("sftp", "Partner") })],
      [
        {
          topic: "events",
          service: "archiver",
          direction: "out",
          group: "archiver",
          enabled: true,
          endpoints: [archive, endpoint("http", "Index")],
        },
        {
          topic: "events",
          service: "auditor",
          direction: "out",
          group: "auditor",
          enabled: true,
          endpoints: [archive],
        },
        {
          topic: "other",
          service: "unrelated",
          direction: "out",
          group: null,
          enabled: true,
          endpoints: [],
        },
      ],
    );
    expect(graph.nodes.map((n) => [n.column, n.kind, n.label, n.detail])).toEqual([
      [2, "topic", "events", null],
      [1, "system", "Partner", "sftp"],
      [3, "service", "archiver", "group archiver"],
      [4, "system", "Archive", "s3"],
      [4, "system", "Index", "http"],
      [3, "service", "auditor", "group auditor"],
    ]);
    // Both readers write to the same archive: one node, two lines into it.
    expect(graph.edges.filter((e) => e.to === "system:4:s3|Archive").map((e) => e.from)).toEqual([
      "service:3:archiver",
      "service:3:auditor",
    ]);
  });

  it("highlights the paths through a node, not its neighbours' other branches", () => {
    const graph = buildRouteGraph(
      [route(0, "events", { input: endpoint("sftp", "Partner") })],
      [
        {
          topic: "events",
          service: "archiver",
          direction: "out",
          group: null,
          enabled: true,
          endpoints: [endpoint("s3", "Archive")],
        },
        {
          topic: "events",
          service: "auditor",
          direction: "out",
          group: null,
          enabled: true,
          endpoints: [endpoint("http", "Index")],
        },
      ],
    );
    const path = pathThrough(graph, "service:3:archiver");
    expect([...path.nodes].sort()).toEqual([
      "service:3:archiver",
      "system:1:sftp|Partner",
      "system:4:s3|Archive",
      "topic:events",
    ]);
    expect(path.edges.has("topic:events->service:3:auditor")).toBe(false);
  });
});
