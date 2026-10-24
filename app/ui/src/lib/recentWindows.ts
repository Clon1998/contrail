import type { TimeWindow } from "@/bindings";
import { sameWindow } from "@/lib/logs";

const KEY = "contrail.recentTimeWindows";
const MAX = 4;

/**
 * The time windows chosen lately (newest first), for the time picker. A convenience of this
 * device only, so it lives in the webview's localStorage rather than in the settings file; when
 * storage isn't available, the list is just empty.
 */
export function recentWindows(): TimeWindow[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as TimeWindow[]).filter(isWindow).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

/** Puts `window` at the top of the recent windows. */
export function rememberWindow(window: TimeWindow): void {
  const next = [window, ...recentWindows().filter((w) => !sameWindow(w, window))].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Not stored: the list only helps, nothing depends on it.
  }
}

function isWindow(value: TimeWindow): boolean {
  return (
    (value.kind === "last" && typeof value.minutes === "number") ||
    (value.kind === "range" && typeof value.from === "string" && typeof value.to === "string")
  );
}
