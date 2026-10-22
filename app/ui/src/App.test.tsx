import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    clearMocks();
  });

  it("shows the app name", () => {
    render(<App />);
    expect(screen.getByRole("heading").textContent).toBe("Contrail");
  });

  it("greets via the Rust greet command", async () => {
    // Pretend to be the Rust side of the `greet` command.
    const calls: { cmd: string; args: unknown }[] = [];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      return "Hello, Patrick! Greetings from Contrail.";
    });

    render(<App />);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Patrick" } });
    fireEvent.click(screen.getByRole("button", { name: "Say hello" }));

    expect((await screen.findByTestId("greeting")).textContent).toBe(
      "Hello, Patrick! Greetings from Contrail.",
    );
    expect(calls).toEqual([{ cmd: "greet", args: { name: "Patrick" } }]);
  });
});
