import { useEffect, useState } from "react";
import { applyAppearance, applyWindowTheme, isDark } from "@/lib/appearance";
import { usePrefs } from "@/stores/prefs";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Whether the operating system prefers dark mode, updated live. */
function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia?.(DARK_QUERY).matches ?? true);
  useEffect(() => {
    const query = window.matchMedia?.(DARK_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** Keeps `<html>` and the native window in sync with the colour mode and accent settings. */
export function useAppearance() {
  const { colorMode, accent } = usePrefs((s) => s.prefs.settings);
  const systemPrefersDark = useSystemPrefersDark();

  useEffect(() => {
    applyAppearance(isDark(colorMode, systemPrefersDark), accent);
  }, [colorMode, accent, systemPrefersDark]);

  useEffect(() => {
    void applyWindowTheme(colorMode);
  }, [colorMode]);
}
