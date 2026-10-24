import { useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import type { TimeWindow, TimeZone } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  addDays,
  at,
  compareDays,
  dayOf,
  sameDay,
  windowDetail,
  windowTitle,
  type Day,
} from "@/lib/timeInput";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `09:30` as hours and minutes; `24:00` is the end of the day. */
function parseClock(text: string): { h: number; m: number } | null {
  const match = /^(\d{1,2})(?::?(\d{2}))?$/.exec(text.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2] ?? 0);
  if (h === 24 && m === 0) return { h, m };
  return h < 24 && m < 60 ? { h, m } : null;
}

function clockAt(day: Day, clock: { h: number; m: number }, timeZone: TimeZone): number {
  return clock.h === 24 ? at(addDays(day, 1), 0, 0, timeZone) : at(day, clock.h, clock.m, timeZone);
}

/**
 * A fixed range picked on a month calendar: click the first day, then the last one (a single
 * click and Apply is one day), and adjust the times if needed.
 */
export function RangeCalendar({
  value,
  timeZone,
  onApply,
}: {
  value: TimeWindow;
  timeZone: TimeZone;
  onApply: (window: TimeWindow) => void;
}) {
  // "Now" as of opening the calendar: today's date and the latest end allowed.
  const [now] = useState(Date.now);
  const today = dayOf(now, timeZone);
  const initial =
    value.kind === "range"
      ? {
          start: dayOf(Date.parse(value.from), timeZone),
          end: dayOf(Date.parse(value.to) - 1, timeZone),
        }
      : { start: today, end: today };
  const [month, setMonth] = useState<Day>({ ...initial.start, d: 1 });
  const [start, setStart] = useState<Day>(initial.start);
  const [end, setEnd] = useState<Day | null>(initial.end);
  const [hover, setHover] = useState<Day | null>(null);
  const [fromText, setFromText] = useState("00:00");
  const [toText, setToText] = useState("24:00");

  // Six weeks from the Monday on or before the 1st.
  const first = new Date(Date.UTC(month.y, month.m - 1, 1)).getUTCDay();
  const gridStart = addDays(month, -((first + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const isCurrentMonth = month.y === today.y && month.m === today.m;

  const pick = (day: Day) => {
    if (end || compareDays(day, start) < 0) {
      setStart(day);
      setEnd(null);
    } else {
      setEnd(day);
    }
  };
  // While choosing the last day, the hovered day previews the range.
  const last = end ?? (hover && compareDays(hover, start) >= 0 ? hover : start);

  const from = parseClock(fromText);
  const to = parseClock(toText);
  const startMs = from ? clockAt(start, from, timeZone) : NaN;
  // Ending today at midnight would be in the future: end now instead.
  const endMs = to ? Math.min(clockAt(last, to, timeZone), now) : NaN;
  const valid = startMs < endMs && startMs < now;
  const window: TimeWindow | null = valid
    ? { kind: "range", from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() }
    : null;

  return (
    <div aria-label="Calendar" role="group" className="w-72 space-y-3 p-3 text-xs">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous month"
          // `month` is the 1st: a day back is in the month before.
          onClick={() => setMonth({ ...addDays(month, -1), d: 1 })}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="font-medium">
          {MONTH_NAMES[month.m - 1]} {month.y}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next month"
          disabled={isCurrentMonth}
          onClick={() => setMonth({ ...addDays(month, 31), d: 1 })}
        >
          <ChevronRightIcon />
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-y-0.5 text-center" onMouseLeave={() => setHover(null)}>
        {WEEKDAYS.map((w) => (
          <span key={w} className="pb-1 text-[0.65rem] text-muted-foreground">
            {w}
          </span>
        ))}
        {days.map((day) => {
          const future = compareDays(day, today) > 0;
          const outside = day.m !== month.m;
          const isStart = sameDay(day, start);
          const isEnd = sameDay(day, last);
          const inRange = compareDays(day, start) > 0 && compareDays(day, last) < 0;
          return (
            <button
              key={`${day.y}-${day.m}-${day.d}`}
              type="button"
              disabled={future}
              aria-label={`${MONTH_NAMES[day.m - 1]} ${day.d}, ${day.y}`}
              aria-pressed={isStart || isEnd || inRange}
              onClick={() => pick(day)}
              onMouseEnter={() => setHover(day)}
              className={cn(
                "h-7 tabular-nums transition-colors disabled:opacity-25",
                outside && "text-muted-foreground/60",
                inRange && "bg-primary/15",
                (isStart || isEnd) && "bg-primary font-semibold text-primary-foreground",
                isStart && "rounded-l-md",
                isEnd && "rounded-r-md",
                !isStart && !isEnd && !inRange && "rounded-md hover:bg-accent",
                sameDay(day, today) && !isStart && !isEnd && "font-semibold text-primary",
              )}
            >
              {day.d}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1">
          <span className="text-muted-foreground">From</span>
          <Input
            aria-label="From time"
            value={fromText}
            onChange={(e) => setFromText(e.target.value)}
            aria-invalid={!from}
            className="h-7 font-mono text-xs"
          />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">To</span>
          <Input
            aria-label="To time"
            value={toText}
            onChange={(e) => setToText(e.target.value)}
            aria-invalid={!to}
            className="h-7 font-mono text-xs"
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
          {window
            ? `${windowTitle(window, timeZone, now)} · ${windowDetail(window, timeZone, now)}`
            : "Pick days and times in the past."}
        </p>
        <Button size="xs" disabled={!window} onClick={() => window && onApply(window)}>
          Apply
        </Button>
      </div>
    </div>
  );
}
