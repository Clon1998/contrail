import { describe, expect, it } from "vitest";
import type { Endpoint, ServiceTrace, TopicLink, TraceHop } from "@/bindings";
import { buildTraceGraph, hopTone } from "./traceGraph";

const at = "2026-01-15T12:00:00Z";

const hop = (
  service: string,
  topic: string,
  direction: "writes" | "reads",
  lastState: string,
): TraceHop => ({
  service,
  topic,
  direction,
  group: direction === "reads" ? service : null,
  events: 2,
  first: at,
  last: at,
  lastState,
});

const summary = (service: string, lastState: string | null): ServiceTrace => ({
  service,
  events: 2,
  first: at,
  last: at,
  lastState,
});

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

/** A document from an input service through a transformer to an output service. */
const hops = [
  hop("ingest", "raw", "writes", "PUBLISHED"),
  hop("enricher", "raw", "reads", "COMPLETED"),
  hop("enricher", "enriched", "writes", "PUBLISHED"),
  hop("feeder", "enriched", "reads", "RETRYING"),
];
const services = [
  summary("ingest", "PUBLISHED"),
  summary("enricher", "COMPLETED"),
  summary("feeder", "RETRYING"),
  summary("orders-api", null),
];

/** column, kind and label of each node, sorted by column. */
const shape = (graph: ReturnType<typeof buildTraceGraph>) =>
  graph.nodes
    .map((n) => [n.column, n.kind, n.label] as const)
    .sort((a, b) => a[0] - b[0] || a[2].localeCompare(b[2]));

describe("buildTraceGraph", () => {
  it("follows the document through a transformer, each hop in its state's colour", () => {
    const graph = buildTraceGraph(hops, services);
    expect(shape(graph)).toEqual([
      [0, "service", "ingest"],
      [1, "topic", "raw"],
      [2, "service", "enricher"],
      [3, "topic", "enriched"],
      [4, "service", "feeder"],
    ]);
    expect(graph.edges.map((e) => [e.from, e.to, e.tone])).toEqual([
      ["service:ingest", "topic:raw", "done"],
      ["topic:raw", "service:enricher", "done"],
      ["service:enricher", "topic:enriched", "done"],
      ["topic:enriched", "service:feeder", "waiting"],
    ]);
    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(node("service:feeder")?.state).toBe("RETRYING");
    expect(node("service:feeder")?.detail).toBe("group feeder");
    // The transformer's group comes from its reading hop, though its first hop is listed too.
    expect(node("service:enricher")?.detail).toBe("group enricher");
    // A service with no status event on a topic isn't drawn.
    expect(graph.others).toEqual(["orders-api"]);
  });

  it("adds systems and the readers that logged nothing from the route scan", () => {
    const graph = buildTraceGraph(hops, services, [
      link("ingest", "raw", "in", [endpoint("sftp", "Partner")]),
      link("archiver", "raw", "out", [endpoint("s3", "Archive")]),
      link("off", "raw", "out", [endpoint("http", "Old API")], false),
      link("feeder", "enriched", "out", [endpoint("http", "Catalog", false)]),
      link("unrelated", "other.topic", "out", []),
    ]);
    const node = (id: string) => graph.nodes.find((n) => n.id === id);
    expect(node("service:archiver")).toMatchObject({ missing: true, detail: "no event" });
    // A switched-off route isn't where the document went missing.
    expect(node("service:off")).toBeUndefined();
    expect(node("service:unrelated")).toBeUndefined();
    expect(node("system:source:sftp|Partner")?.column).toBe(0);
    // Targets line up in the last column, after the longest way.
    expect(node("system:target:s3|Archive")?.column).toBe(6);
    expect(node("system:target:http|Catalog")).toMatchObject({ column: 6, disabled: true });
    expect(graph.edges.find((e) => e.to === "service:archiver")).toMatchObject({
      tone: null,
      missing: true,
    });
    // So is the line on to its target.
    expect(graph.edges.find((e) => e.from === "service:archiver")?.missing).toBe(true);
    expect(graph.edges.find((e) => e.to === "service:feeder")?.missing).toBe(false);
  });
});

describe("hopTone", () => {
  it("tells done, waiting and failed hops apart", () => {
    expect(hopTone("COMPLETED")).toBe("done");
    expect(hopTone("published")).toBe("done");
    expect(hopTone("RETRYING")).toBe("waiting");
    expect(hopTone("CONSUMING")).toBe("waiting");
    expect(hopTone("FAILED")).toBe("failed");
  });
});
