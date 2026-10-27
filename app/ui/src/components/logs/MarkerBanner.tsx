import { CircleStopIcon, InfoIcon, RocketIcon, ScrollTextIcon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { formatLogTime } from "@/lib/logs";
import type { ServiceMarker } from "@/lib/markers";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

const ICON = { deployment: RocketIcon, task: CircleStopIcon, event: InfoIcon } as const;

/**
 * What happened to the service between two log lines (a deployment, a stopped task, a service
 * event), as thin lines across the list. A stopped task's line shows that task's logs on request.
 */
export function MarkerBanner({ markers }: { markers: ServiceMarker[] }) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const service = useLogs((s) => s.service);
  const showTask = useLogs((s) => s.showTask);
  if (markers.length === 0) return null;
  return (
    // A group of notes, not a list: inside the log list, items would read as more log rows.
    <div role="group" aria-label="Service events" className="font-sans text-xs">
      {markers.map((m) => {
        const Icon = ICON[m.kind];
        return (
          <div
            role="note"
            key={`${m.kind}-${m.at}-${m.title}`}
            className={cn(
              "flex items-center gap-2 border-y border-dashed px-3 py-0.5",
              m.failed
                ? "border-destructive/40 bg-destructive/5 text-destructive"
                : m.kind === "deployment"
                  ? "border-primary/40 bg-primary/5 text-primary"
                  : "border-border bg-muted/40 text-muted-foreground",
            )}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="font-mono tabular-nums">
              {formatLogTime(new Date(m.at).toISOString(), timeZone)}
            </span>
            <span className="font-medium">{m.title}</span>
            {m.detail && <span className="min-w-0 truncate opacity-80">{m.detail}</span>}
            {m.taskId && service && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto h-5"
                tooltip="Show only this task's logs"
                onClick={() => m.taskId && showTask(service, m.taskId)}
              >
                <ScrollTextIcon /> Its logs
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}
