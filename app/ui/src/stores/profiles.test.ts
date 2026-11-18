import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "@/bindings";
import { installFakeBackend, uninstallFakeBackend } from "@/e2e/fakeBackend";
import { EMPTY_PREFS, usePrefs } from "./prefs";
import { currentRegion, IDENTITY_FRESH_MS, useProfiles } from "./profiles";

const initial = useProfiles.getState();

beforeEach(() => {
  // zustand stores are module singletons: reset to the initial state between tests.
  useProfiles.setState(initial, true);
  usePrefs.setState({ prefs: EMPTY_PREFS });
});

afterEach(() => {
  uninstallFakeBackend();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("profiles store", () => {
  it("loads profiles with their session states and checks the first usable one", async () => {
    installFakeBackend();
    await useProfiles.getState().load();

    const state = useProfiles.getState();
    expect(state.profiles).toHaveLength(6);
    expect(state.statuses["demo-prod"]?.state).toBe("expired");
    expect(state.statuses["demo-keys"]?.state).toBe("notSso");
    expect(state.selected).toBe("demo-dev");
    expect(state.identity).toMatchObject({ state: "ok", identity: { account: "111122223333" } });
  });

  it("doesn't call AWS for a profile that needs a login", async () => {
    installFakeBackend();
    await useProfiles.getState().load();
    await useProfiles.getState().select("demo-prod");
    expect(useProfiles.getState().identity).toEqual({ state: "idle" });
  });

  it("takes a profile confirmed a moment ago as connected without asking AWS again", async () => {
    installFakeBackend();
    await useProfiles.getState().load();
    await useProfiles.getState().select("demo-staging");
    const callerIdentity = vi.spyOn(commands, "callerIdentity");

    await useProfiles.getState().select("demo-dev");
    expect(callerIdentity).not.toHaveBeenCalled();
    expect(useProfiles.getState().identity).toMatchObject({ state: "ok" });

    // Once AWS rejects the session, or after a while, it is checked again.
    useProfiles.getState().sessionRejected({ code: "credentials", message: "expired", hint: null });
    await useProfiles.getState().select("demo-staging");
    await useProfiles.getState().select("demo-dev");
    expect(callerIdentity).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + IDENTITY_FRESH_MS });
    await useProfiles.getState().select("demo-staging");
    expect(callerIdentity).toHaveBeenCalledTimes(2);
  });

  it("logs in, streams the output and then checks the identity", async () => {
    installFakeBackend();
    await useProfiles.getState().load();
    await useProfiles.getState().select("demo-prod");

    await useProfiles.getState().startLogin();

    const state = useProfiles.getState();
    expect(state.login).toMatchObject({ profile: "demo-prod", running: false, error: null });
    expect(state.login?.lines).toHaveLength(2);
    expect(state.statuses["demo-prod"]?.state).toBe("valid");
    expect(state.identity).toMatchObject({ state: "ok", identity: { account: "333344445555" } });
  });

  it("logs in without the AWS CLI with a code to confirm", async () => {
    installFakeBackend({ noCli: true });
    await useProfiles.getState().load();
    await useProfiles.getState().select("demo-sandbox");

    await useProfiles.getState().startLogin();

    const state = useProfiles.getState();
    expect(state.login).toMatchObject({
      running: false,
      error: null,
      device: { code: "DEMO-CODE" },
    });
    expect(state.statuses["demo-sandbox"]?.state).toBe("valid");
  });

  it("uses the saved region override before the profile's region", async () => {
    installFakeBackend();
    await useProfiles.getState().load();
    expect(currentRegion()).toBe("eu-central-1");
    await usePrefs.getState().setRegionOverride("demo-dev", "us-west-2");
    expect(currentRegion()).toBe("us-west-2");
    await usePrefs.getState().setRegionOverride("demo-dev", null);
    expect(currentRegion()).toBe("eu-central-1");
  });

  it("starts with the last used profile and remembers new selections", async () => {
    installFakeBackend({ prefs: { lastProfile: "demo-staging" } });
    await useProfiles.getState().load();
    expect(useProfiles.getState().selected).toBe("demo-staging");

    await useProfiles.getState().select("demo-keys");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(usePrefs.getState().prefs.lastProfile).toBe("demo-keys");
  });
});
