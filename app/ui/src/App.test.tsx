import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { installFakeBackend } from "@/e2e/fakeBackend";
import { useEcs } from "@/stores/ecs";
import { EMPTY_PREFS, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";

const initialProfiles = useProfiles.getState();
const initialEcs = useEcs.getState();

beforeEach(() => {
  useProfiles.setState(initialProfiles, true);
  useEcs.setState(initialEcs, true);
  usePrefs.setState({ prefs: EMPTY_PREFS });
});

afterEach(() => {
  cleanup();
  clearMocks();
});

async function openSwitcherAndPick(name: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "AWS profile" }));
  const list = await screen.findByRole("listbox");
  fireEvent.click(within(list).getByText(name));
}

describe("App", () => {
  it("starts on the first usable profile and shows who is connected", async () => {
    installFakeBackend();
    render(<App />);

    expect(await screen.findByText("DemoReadOnly/demo.user")).toBeTruthy();
    const switcher = screen.getByRole("combobox", { name: "AWS profile" });
    expect(switcher.textContent).toContain("demo-dev");
    expect(switcher.textContent).toContain("111122223333");
    expect(screen.getByText("Demo")).toBeTruthy();
  });

  it("lists every profile with its session state", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly/demo.user");

    fireEvent.click(screen.getByRole("combobox", { name: "AWS profile" }));
    const list = await screen.findByRole("listbox");
    expect(within(list).getAllByRole("option")).toHaveLength(6);
    expect(within(list).getByText("logged out")).toBeTruthy();
    expect(within(list).getByText(/^expired .* ago$/)).toBeTruthy();
    expect(within(list).getByText(/^expires in/)).toBeTruthy();
    expect(within(list).getByText("misconfigured")).toBeTruthy();
  });

  it("logs in to an expired profile and connects", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly/demo.user");

    await openSwitcherAndPick("demo-prod");
    expect(await screen.findByText("Log in to demo-prod")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Connected to demo-prod")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("explains a missing AWS CLI", async () => {
    installFakeBackend({ cliMissing: true });
    render(<App />);
    await screen.findByText("DemoReadOnly/demo.user");

    await openSwitcherAndPick("demo-sandbox");
    fireEvent.click(await screen.findByRole("button", { name: "Log in" }));

    const output = await screen.findByRole("region", { name: "Login output" });
    expect(within(output).getByText(/AWS CLI \(`aws`\) was not found/)).toBeTruthy();
    expect(within(output).getByText(/Install AWS CLI v2/)).toBeTruthy();
  });

  it("shows why a misconfigured profile can't be used", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly/demo.user");

    await openSwitcherAndPick("demo-broken");

    expect(await screen.findByText("Profile demo-broken is misconfigured")).toBeTruthy();
    expect(screen.getByText(/has no \[sso-session gone\] section/)).toBeTruthy();
  });

  it("shows the clusters once connected and expands one into its services", async () => {
    installFakeBackend();
    render(<App />);

    const tree = await screen.findByRole("tree", { name: "Clusters" });
    const core = await within(tree).findByRole("treeitem", { name: "demo-core" });
    expect(core.textContent).toContain("3 svc");
    fireEvent.click(within(core).getByRole("button"));

    const payments = await within(core).findByRole("treeitem", { name: "payments-worker" });
    expect(payments.textContent).toContain("1/2");
    expect(
      within(payments).getByRole("img", { name: "fewer tasks running than desired" }),
    ).toBeTruthy();
  });

  it("has no tree for a profile that needs a login", async () => {
    installFakeBackend({ prefs: { lastProfile: "demo-prod" } });
    render(<App />);
    expect(await screen.findByText("Log in to demo-prod")).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
  });

  it("opens a service with deployments, tasks and stop reasons, and pins it", async () => {
    installFakeBackend();
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "demo-core" })).getByRole("button"),
    );
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "payments-worker" })).getByRole(
        "button",
      ),
    );

    const view = await screen.findByRole("main", { name: "Service payments-worker" });
    const deployments = await within(view).findByRole("region", { name: "Deployments" });
    expect(deployments.textContent).toContain("payments-worker:17");
    const tasks = within(view).getByRole("region", { name: "Tasks" });
    expect(within(tasks).getAllByText("EssentialContainerExited")).toHaveLength(2);
    expect(within(tasks).getAllByText("exit 1")).toHaveLength(2);
    expect(within(tasks).getByText(/CannotPullContainerError: ref not found/)).toBeTruthy();

    fireEvent.click(within(tasks).getByRole("button", { name: "Hide stopped" }));
    await waitFor(() => expect(within(tasks).queryByText("exit 1")).toBeNull());

    fireEvent.click(within(view).getByRole("button", { name: "Add to favorites" }));
    const favorites = await screen.findByRole("region", { name: "Favorites" });
    expect(within(favorites).getByText("payments-worker")).toBeTruthy();
  });

  it("jumps to a service with the ⌘K palette and lists it under recent", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByRole("tree", { name: "Clusters" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const palette = await screen.findByRole("dialog", { name: "Go to service" });
    fireEvent.change(within(palette).getByPlaceholderText("Go to service…"), {
      target: { value: "ingest" },
    });
    fireEvent.click(await within(palette).findByText("event-ingest"));

    expect(await screen.findByRole("main", { name: "Service event-ingest" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const again = await screen.findByRole("dialog", { name: "Go to service" });
    const recent = within(again).getByRole("group", { name: "Recent" });
    expect(within(recent).getByText("event-ingest")).toBeTruthy();
  });
});
