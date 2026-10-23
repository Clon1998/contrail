/** Colours of pipeline status states: done green, failed red, retrying amber, the rest neutral. */
const STATE_TONE: Record<string, string> = {
  RECEIVED: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  PUBLISHED: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  CONSUMING: "border-border text-muted-foreground",
  COMPLETED: "border-success/40 text-success",
  FAILED: "border-destructive/50 text-destructive",
  RETRYING: "border-warning/50 text-warning",
};

export function stateTone(state: string): string {
  return STATE_TONE[state.toUpperCase()] ?? "border-border text-muted-foreground";
}
