import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRef } from "@/bindings";
import { MAX_TABS, useTabs, type Tab } from "./tabs";

vi.mock("@/bindings", () => ({ commands: { closeLogView: vi.fn(() => Promise.resolve()) } }));

const service = (name: string): ServiceRef => ({
  clusterArn: "arn:aws:ecs:eu-central-1:111122223333:cluster/demo",
  serviceName: name,
});

beforeEach(() => useTabs.setState({ tabs: [], activeKey: null }));

/** The service a tab shows (or the key of a trace tab). */
const name = (tab: Tab | null | undefined) =>
  tab?.kind === "service" ? tab.service.serviceName : tab?.key;

/** The logs store of a service tab. */
const logsOf = (tab: Tab | undefined) => (tab?.kind === "service" ? tab.logs : undefined);

describe("tabs", () => {
  it("opens a tab per service and reuses it", () => {
    const { activate } = useTabs.getState();
    activate(service("a"));
    activate(service("b"));
    activate(service("a"));
    const { tabs, activeKey } = useTabs.getState();
    expect(tabs.map(name)).toEqual(["a", "b"]);
    expect(activeKey).toBe(tabs[0]?.key);
  });

  it("closing the active tab shows its neighbour", () => {
    const { activate } = useTabs.getState();
    for (const name of ["a", "b", "c"]) activate(service(name));
    activate(service("b"));
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
      activate(service(`s${i}`));
    }
    vi.advanceTimersByTime(10);
    activate(service("s0"));
    vi.advanceTimersByTime(10);
    activate(service("new"));
    const names = useTabs.getState().tabs.map(name);
    expect(names).toHaveLength(MAX_TABS);
    expect(names).toContain("s0");
    expect(names).not.toContain("s1");
    vi.useRealTimers();
  });

  it("remembers a closed service's view for the session", () => {
    const { activate } = useTabs.getState();
    activate(service("a"));
    const first = logsOf(useTabs.getState().tabs[0]);
    first?.setState({
      tab: "logs",
      timeWindow: { kind: "last", minutes: 360 },
      search: { ...first.getState().search, query: "level:ERROR", regex: false },
    });
    useTabs.getState().close(useTabs.getState().tabs[0]?.key ?? "");

    activate(service("a"));
    const reopened = logsOf(useTabs.getState().tabs[0])?.getState();
    expect(reopened?.tab).toBe("logs");
    expect(reopened?.timeWindow).toEqual({ kind: "last", minutes: 360 });
    expect(reopened?.search.query).toBe("level:ERROR");

    // Switching profile or region closes all tabs; their views are remembered too.
    reopened?.setTab("overview");
    useTabs.getState().closeAll();
    activate(service("a"));
    expect(logsOf(useTabs.getState().tabs[0])?.getState().tab).toBe("overview");
  });

  it("opens a trace tab per ID and cluster, next to the service tabs", () => {
    const { activate, openTrace } = useTabs.getState();
    activate(service("a"));
    const request = {
      id: "doc-1",
      term: "correlation:doc-1",
      at: "2026-01-15T12:00:00Z",
      clusterArn: service("a").clusterArn,
      origin: "a",
    };
    openTrace(request);
    activate(service("b"));
    openTrace(request);
    const { tabs, activeKey } = useTabs.getState();
    expect(tabs.map((t) => t.kind)).toEqual(["service", "trace", "service"]);
    expect(activeKey).toBe(tabs[1]?.key);

    // Closing it shows its neighbour; the service tabs keep running.
    expect(name(useTabs.getState().close(tabs[1]?.key ?? ""))).toBe("b");
    expect(logsOf(useTabs.getState().tabs[0])).toBeDefined();
  });
});
