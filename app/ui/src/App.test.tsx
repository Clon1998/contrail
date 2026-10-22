import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("shows the version and the demo badge from app_info", async () => {
    // Pretend to be the Rust side of the `app_info` command.
    mockIPC((cmd) => (cmd === "app_info" ? { version: "0.1.0", demo: true } : undefined));
    render(<App />);
    expect(screen.getByRole("heading").textContent).toBe("Contrail");
    expect(await screen.findByText("Demo mode")).toBeTruthy();
    expect(screen.getByText("v0.1.0")).toBeTruthy();
  });

  it("has no demo badge against real AWS", async () => {
    mockIPC((cmd) => (cmd === "app_info" ? { version: "0.1.0", demo: false } : undefined));
    render(<App />);
    expect(await screen.findByText("v0.1.0")).toBeTruthy();
    expect(screen.queryByText("Demo mode")).toBeNull();
  });
});
