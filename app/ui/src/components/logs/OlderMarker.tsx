import { Loader2Icon } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/ecs";
import { formatLogTime } from "@/lib/logs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

/** The marker's height in pixels (the list leaves room for it). */
export const OLDER_MARKER_HEIGHT = 28;

/**
 * The oldest end of the log list: whether older events are being loaded, can be loaded, can't be
 * (buffer full), or whether this is the start of the time window. With a search, it says that the
 * matches end here.
 */
export function OlderMarker({ position }: { position: "top" | "bottom" }) {
  const view = useLogs((s) => s.view);
  const older = useLogs((s) => s.older);
  const filtering = useLogs((s) => s.matches !== null && s.search.mode === "filter");
  const loadOlder = useLogs((s) => s.loadOlder);
  const loadAll = useLogs((s) => s.loadAll);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  if (!view) return null;
  const since = formatLogTime(view.loadedFrom, timeZone).slice(0, 5);

  let content: React.ReactNode;
  if (older.loading) {
    content = (
      <>
        <Loader2Icon className="size-3.5 animate-spin" /> Loading older events…
      </>
    );
  } else if (older.error) {
    content = (
      <>
        <span className="text-destructive">Couldn’t load older events: {older.error.message}</span>
        <Button variant="ghost" size="xs" onClick={() => void loadOlder()}>
          Retry
        </Button>
      </>
    );
  } else if (view.complete) {
    content = filtering
      ? `No older matches in the time window (from ${formatDateTime(view.from, timeZone)})`
      : `Start of the time window · ${formatDateTime(view.from, timeZone)}`;
  } else if (older.full) {
    content = `Buffer full: events before ${since} aren’t loaded (see the buffer size setting)`;
  } else {
    content = (
      <>
        {filtering
          ? `No older matches in the events loaded so far (since ${since})`
          : `Loaded since ${since}`}
        <Button variant="ghost" size="xs" onClick={() => void loadOlder()}>
          Load older
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void loadAll()}>
          Load all
        </Button>
      </>
    );
  }

  return (
    <div
      role="status"
      aria-label="Older events"
      style={{ height: OLDER_MARKER_HEIGHT }}
      className={cn(
        "flex items-center justify-center gap-2 border-border px-3 font-sans text-xs text-muted-foreground",
        position === "top" ? "border-b" : "border-t",
      )}
    >
      {content}
    </div>
  );
}
