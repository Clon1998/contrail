/** "⌘" on macOS, "Ctrl" elsewhere: how shortcuts are written in the UI. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl+";

/** Whether a key press happens while typing (where "?" or "t" is just a character). */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}
