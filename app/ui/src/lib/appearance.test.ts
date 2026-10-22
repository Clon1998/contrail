import { describe, expect, it } from "vitest";
import { applyAppearance, applySizes, isDark } from "./appearance";

describe("appearance", () => {
  it("resolves the colour mode", () => {
    expect(isDark("dark", false)).toBe(true);
    expect(isDark("light", true)).toBe(false);
    expect(isDark("system", true)).toBe(true);
    expect(isDark("system", false)).toBe(false);
  });

  it("sets the UI size and the log font size", () => {
    const root = document.createElement("html");
    applySizes(125, 14, root);
    expect(root.style.fontSize).toBe("125%");
    expect(root.style.getPropertyValue("--log-font-size")).toBe("14px");
    applySizes(100, 12, root);
    expect(root.style.fontSize).toBe("");
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
