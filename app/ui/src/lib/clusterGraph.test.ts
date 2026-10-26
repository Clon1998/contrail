import { describe, expect, it } from "vitest";
import type { Endpoint, TopicLink } from "@/bindings";
import {
  buildClusterGraph,
  filterClusterGraph,
  knownTransformers,
  routePath,
  scopeClusterGraph,
  withoutDisabled,
} from "./clusterGraph";

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
      origin: "manual",
    });
    expect(graph.nodes.find((n) => n.id === "service:feeder")?.origin).toBeNull();
    expect(graph.nodes.some((n) => n.label === "elsewhere")).toBe(false);
    // One archive, used by two services.
    expect(graph.nodes.filter((n) => n.label === "Archive")).toHaveLength(1);
    expect(graph.edges.filter((e) => e.to === "system:target:s3|Archive")).toHaveLength(2);
    // A switched-off route is drawn as off.
    expect(graph.nodes.find((n) => n.id === "service:gateway")?.disabled).toBe(true);
    expect(graph.nodes.find((n) => n.id === "topic:orders")?.disabled).toBe(true);
    expect(graph.leftOut).toEqual(["api"]);
  });

  it("draws transformers found in startup lines; entered by hand wins", () => {
    const found = (service: string, reads: string[], writes: string[]) => ({
      service,
      taskDefinition: `${service}:3`,
      taskId: "abc",
      startedAt: "2026-10-26T08:00:00Z",
      reads: reads.map((topic) => ({ topic, group: service, concurrency: 1 })),
      writes,
    });
    const known = knownTransformers(
      [found("enricher", ["raw"], ["enriched"]), found("api", ["orders"], ["raw"])],
      { api: { reads: ["orders"], writes: ["raw", "audit"] } },
    );
    expect(known).toEqual({
      enricher: { reads: ["raw"], writes: ["enriched"], origin: "logs" },
      api: { reads: ["orders"], writes: ["raw", "audit"], origin: "manual" },
    });
    const graph = buildClusterGraph(links, known, services);
    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(node("service:enricher")).toMatchObject({ transformer: true, origin: "logs" });
    expect(node("service:api")?.origin).toBe("manual");
    expect(graph.edges.some((e) => e.from === "service:api" && e.to === "topic:audit")).toBe(true);
    expect(graph.leftOut).toEqual([]);
  });

  it("leaves switched-off routes out on request", () => {
    const graph = buildClusterGraph(
      [...links, link("archiver", "raw", "out", [endpoint("http", "Old API", false)])],
      {},
      services,
    );
    const on = withoutDisabled(graph);
    const labels = on.nodes.map((n) => n.label);
    // The switched-off route service and its topic, and a switched-off target, are gone.
    expect(labels).not.toContain("gateway");
    expect(labels).not.toContain("orders");
    expect(labels).not.toContain("Old API");
    expect(labels).toContain("archiver");
    expect(on.edges.every((e) => !e.disabled)).toBe(true);
    const ids = new Set(on.nodes.map((n) => n.id));
    expect(on.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
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

  describe("one input service with two routes", () => {
    const property = (key: string, value: string, valueFrom: string | null = null) => ({
      key,
      value,
      variable: `ROUTES_0_INPUT_PROPERTIES_${key.toUpperCase()}`,
      valueFrom,
    });
    const crew: TopicLink[] = [
      link("crew-input", "crew.hotels", "in", [
        { ...endpoint("sftp", "Crew SFTP"), properties: [property("host", "sftp.crew.example")] },
      ]),
      link("crew-input", "crew.rosters", "in", [
        {
          ...endpoint("mq", "Crew MQ"),
          properties: [
            property("queue", "CREW.ROSTERS"),
            property("password", "", "arn:aws:ssm:x"),
          ],
        },
      ]),
      link("hotel-output", "crew.hotels", "out", [endpoint("kafka", "Hotels")]),
      link("roster-output", "crew.rosters", "out", [endpoint("s3", "Roster Archive")]),
    ];
    const graph = buildClusterGraph(crew, {}, ["crew-input", "hotel-output", "roster-output"]);
    const labels = (ids: Set<string>) =>
      [...ids].map((id) => graph.nodes.find((n) => n.id === id)?.label).sort();

    it("follows a target back through its own route only", () => {
      const { upstream, downstream } = routePath(graph, "system:target:kafka|Hotels");
      expect(labels(upstream.nodes)).toEqual([
        "Crew SFTP",
        "Hotels",
        "crew-input",
        "crew.hotels",
        "hotel-output",
      ]);
      expect(labels(downstream.nodes)).toEqual(["Hotels"]);
    });

    it("follows a source forward through its own route only", () => {
      const { downstream } = routePath(graph, "system:source:mq|Crew MQ");
      expect(labels(downstream.nodes)).toEqual([
        "Crew MQ",
        "Roster Archive",
        "crew-input",
        "crew.rosters",
        "roster-output",
      ]);
    });

    it("from the service itself, every route counts", () => {
      const { upstream, downstream } = routePath(graph, "service:crew-input");
      expect(labels(upstream.nodes)).toEqual(["Crew MQ", "Crew SFTP", "crew-input"]);
      expect(labels(downstream.nodes)).toEqual([
        "Hotels",
        "Roster Archive",
        "crew-input",
        "crew.hotels",
        "crew.rosters",
        "hotel-output",
        "roster-output",
      ]);
    });

    it("finds a route by its settings, never by a secret", () => {
      const byHost = filterClusterGraph(graph, "SFTP.CREW");
      expect(byHost.matches?.get("system:source:sftp|Crew SFTP")).toBe("host: sftp.crew.example");
      // The service has the same setting; the other route isn't on the way.
      expect(byHost.nodes.some((n) => n.label === "Roster Archive")).toBe(false);
      expect(filterClusterGraph(graph, "crew.rosters").matches?.get("topic:crew.rosters")).toBe(
        "name",
      );
      expect(filterClusterGraph(graph, "ssm").nodes).toEqual([]);
      expect(filterClusterGraph(graph, "password").nodes).toEqual([]);
    });

    it("shows only one side of a node on request", () => {
      const only = (scope: "path" | "upstream" | "downstream") =>
        scopeClusterGraph(graph, "topic:crew.hotels", scope)
          .nodes.map((n) => n.label)
          .sort();
      expect(only("upstream")).toEqual(["Crew SFTP", "crew-input", "crew.hotels"]);
      expect(only("downstream")).toEqual(["Hotels", "crew.hotels", "hotel-output"]);
      expect(only("path")).toHaveLength(5);
    });
  });
});
