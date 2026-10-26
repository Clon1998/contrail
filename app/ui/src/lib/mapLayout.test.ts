import { describe, expect, it } from "vitest";
import type { Endpoint, TopicLink } from "@/bindings";
import { buildClusterGraph } from "./clusterGraph";
import { layoutClusterGraph, nodeWidth, toElkGraph } from "./mapLayout";

const endpoint = (kind: string, system: string): Endpoint => ({
  kind,
  system,
  enabled: true,
  properties: [],
});

const link = (service: string, topic: string, direction: "in" | "out", e: Endpoint): TopicLink => ({
  topic,
  service,
  direction,
  group: null,
  enabled: true,
  endpoints: [e],
});

const graph = buildClusterGraph(
  [
    link("ingest", "raw", "in", endpoint("sftp", "Partner")),
    link("feeder", "enriched", "out", endpoint("http", "Catalog")),
  ],
  { enricher: { reads: ["raw"], writes: ["enriched"] } },
  ["ingest", "feeder", "enricher"],
);

describe("map layout", () => {
  it("gives ELK every node with its size and every line", () => {
    const elk = toElkGraph(graph);
    expect(elk.children).toHaveLength(graph.nodes.length);
    expect(elk.edges).toHaveLength(graph.edges.length);
    expect(elk.layoutOptions?.["elk.direction"]).toBe("RIGHT");
    const topic = elk.children?.find((c) => c.id === "topic:raw");
    expect(topic?.width).toBe(nodeWidth({ kind: "topic", label: "raw" }));
  });

  it("keeps node widths within limits", () => {
    expect(nodeWidth({ kind: "service", label: "a" })).toBe(140);
    expect(nodeWidth({ kind: "topic", label: "x".repeat(200) })).toBe(300);
  });

  it("lays the chain out from left to right", async () => {
    const positions = await layoutClusterGraph(graph);
    const x = (id: string) => positions.get(id)?.x ?? Number.NaN;
    const chain = [
      "system:source:sftp|Partner",
      "service:ingest",
      "topic:raw",
      "service:enricher",
      "topic:enriched",
      "service:feeder",
      "system:target:http|Catalog",
    ];
    for (let i = 1; i < chain.length; i++) {
      expect(x(chain[i] ?? "")).toBeGreaterThan(x(chain[i - 1] ?? ""));
    }
  });

  it("lays out a big cluster quickly (120 route services)", async () => {
    const links: TopicLink[] = [];
    for (let i = 0; i < 60; i++) {
      links.push(link(`in-${i}`, `topic.${i % 40}`, "in", endpoint("sftp", `Source ${i % 25}`)));
      links.push(link(`out-${i}`, `topic.${i % 40}`, "out", endpoint("http", `Target ${i % 30}`)));
    }
    const big = buildClusterGraph(links, {}, []);
    const started = performance.now();
    const positions = await layoutClusterGraph(big);
    expect(positions.size).toBe(big.nodes.length);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
