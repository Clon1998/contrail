import { useEffect } from "react";
import { usePrefs } from "@/stores/prefs";
import { useLogs } from "@/stores/logs";

/** A hidden window pauses after this grace period (quick app switches don't restart sessions). */
const HIDDEN_GRACE_MS = 30_000;

/**
 * Pauses the live tail while Contrail's window is hidden (setting "pause while hidden") and
 * while the view isn't shown for longer than the "background" setting; resumes (with a catch-up
 * backfill in Rust) when it's visible again. `active`: whether the view is on screen.
 */
export function useAutoPause(active: boolean) {
  const pauseWhenHidden = usePrefs((s) => s.prefs.settings.pauseWhenHidden);
  const backgroundMinutes = usePrefs((s) => s.prefs.settings.autoPauseMinutes);
  const setPaused = useLogs((s) => s.setPaused);

  useEffect(() => {
    if (!pauseWhenHidden) {
      setPaused("hidden", false);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.hidden) {
        timer = setTimeout(() => setPaused("hidden", true), HIDDEN_GRACE_MS);
      } else {
        setPaused("hidden", false);
      }
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [pauseWhenHidden, setPaused]);

  useEffect(() => {
    if (active || backgroundMinutes === 0) {
      setPaused("background", false);
      return;
    }
    const timer = setTimeout(() => setPaused("background", true), backgroundMinutes * 60_000);
    return () => clearTimeout(timer);
  }, [active, backgroundMinutes, setPaused]);
}
