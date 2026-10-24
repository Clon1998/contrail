import { describe, expect, it } from "vitest";
import type { Endpoint, TopicLink } from "@/bindings";
import { buildClusterGraph, filterClusterGraph } from "./clusterGraph";

const endpoint = (kind: string, system: string, enabled = true): Endpoint => ({
  kind,
  system,
  enabled,
  properties: [],
});

const link = (
  service: string,
  topic: string,
  direction: "in" | "out",
  endpoints: Endpoint[],
  enabled = true,
): TopicLink => ({
  topic,
  service,
  direction,
  group: direction === "out" ? service : null,
  enabled,
  endpoints,
});

const archive = endpoint("s3", "Archive");
const links = [
  link("ingest", "raw", "in", [endpoint("sftp", "Partner")]),
  link("poller", "raw", "in", [endpoint("http", "Portal")]),
  link("archiver", "raw", "out", [archive]),
  link("feeder", "enriched", "out", [endpoint("http", "Catalog"), archive]),
  link("gateway", "orders", "out", [endpoint("mq", "Billing")], false),
];
const services = ["ingest", "poller", "archiver", "feeder", "gateway", "enricher", "api"];

describe("buildClusterGraph", () => {
  it("links the services by topic, with transformers entered by hand", () => {
    const graph = buildClusterGraph(
      links,
      {
        enricher: { reads: ["raw"], writes: ["enriched"] },
        // Not a service of this cluster.
        elsewhere: { reads: ["raw"], writes: ["other"] },
      },
      services,
    );
    const column = (id: string) => graph.nodes.find((n) => n.id === id)?.column;
    expect(column("system:source:sftp|Partner")).toBe(0);
    expect(column("service:ingest")).toBe(1);
    expect(column("topic:raw")).toBe(2);
    expect(column("service:enricher")).toBe(3);
    expect(column("topic:enriched")).toBe(4);
    expect(column("service:feeder")).toBe(5);
    expect(graph.nodes.find((n) => n.id === "service:enricher")).toMatchObject({
      transformer: true,
      detail: "transformer",
    });
    expect(graph.nodes.some((n) => n.label === "elsewhere")).toBe(false);
    // One archive, used by two services.
    expect(graph.nodes.filter((n) => n.label === "Archive")).toHaveLength(1);
    expect(graph.edges.filter((e) => e.to === "system:target:s3|Archive")).toHaveLength(2);
    // A switched-off route is drawn as off.
    expect(graph.nodes.find((n) => n.id === "service:gateway")?.disabled).toBe(true);
    expect(graph.nodes.find((n) => n.id === "topic:orders")?.disabled).toBe(true);
    expect(graph.leftOut).toEqual(["api"]);
  });

  it("finds a service with everything up- and downstream of it", () => {
    const graph = buildClusterGraph(
      links,
      { enricher: { reads: ["raw"], writes: ["enriched"] } },
      services,
    );
    const labels = (query: string) =>
      filterClusterGraph(graph, query)
        .nodes.map((n) => n.label)
        .sort();
    expect(labels("FEEDER")).toEqual([
      "Archive",
      "Catalog",
      "Partner",
      "Portal",
      "enriched",
      "enricher",
      "feeder",
      "ingest",
      "poller",
      "raw",
    ]);
    expect(labels("nothing")).toEqual([]);
    expect(filterClusterGraph(graph, " ").nodes).toHaveLength(graph.nodes.length);
  });
});
