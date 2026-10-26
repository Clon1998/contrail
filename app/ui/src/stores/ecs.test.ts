import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/bindings";
import { installFakeBackend, uninstallFakeBackend } from "@/e2e/fakeBackend";
import { EMPTY_PREFS, usePrefs } from "./prefs";
import { FRESH_MS, useEcs } from "./ecs";

const DEV = { profile: "demo-dev", region: null };
const CORE = "arn:aws:ecs:eu-central-1:111122223333:cluster/demo-core";

const initial = useEcs.getState();

beforeEach(() => {
  useEcs.setState(initial, true);
  usePrefs.setState({ prefs: EMPTY_PREFS });
  installFakeBackend();
});

afterEach(() => {
  uninstallFakeBackend();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ecs store", () => {
  it("loads clusters, then services when a cluster is expanded", async () => {
    await useEcs.getState().activate(DEV);
    const clusters = useEcs.getState().clusters;
    expect(clusters.state === "ok" && clusters.data.map((c) => c.name)).toEqual([
      "demo-batch",
      "demo-core",
      "demo-edge",
    ]);

    await useEcs.getState().toggleCluster(CORE);
    const services = useEcs.getState().services[CORE];
    expect(services?.state === "ok" && services.data.map((s) => s.name)).toEqual([
      "billing-sync",
      "orders-api",
      "payments-worker",
    ]);
  });

  it("opens a service with detail and tasks, and records it as recent", async () => {
    await useEcs.getState().activate(DEV);
    await useEcs.getState().openService({ clusterArn: CORE, serviceName: "payments-worker" });

    const { detail, tasks, expanded } = useEcs.getState();
    expect(detail.state === "ok" && detail.data.summary.name).toBe("payments-worker");
    expect(
      tasks.state === "ok" && tasks.data.filter((t) => t.lastStatus === "STOPPED"),
    ).toHaveLength(3);
    expect(expanded[CORE]).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usePrefs.getState().prefs.recent[0]?.serviceName).toBe("payments-worker");
  });

  it("shows a service opened before right away and loads it again only when it's old", async () => {
    const orders = { clusterArn: CORE, serviceName: "orders-api" };
    const payments = { clusterArn: CORE, serviceName: "payments-worker" };
    await useEcs.getState().activate(DEV);
    await useEcs.getState().openService(orders);
    await useEcs.getState().openService(payments);
    const describe = vi.spyOn(commands, "describeService");

    // Back to a tab seen a moment ago: its data is there at once, AWS isn't asked again.
    const reopened = useEcs.getState().openService(orders);
    const { detail } = useEcs.getState();
    expect(detail.state === "ok" && detail.data.summary.name).toBe("orders-api");
    await reopened;
    expect(describe).not.toHaveBeenCalled();

    // Older data is shown too, and refreshed without showing it as loading.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + FRESH_MS + 1);
    const refreshed = useEcs.getState().openService(payments);
    expect(useEcs.getState().detail.state).toBe("ok");
    await refreshed;
    expect(describe).toHaveBeenCalledTimes(1);
  });

  it("refreshes quietly in the background, visibly on request", async () => {
    await useEcs.getState().activate(DEV);
    await useEcs.getState().openService({ clusterArn: CORE, serviceName: "orders-api" });
    const quiet = useEcs.getState().refreshService({ quiet: true });
    expect(useEcs.getState().detail.state).toBe("ok");
    await quiet;
    const visible = useEcs.getState().refreshService();
    expect(useEcs.getState().detail.state).toBe("loading");
    await visible;
    expect(useEcs.getState().detail.state).toBe("ok");
  });

  it("hides stopped tasks on request", async () => {
    await useEcs.getState().activate(DEV);
    await useEcs.getState().openService({ clusterArn: CORE, serviceName: "payments-worker" });
    await useEcs.getState().setIncludeStopped(false);
    const tasks = useEcs.getState().tasks;
    expect(tasks.state === "ok" && tasks.data.every((t) => t.lastStatus !== "STOPPED")).toBe(true);
  });

  it("starts over when the profile or region changes", async () => {
    await useEcs.getState().activate(DEV);
    await useEcs.getState().toggleCluster(CORE);
    await useEcs.getState().activate({ profile: "demo-dev", region: "us-west-2" });

    const state = useEcs.getState();
    expect(state.expanded).toEqual({});
    expect(state.clusters.state === "ok" && state.clusters.data[0]?.arn).toContain("us-west-2");
  });

  it("reports expired credentials", async () => {
    await useEcs.getState().activate({ profile: "demo-prod", region: null });
    const clusters = useEcs.getState().clusters;
    expect(clusters.state === "error" && clusters.error.code).toBe("credentials");
  });
});
