import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AwsCtx, ServiceRef } from "@/bindings";
import { contextLabels, MAX_TABS, useTabs, type Tab } from "./tabs";

vi.mock("@/bindings", () => ({ commands: { closeLogView: vi.fn(() => Promise.resolve()) } }));

const service = (name: string): ServiceRef => ({
  clusterArn: "arn:aws:ecs:eu-central-1:111122223333:cluster/demo",
  serviceName: name,
});

const DEV: AwsCtx = { profile: "dev", region: "eu-central-1" };
const PROD: AwsCtx = { profile: "prod", region: "eu-central-1" };

beforeEach(() => useTabs.setState({ tabs: [], activeKey: null }));

/** The service a tab shows (or the key of a trace tab). */
const name = (tab: Tab | null | undefined) =>
  tab?.kind === "service" ? tab.service.serviceName : tab?.key;

/** The logs store of a service tab. */
const logsOf = (tab: Tab | undefined) => (tab?.kind === "service" ? tab.logs : undefined);

describe("tabs", () => {
  it("opens a tab per service and reuses it", () => {
    const { activate } = useTabs.getState();
    activate(DEV, service("a"));
    activate(DEV, service("b"));
    activate(DEV, service("a"));
    const { tabs, activeKey } = useTabs.getState();
    expect(tabs.map(name)).toEqual(["a", "b"]);
    expect(activeKey).toBe(tabs[0]?.key);
  });

  it("closing the active tab shows its neighbour", () => {
    const { activate } = useTabs.getState();
    for (const name of ["a", "b", "c"]) activate(DEV, service(name));
    activate(DEV, service("b"));
    const next = useTabs.getState().close(useTabs.getState().activeKey ?? "");
    expect(name(next)).toBe("c");
    expect(name(useTabs.getState().close(next?.key ?? ""))).toBe("a");
    expect(useTabs.getState().close(useTabs.getState().tabs[0]?.key ?? "")).toBeNull();
    expect(useTabs.getState().activeKey).toBeNull();
  });

  it("closes the least recently used tab beyond the limit", () => {
    vi.useFakeTimers();
    const { activate } = useTabs.getState();
    for (let i = 0; i < MAX_TABS; i++) {
      vi.advanceTimersByTime(10);
      activate(DEV, service(`s${i}`));
    }
    vi.advanceTimersByTime(10);
    activate(DEV, service("s0"));
    vi.advanceTimersByTime(10);
    activate(DEV, service("new"));
    const names = useTabs.getState().tabs.map(name);
    expect(names).toHaveLength(MAX_TABS);
    expect(names).toContain("s0");
    expect(names).not.toContain("s1");
    vi.useRealTimers();
  });

  it("remembers a closed service's view for the session", () => {
    const { activate } = useTabs.getState();
    activate(DEV, service("a"));
    const first = logsOf(useTabs.getState().tabs[0]);
    first?.setState({
      tab: "logs",
      timeWindow: { kind: "last", minutes: 360 },
      search: { ...first.getState().search, query: "level:ERROR", regex: false },
      fieldsOpen: true,
      fieldsExpanded: ["log.logger"],
    });
    useTabs.getState().close(useTabs.getState().tabs[0]?.key ?? "");

    activate(DEV, service("a"));
    const reopened = logsOf(useTabs.getState().tabs[0])?.getState();
    expect(reopened?.tab).toBe("logs");
    expect(reopened?.timeWindow).toEqual({ kind: "last", minutes: 360 });
    expect(reopened?.search.query).toBe("level:ERROR");
    expect(reopened?.fieldsOpen).toBe(true);
    expect(reopened?.fieldsExpanded).toEqual(["log.logger"]);

    // Closing all tabs (switching profile or region) remembers their views too.
    reopened?.setTab("overview");
    useTabs.getState().closeAll();
    activate(DEV, service("a"));
    expect(logsOf(useTabs.getState().tabs[0])?.getState().tab).toBe("overview");
  });

  it("opens a trace tab per ID and cluster, next to the service tabs", () => {
    const { activate, openTrace } = useTabs.getState();
    activate(DEV, service("a"));
    const request = {
      id: "doc-1",
      term: "correlation:doc-1",
      at: "2026-01-15T12:00:00Z",
      clusterArn: service("a").clusterArn,
      origin: "a",
    };
    openTrace(DEV, request);
    activate(DEV, service("b"));
    openTrace(DEV, request);
    const { tabs, activeKey } = useTabs.getState();
    expect(tabs.map((t) => t.kind)).toEqual(["service", "trace", "service"]);
    expect(activeKey).toBe(tabs[1]?.key);

    // Closing it shows its neighbour; the service tabs keep running.
    expect(name(useTabs.getState().close(tabs[1]?.key ?? ""))).toBe("b");
    expect(logsOf(useTabs.getState().tabs[0])).toBeDefined();
  });

  it("keeps tabs of several profiles apart and closes those of other profiles on request", () => {
    const { activate, openRouteMap } = useTabs.getState();
    activate(DEV, service("a"));
    activate(PROD, service("a"));
    openRouteMap(PROD, service("a").clusterArn);
    expect(useTabs.getState().tabs.map((t) => t.ctx.profile)).toEqual(["dev", "prod", "prod"]);

    // The shown tab stays shown when it belongs to the profile kept…
    useTabs.getState().closeOutside(PROD);
    expect(useTabs.getState().tabs.map((t) => t.kind)).toEqual(["service", "routes"]);
    expect(useTabs.getState().activeKey).toBe(useTabs.getState().tabs[1]?.key);
    // …and none is shown when it was closed.
    useTabs.getState().closeOutside(DEV);
    expect(useTabs.getState().tabs).toEqual([]);
    expect(useTabs.getState().activeKey).toBeNull();
  });

  it("labels tabs by profile only when several are involved, with the region when needed", () => {
    const { activate } = useTabs.getState();
    activate(DEV, service("a"));
    expect(contextLabels(useTabs.getState().tabs, DEV).size).toBe(0);
    // Browsing another profile than the tab's is enough.
    expect([...contextLabels(useTabs.getState().tabs, PROD).values()]).toEqual(["dev", "prod"]);
    activate(PROD, service("b"));
    expect([...contextLabels(useTabs.getState().tabs, null).values()]).toEqual(["dev", "prod"]);
    activate({ profile: "prod", region: "us-east-1" }, service("c"));
    expect([...contextLabels(useTabs.getState().tabs, DEV).values()]).toEqual([
      "dev",
      "prod · eu-central-1",
      "prod · us-east-1",
    ]);
  });
});
