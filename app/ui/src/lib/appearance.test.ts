import { describe, expect, it } from "vitest";
import { applyAppearance, isDark } from "./appearance";

describe("appearance", () => {
  it("resolves the colour mode", () => {
    expect(isDark("dark", false)).toBe(true);
    expect(isDark("light", true)).toBe(false);
    expect(isDark("system", true)).toBe(true);
    expect(isDark("system", false)).toBe(false);
  });

  it("sets the dark class and the accent on the root element", () => {
    const root = document.createElement("html");
    root.classList.add("dark");
    applyAppearance(false, "violet", root);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.dataset.accent).toBe("violet");
    applyAppearance(true, "sky", root);
    expect(root.classList.contains("dark")).toBe(true);
  });
});
