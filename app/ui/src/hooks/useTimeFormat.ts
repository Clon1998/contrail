import { useMemo } from "react";
import type { TimeFormat } from "@/lib/timeFormat";
import { usePrefs } from "@/stores/prefs";

/** The time zone, date format and clock settings (re-renders when one of them changes). */
export function useTimeFormat(): TimeFormat {
  // Three selectors instead of one returning an object: a new object on every call would make
  // zustand re-render endlessly.
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const date = usePrefs((s) => s.prefs.settings.dateFormat);
  const clock = usePrefs((s) => s.prefs.settings.clock);
  return useMemo(() => ({ timeZone, date, clock }), [timeZone, date, clock]);
}
