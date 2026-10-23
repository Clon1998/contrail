import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeBackend, uninstallFakeBackend } from "@/e2e/fakeBackend";
import { EMPTY_PREFS, usePrefs } from "./prefs";
import { currentRegion, useProfiles } from "./profiles";

const initial = useProfiles.getState();

beforeEach(() => {
  // zustand stores are module singletons: reset to the initial state between tests.
  useProfiles.setState(initial, true);
  usePrefs.setState({ prefs: EMPTY_PREFS });
});

afterEach(() => uninstallFakeBackend());

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

  it("keeps the error when the AWS CLI is missing", async () => {
    installFakeBackend({ cliMissing: true });
    await useProfiles.getState().load();
    await useProfiles.getState().select("demo-sandbox");

    await useProfiles.getState().startLogin();

    expect(useProfiles.getState().login).toMatchObject({
      running: false,
      error: { code: "cliMissing" },
    });
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
