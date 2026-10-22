import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Accent, ColorMode } from "@/bindings";

/** Whether the UI is dark for `mode`, given what the operating system prefers. */
export function isDark(mode: ColorMode, systemPrefersDark: boolean): boolean {
  return mode === "system" ? systemPrefersDark : mode === "dark";
}

/** Applies colour mode and accent to the page: `.dark` and `data-accent` on `<html>`. */
export function applyAppearance(dark: boolean, accent: Accent, root = document.documentElement) {
  root.classList.toggle("dark", dark);
  root.dataset.accent = accent;
}

/**
 * Applies the UI size (the root font size, which all `rem` sizes follow) and the log font size
 * (the `--log-font-size` variable the log list uses).
 */
export function applySizes(uiScale: number, logFontSize: number, root = document.documentElement) {
  root.style.fontSize = uiScale === 100 ? "" : `${uiScale}%`;
  root.style.setProperty("--log-font-size", `${logFontSize}px`);
}

/**
 * Makes the native window chrome (macOS title bar, …) follow the colour mode; `null` lets it
 * follow the system. Outside Tauri (tests, plain browser) there is no window to change.
 */
export async function applyWindowTheme(mode: ColorMode): Promise<void> {
  try {
    await getCurrentWindow().setTheme(mode === "system" ? null : mode);
  } catch {
    // Not running in Tauri.
  }
}
