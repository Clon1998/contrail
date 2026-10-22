import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { installFakeBackend } from "@/e2e/fakeBackend";
import { useProfiles } from "@/stores/profiles";

const initial = useProfiles.getState();

beforeEach(() => useProfiles.setState(initial, true));

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
});
