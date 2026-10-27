import { useMemo } from "react";
import { serviceMarkers, type ServiceMarker } from "@/lib/markers";
import { useEcs } from "@/stores/ecs";
import { usePrefs } from "@/stores/prefs";

const NONE: ServiceMarker[] = [];

/**
 * The open service's deployments, stopped tasks and events as markers for its log view (none
 * when they are switched off). They come from the service's overview data: no extra AWS call.
 */
export function useServiceMarkers(): ServiceMarker[] {
  const shown = usePrefs((s) => s.prefs.settings.showMarkers);
  const detail = useEcs((s) => ("data" in s.detail ? (s.detail.data ?? null) : null));
  const tasks = useEcs((s) => ("data" in s.tasks ? (s.tasks.data ?? null) : null));
  return useMemo(
    () => (shown ? serviceMarkers(detail, tasks ?? []) : NONE),
    [shown, detail, tasks],
  );
}
