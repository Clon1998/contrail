import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceRef } from "@/bindings";
import { MAX_TABS, useTabs } from "./tabs";

vi.mock("@/bindings", () => ({ commands: { closeLogView: vi.fn(() => Promise.resolve()) } }));

const service = (name: string): ServiceRef => ({
  clusterArn: "arn:aws:ecs:eu-central-1:111122223333:cluster/demo",
  serviceName: name,
});

beforeEach(() => useTabs.setState({ tabs: [], activeKey: null }));

describe("tabs", () => {
  it("opens a tab per service and reuses it", () => {
    const { activate } = useTabs.getState();
    activate(service("a"));
    activate(service("b"));
    activate(service("a"));
    const { tabs, activeKey } = useTabs.getState();
    expect(tabs.map((t) => t.service.serviceName)).toEqual(["a", "b"]);
    expect(activeKey).toBe(tabs[0]?.key);
  });

  it("closing the active tab shows its neighbour", () => {
    const { activate } = useTabs.getState();
    for (const name of ["a", "b", "c"]) activate(service(name));
    activate(service("b"));
    const next = useTabs.getState().close(useTabs.getState().activeKey ?? "");
    expect(next?.service.serviceName).toBe("c");
    expect(useTabs.getState().close(next?.key ?? "")?.service.serviceName).toBe("a");
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
    const names = useTabs.getState().tabs.map((t) => t.service.serviceName);
    expect(names).toHaveLength(MAX_TABS);
    expect(names).toContain("s0");
    expect(names).not.toContain("s1");
    vi.useRealTimers();
  });

  it("remembers a closed service's view for the session", () => {
    const { activate } = useTabs.getState();
    activate(service("a"));
    const first = useTabs.getState().tabs[0]?.logs;
    first?.setState({
      tab: "logs",
      timeWindow: { kind: "last", minutes: 360 },
      search: { ...first.getState().search, query: "level:ERROR", regex: false },
    });
    useTabs.getState().close(useTabs.getState().tabs[0]?.key ?? "");

    activate(service("a"));
    const reopened = useTabs.getState().tabs[0]?.logs.getState();
    expect(reopened?.tab).toBe("logs");
    expect(reopened?.timeWindow).toEqual({ kind: "last", minutes: 360 });
    expect(reopened?.search.query).toBe("level:ERROR");

    // Switching profile or region closes all tabs; their views are remembered too.
    reopened?.setTab("overview");
    useTabs.getState().closeAll();
    activate(service("a"));
    expect(useTabs.getState().tabs[0]?.logs.getState().tab).toBe("overview");
  });
});
