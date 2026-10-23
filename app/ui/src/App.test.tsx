import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { installFakeBackend, uninstallFakeBackend } from "@/e2e/fakeBackend";
import { useEcs } from "@/stores/ecs";
import { useTabs } from "@/stores/tabs";
import { EMPTY_PREFS, usePrefs } from "@/stores/prefs";
import { useProfiles } from "@/stores/profiles";

const initialProfiles = useProfiles.getState();
const initialEcs = useEcs.getState();
const initialTabs = useTabs.getState();

beforeEach(() => {
  useProfiles.setState(initialProfiles, true);
  useEcs.setState(initialEcs, true);
  useTabs.setState(initialTabs, true);
  usePrefs.setState({ prefs: EMPTY_PREFS });
  // The settings test changes the page's colour mode and accent.
  document.documentElement.className = "dark";
  delete document.documentElement.dataset.accent;
  document.documentElement.removeAttribute("style");
});

afterEach(() => {
  cleanup();
  uninstallFakeBackend();
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

    // Only the role is shown (the full ARN is in its tooltip, see the Playwright tests).
    expect(await screen.findByText("DemoReadOnly")).toBeTruthy();
    const switcher = screen.getByRole("combobox", { name: "AWS profile" });
    expect(switcher.textContent).toContain("demo-dev");
    expect(switcher.textContent).toContain("111122223333");
    expect(screen.getByText("Demo")).toBeTruthy();
  });

  it("lists every profile with its session state", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly");

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
    await screen.findByText("DemoReadOnly");

    await openSwitcherAndPick("demo-prod");
    expect(await screen.findByText("Log in to demo-prod")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Connected to demo-prod")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Log in" })).toBeNull();
  });

  it("offers a login when AWS rejects a session that looks valid", async () => {
    installFakeBackend({ rejectedSessions: ["demo-dev"] });
    render(<App />);

    expect(await screen.findByText("Log in to demo-dev")).toBeTruthy();
    // The reason is shown once (in the main panel), not repeated in the header.
    expect(screen.getAllByText(/Session token not found or invalid/)).toHaveLength(1);
    const switcher = screen.getByRole("combobox", { name: "AWS profile" });
    expect(within(switcher).getByLabelText("session rejected")).toBeTruthy();

    fireEvent.click(within(screen.getByRole("banner")).getByRole("button", { name: "Log in" }));
    expect(await screen.findByText("Connected to demo-dev")).toBeTruthy();
  });

  it("filters the service tree by name across clusters", async () => {
    installFakeBackend();
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    await within(tree).findByRole("treeitem", { name: "demo-edge" });

    const filter = screen.getByRole("searchbox", { name: "Filter services" });
    fireEvent.change(filter, { target: { value: "GATE" } });

    // Collapsed clusters open to show matches; clusters without a match are hidden.
    expect(await within(tree).findByRole("treeitem", { name: "legacy-gateway" })).toBeTruthy();
    expect(within(tree).queryByRole("treeitem", { name: "orders-api" })).toBeNull();
    expect(within(tree).queryByRole("treeitem", { name: "demo-core" })).toBeNull();

    fireEvent.keyDown(filter, { key: "Escape" });
    expect((filter as HTMLInputElement).value).toBe("");
    expect(await within(tree).findByRole("treeitem", { name: "demo-core" })).toBeTruthy();
  });

  it("explains a missing AWS CLI", async () => {
    installFakeBackend({ cliMissing: true });
    render(<App />);
    await screen.findByText("DemoReadOnly");

    await openSwitcherAndPick("demo-sandbox");
    fireEvent.click(
      await within(screen.getByRole("banner")).findByRole("button", { name: "Log in" }),
    );

    const output = await screen.findByRole("region", { name: "Login output" });
    expect(within(output).getByText(/AWS CLI \(`aws`\) was not found/)).toBeTruthy();
    expect(within(output).getByText(/Install AWS CLI v2/)).toBeTruthy();
  });

  it("shows why a misconfigured profile can't be used", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly");

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

  it("changes theme, accent, sizes and time zone in the settings dialog", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });

    const theme = within(dialog).getByRole("group", { name: "Theme" });
    fireEvent.click(within(theme).getByRole("button", { name: "Light" }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    expect(within(theme).getByRole("button", { name: "Light" }).getAttribute("aria-pressed")).toBe(
      "true",
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Violet" }));
    await waitFor(() => expect(document.documentElement.dataset.accent).toBe("violet"));

    fireEvent.click(within(dialog).getByRole("button", { name: "Logs" }));
    const timestamps = within(dialog).getByRole("group", { name: "Timestamps" });
    fireEvent.click(within(timestamps).getByRole("button", { name: "UTC" }));
    await waitFor(() => expect(usePrefs.getState().prefs.settings.timeZone).toBe("utc"));
  });

  it("shows a service's logs and expands a row into stack trace and fields", async () => {
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

    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(within(view).getByRole("tab", { name: "Logs" }), { button: 0 });
    const list = await within(view).findByRole("list", { name: "Log events" });
    expect(list.getAttribute("aria-rowcount")).toBe("25");
    expect(within(view).getByText("/ecs/payments-worker · 5 streams")).toBeTruthy();
  });

  it("opens a single task's logs from the task list", async () => {
    installFakeBackend();
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "demo-edge" })).getByRole("button"),
    );
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "legacy-gateway" })).getByRole(
        "button",
      ),
    );
    const view = await screen.findByRole("main", { name: "Service legacy-gateway" });
    const tasks = await within(view).findByRole("region", { name: "Tasks" });
    const [logsButton] = within(tasks).getAllByRole("button", { name: /^Logs of task / });
    if (!logsButton) throw new Error("no task logs button");
    fireEvent.click(logsButton);

    expect(await within(view).findByText("/ecs/legacy-gateway · 1 stream")).toBeTruthy();
    // The toolbar's task picker shows the task (switching back is covered in Playwright).
    expect(within(view).getByRole("combobox", { name: "Task" }).textContent).toMatch(
      /task [0-9a-f]{8}/,
    );
  });

  it("follows a view live, and pausing stops new rows", async () => {
    installFakeBackend({ liveIntervalMs: 50 });
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "demo-core" })).getByRole("button"),
    );
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "orders-api" })).getByRole("button"),
    );
    const view = await screen.findByRole("main", { name: "Service orders-api" });
    fireEvent.mouseDown(within(view).getByRole("tab", { name: "Logs" }), { button: 0 });

    expect(await within(view).findByRole("status", { name: "Live tail: Live" })).toBeTruthy();
    const list = await within(view).findByRole("list", { name: "Log events" });
    await waitFor(() => expect(Number(list.getAttribute("aria-rowcount"))).toBeGreaterThan(25));

    fireEvent.click(within(view).getByRole("button", { name: "Pause live tail" }));
    expect(await within(view).findByRole("status", { name: "Live tail: Paused" })).toBeTruthy();
    const paused = Number(list.getAttribute("aria-rowcount"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(Number(list.getAttribute("aria-rowcount"))).toBe(paused);

    fireEvent.click(within(view).getByRole("button", { name: "Resume live tail" }));
    expect(await within(view).findByRole("status", { name: "Live tail: Live" })).toBeTruthy();
  });

  async function openPaymentsLogs() {
    installFakeBackend({ liveIntervalMs: 60_000 });
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
    fireEvent.mouseDown(within(view).getByRole("tab", { name: "Logs" }), { button: 0 });
    const list = await within(view).findByRole("list", { name: "Log events" });
    return { view, list };
  }

  it("filters by level and shows query errors with a hint", async () => {
    const { view, list } = await openPaymentsLogs();
    const search = within(view).getByRole("textbox", { name: "Search logs" });

    fireEvent.change(search, { target: { value: "level:ERROR" } });
    await waitFor(() => expect(Number(list.getAttribute("aria-rowcount"))).toBeLessThan(25));
    expect(within(view).getByLabelText("Match count").textContent).toMatch(/^\d+ of 25$/);

    fireEvent.change(search, { target: { value: "level:LOUD" } });
    const alert = await within(view).findByRole("alert");
    expect(alert.textContent).toContain('unknown level "LOUD"');
    expect(alert.textContent).toContain("TRACE, DEBUG, INFO, WARN, ERROR");
  });

  it("highlight mode keeps all rows and counts matches", async () => {
    const { view, list } = await openPaymentsLogs();
    fireEvent.click(within(view).getByRole("radio", { name: "highlight" }));
    fireEvent.change(within(view).getByRole("textbox", { name: "Search logs" }), {
      target: { value: "settling" },
    });
    await waitFor(() =>
      expect(within(view).getByLabelText("Match count").textContent).toMatch(/\d+ matches$/),
    );
    expect(list.getAttribute("aria-rowcount")).toBe("25");
    fireEvent.click(within(view).getByRole("button", { name: "Next match" }));
    await waitFor(() =>
      expect(within(view).getByLabelText("Match count").textContent).toMatch(/^1 \/ \d+ matches$/),
    );
  });

  it("level chips hide a level", async () => {
    const { view, list } = await openPaymentsLogs();
    const levels = within(view).getByRole("group", { name: "Levels" });
    const info = within(levels).getByRole("button", { name: /^INFO / });
    fireEvent.click(info);
    await waitFor(() => expect(info.getAttribute("aria-pressed")).toBe("false"));
    await waitFor(() => expect(Number(list.getAttribute("aria-rowcount"))).toBeLessThan(25));
  });

  it("keeps each opened service in a tab with its log view", async () => {
    installFakeBackend({ liveIntervalMs: 60_000 });
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "demo-core" })).getByRole("button"),
    );
    const pick = async (name: string) =>
      fireEvent.click(
        within(await within(tree).findByRole("treeitem", { name })).getByRole("button"),
      );

    await pick("payments-worker");
    let view = await screen.findByRole("main", { name: "Service payments-worker" });
    fireEvent.mouseDown(within(view).getByRole("tab", { name: "Logs" }), { button: 0 });
    fireEvent.change(await within(view).findByRole("textbox", { name: "Search logs" }), {
      target: { value: "settling" },
    });
    await within(view).findByLabelText("Match count");

    await pick("orders-api");
    await screen.findByRole("main", { name: "Service orders-api" });
    const tabs = screen.getByRole("tablist", { name: "Open services" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.getAttribute("aria-label")),
    ).toEqual(["payments-worker", "orders-api"]);

    // Back to the first tab: still on Logs, with its search.
    fireEvent.click(within(tabs).getByRole("tab", { name: "payments-worker" }));
    view = await screen.findByRole("main", { name: "Service payments-worker" });
    expect(within(view).getByRole<HTMLInputElement>("textbox", { name: "Search logs" }).value).toBe(
      "settling",
    );

    // Middle click closes a tab.
    fireEvent.mouseDown(within(tabs).getByRole("tab", { name: "payments-worker" }), { button: 1 });
    await screen.findByRole("main", { name: "Service orders-api" });
    fireEvent.click(screen.getByRole("button", { name: "Close orders-api" }));
    await waitFor(() =>
      expect(screen.queryByRole("tablist", { name: "Open services" })).toBeNull(),
    );
  });

  it("exports the matches of a search", async () => {
    const { view } = await openPaymentsLogs();
    fireEvent.change(within(view).getByRole("textbox", { name: "Search logs" }), {
      target: { value: "level:ERROR" },
    });
    const count = await within(view).findByLabelText("Match count");
    const matches = /^(\d+) of/.exec(count.textContent ?? "")?.[1];

    fireEvent.pointerDown(within(view).getByRole("button", { name: "Export" }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "JSON Lines (.jsonl)" }));
    expect(await within(view).findByText(`Exported ${matches} events`)).toBeTruthy();
  });

  it("opens the keyboard shortcuts with ?", async () => {
    installFakeBackend();
    render(<App />);
    await screen.findByText("DemoReadOnly");
    fireEvent.keyDown(document.body, { key: "?" });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Go to a service")).toBeTruthy();
    expect(within(dialog).getByRole("region", { name: "Search" })).toBeTruthy();
  });

  it("explains a stopped live tail and retries it", async () => {
    installFakeBackend({ liveIntervalMs: 60_000, liveFailures: 1 });
    render(<App />);
    const tree = await screen.findByRole("tree", { name: "Clusters" });
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "demo-core" })).getByRole("button"),
    );
    fireEvent.click(
      within(await within(tree).findByRole("treeitem", { name: "orders-api" })).getByRole("button"),
    );
    const view = await screen.findByRole("main", { name: "Service orders-api" });
    fireEvent.mouseDown(within(view).getByRole("tab", { name: "Logs" }), { button: 0 });

    const alert = await within(view).findByRole("alert");
    expect(alert.textContent).toContain("ExpiredToken");
    expect(alert.textContent).toContain("Log in again");
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await within(view).findByRole("status", { name: "Live tail: Live" })).toBeTruthy();
    expect(within(view).queryByRole("alert")).toBeNull();
  });

  it("saves a field mapping per service", async () => {
    const { view } = await openPaymentsLogs();
    fireEvent.click(within(view).getByRole("button", { name: "Field mapping" }));
    const dialog = await screen.findByRole("dialog", { name: "Field mapping" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Message field" }), {
      target: { value: "process.thread.name" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save and reload" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Saved per service (the rows themselves are checked in e2e/workflow.e2e.ts: jsdom has no layout).
    expect(Object.values(usePrefs.getState().prefs.fieldMappings)).toEqual([
      { message: "process.thread.name", level: null, timestamp: null },
    ]);
    expect(within(view).getByRole("button", { name: "Field mapping" }).className).toContain(
      "text-primary",
    );
  });
});
