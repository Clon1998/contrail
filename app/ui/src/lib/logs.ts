/** Backfill windows offered for log views, in minutes. */
export const BACKFILL_WINDOWS: { minutes: number; label: string }[] = [
  { minutes: 5, label: "5 min" },
  { minutes: 15, label: "15 min" },
  { minutes: 60, label: "1 h" },
  { minutes: 360, label: "6 h" },
];

/** `12:34:56.789` in local time or UTC (the time zone setting). */
export function formatLogTime(timestamp: string, timeZone: "local" | "utc"): string {
  const date = new Date(timestamp);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const [h, m, s, ms] =
    timeZone === "utc"
      ? [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()]
      : [date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()];
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

/** The text without ANSI colour codes (the debug view shows plain text). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}
