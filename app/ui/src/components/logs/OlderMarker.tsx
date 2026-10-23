import { CircleAlertIcon, FlagIcon, HardDriveIcon, HistoryIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Hint } from "@/components/ui/tooltip";
import { formatShortTime } from "@/lib/logs";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";

/** The marker's height in pixels (the list leaves room for it). */
export const OLDER_MARKER_HEIGHT = 40;

/**
 * The oldest end of the log list: a divider with a small label saying whether older events are
 * being loaded, can be loaded, can't be (buffer full), or that this is the start of the time
 * window. With a search, it says that the matches end here.
 */
export function OlderMarker() {
  const view = useLogs((s) => s.view);
  const older = useLogs((s) => s.older);
  const filtering = useLogs((s) => s.matches !== null && s.search.mode === "filter");
  const loadOlder = useLogs((s) => s.loadOlder);
  const loadAll = useLogs((s) => s.loadAll);
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  if (!view) return null;
  const since = formatShortTime(view.loadedFrom, timeZone);
  const start = formatShortTime(view.from, timeZone);

  let label: React.ReactNode;
  let actions: React.ReactNode = null;
  if (older.loading) {
    label = (
      <>
        <Loader2Icon className="animate-spin" />
        Loading older events…
      </>
    );
  } else if (older.error) {
    label = (
      <Hint content={older.error.hint ?? older.error.message}>
        <span className="flex items-center gap-1.5 text-destructive">
          <CircleAlertIcon />
          Couldn’t load older events
        </span>
      </Hint>
    );
    actions = (
      <Button variant="outline" size="xs" onClick={() => void loadOlder()}>
        Retry
      </Button>
    );
  } else if (view.complete) {
    label = (
      <>
        <FlagIcon />
        {filtering
          ? `No older matches · window starts ${start}`
          : `Start of the time window · ${start}`}
      </>
    );
  } else if (older.full) {
    label = (
      <Hint content="The buffer is full, so older events can't be added. A larger buffer size (settings) or a shorter time window helps.">
        <span className="flex items-center gap-1.5">
          <HardDriveIcon />
          Buffer full · loaded since {since}
        </span>
      </Hint>
    );
  } else {
    label = (
      <>
        <HistoryIcon />
        {filtering ? `No older matches in the events since ${since}` : `Loaded since ${since}`}
      </>
    );
    actions = (
      <>
        <Button variant="outline" size="xs" onClick={() => void loadOlder()}>
          Load older
        </Button>
        <Button
          variant="ghost"
          size="xs"
          tooltip="Load the whole time window (needed to search or export all of it)"
          onClick={() => void loadAll()}
        >
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
      className="flex items-center gap-3 px-4 font-sans"
    >
      <Separator className="flex-1" />
      <span className="flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
        {label}
      </span>
      {actions && <span className="flex items-center gap-1">{actions}</span>}
      <Separator className="flex-1" />
    </div>
  );
}
