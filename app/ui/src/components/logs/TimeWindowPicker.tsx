import { useEffect, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CalendarDaysIcon, CheckIcon, ChevronDownIcon, ClockIcon } from "lucide-react";
import { cn } from "cn";
import type { TimeWindow, TimeZone } from "@/bindings";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { isTyping } from "@/lib/keys";
import { liveMode, sameWindow } from "@/lib/logs";
import { recentWindows, rememberWindow } from "@/lib/recentWindows";
import {
  durationText,
  parseTimeInput,
  windowChip,
  windowDetail,
  windowTitle,
} from "@/lib/timeInput";
import { usePrefs } from "@/stores/prefs";
import { RangeCalendar } from "./RangeCalendar";

/** The quick picks, as one would type them (the shortcut shown next to each). */
const QUICK = ["5m", "15m", "1h", "6h", "24h", "7d", "today", "yesterday"];

/** How a window behaves once chosen: the dot and words next to it. */
const MODE = {
  live: { label: "live", legend: "live", dot: "bg-success" },
  paused: { label: "opens paused", legend: "paused", dot: "bg-warning" },
  off: { label: "fixed range", legend: "fixed", dot: "bg-muted-foreground" },
} as const;

/**
 * The time window of a log view: a button showing the current window, opening a small command
 * palette (also with T). Type `15m`, `3h`, `yesterday`, `since 14:00`, `9:00-11:30`… and see
 * what it means before pressing Enter, or pick a quick window, a recent one or a range on the
 * calendar.
 */
export function TimeWindowPicker({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (timeWindow: TimeWindow) => void;
}) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const [open, setOpen] = useState(false);
  const mode = MODE[liveMode(value)];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
      if (event.key.toLowerCase() === "t" && plain && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const apply = (timeWindow: TimeWindow) => {
    rememberWindow(timeWindow);
    onChange(timeWindow);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Time window: ${windowChip(value, timeZone)}`}
          title="Time window (T)"
          className={cn(
            "flex h-6 items-center gap-1.5 rounded-md border border-border px-2 transition-colors hover:bg-accent",
            open && "bg-accent",
          )}
        >
          <ClockIcon className="size-3.5 text-muted-foreground" />
          <span className="font-medium tabular-nums">{windowChip(value, timeZone)}</span>
          <span aria-hidden className={cn("size-1.5 rounded-full", mode.dot)} />
          <ChevronDownIcon className="size-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto overflow-hidden p-0">
        <TimePalette value={value} timeZone={timeZone} onApply={apply} />
      </PopoverContent>
    </Popover>
  );
}

interface Choice {
  key: string;
  window: TimeWindow;
  /** Instead of the window's own title (`Today` rather than `Last 9 hours 12 minutes`). */
  title?: string;
  /** What to type for it, shown at the right. */
  shortcut?: string;
}

function TimePalette({
  value,
  timeZone,
  onApply,
}: {
  value: TimeWindow;
  timeZone: TimeZone;
  onApply: (window: TimeWindow) => void;
}) {
  // "Now" for the labels and the typed window: taken when the palette opens and on each key.
  const [{ text, now }, setInput] = useState(() => ({ text: "", now: Date.now() }));
  const [calendar, setCalendar] = useState(value.kind === "range");
  const [recent] = useState(recentWindows);

  const typed = parseTimeInput(text, timeZone, now);
  const query = text.trim().toLowerCase();
  const quick: Choice[] = QUICK.flatMap((shortcut) => {
    const parsed = parseTimeInput(shortcut, timeZone, now);
    if (parsed.kind !== "ok") return [];
    const matches =
      !query ||
      shortcut.startsWith(query) ||
      windowTitle(parsed.window, timeZone, now).toLowerCase().includes(query);
    return matches
      ? [{ key: `quick-${shortcut}`, window: parsed.window, title: parsed.title, shortcut }]
      : [];
  });
  const recents: Choice[] = query
    ? []
    : recent
        .filter((w) => !quick.some((q) => sameWindow(q.window, w)))
        .map((window, i) => ({ key: `recent-${i}`, window }));

  // The typed window is the one Enter takes. Arrow keys move the selection; typing starts over.
  // Without input, the current window (Enter keeps it).
  const currentKey = [...quick, ...recents].find((c) => sameWindow(c.window, value))?.key;
  const firstKey =
    typed.kind === "ok" ? "typed" : (currentKey ?? quick[0]?.key ?? recents[0]?.key ?? "");
  const [moved, setMoved] = useState<{ text: string; key: string } | null>(null);
  const selected = moved?.text === text ? moved.key : firstKey;

  return (
    <div className="flex text-xs">
      <Command
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={(key) => setMoved({ text, key })}
        className="w-[22rem] rounded-none bg-transparent"
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
          <CommandPrimitive.Input
            autoFocus
            aria-label="Time window"
            placeholder="15m, 3h, yesterday, since 14:00, 9:00-11:30…"
            value={text}
            onValueChange={(next) => setInput({ text: next, now: Date.now() })}
            className="h-10 w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground"
          />
          {typed.kind === "ok" && <Kbd>↵</Kbd>}
        </div>
        <CommandList className="max-h-[22rem] p-1">
          {typed.kind === "ok" && (
            <CommandGroup heading="Your input">
              <WindowItem
                prominent
                choice={{ key: "typed", window: typed.window, title: typed.title }}
                current={value}
                timeZone={timeZone}
                now={now}
                onApply={onApply}
              />
            </CommandGroup>
          )}
          {typed.kind === "invalid" && (
            <p role="status" className="px-3 py-2 text-muted-foreground">
              {typed.hint}
            </p>
          )}
          {quick.length > 0 && (
            <CommandGroup heading="Quick">
              {quick.map((choice) => (
                <WindowItem
                  key={choice.key}
                  choice={choice}
                  current={value}
                  timeZone={timeZone}
                  now={now}
                  onApply={onApply}
                />
              ))}
            </CommandGroup>
          )}
          {recents.length > 0 && (
            <CommandGroup heading="Recent">
              {recents.map((choice) => (
                <WindowItem
                  key={choice.key}
                  choice={choice}
                  current={value}
                  timeZone={timeZone}
                  now={now}
                  onApply={onApply}
                />
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5 text-muted-foreground">
          <button
            type="button"
            aria-pressed={calendar}
            onClick={() => setCalendar(!calendar)}
            className={cn(
              "flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground",
              calendar && "bg-accent text-foreground",
            )}
          >
            <CalendarDaysIcon className="size-3.5" /> Calendar
          </button>
          <span className="ml-auto flex items-center gap-2.5">
            {Object.values(MODE).map((mode) => (
              <span key={mode.legend} className="flex items-center gap-1 whitespace-nowrap">
                <span aria-hidden className={cn("size-1.5 rounded-full", mode.dot)} />
                {mode.legend}
              </span>
            ))}
            <span className="border-l border-border pl-2.5 whitespace-nowrap">
              {timeZone === "utc" ? "UTC" : "local time"}
            </span>
          </span>
        </div>
      </Command>
      {calendar && (
        <div className="border-l border-border">
          <RangeCalendar value={value} timeZone={timeZone} onApply={onApply} />
        </div>
      )}
    </div>
  );
}

/** One window to choose: a line with its dot, title and detail; the typed one bigger. */
function WindowItem({
  choice,
  current,
  timeZone,
  now,
  onApply,
  prominent = false,
}: {
  choice: Choice;
  current: TimeWindow;
  timeZone: TimeZone;
  now: number;
  onApply: (window: TimeWindow) => void;
  prominent?: boolean;
}) {
  const { window } = choice;
  const mode = MODE[liveMode(window)];
  const title = choice.title ?? windowTitle(window, timeZone, now);
  // With a title of its own (`Since 14:00`), the detail says how long that is.
  const detail =
    choice.title && window.kind === "last"
      ? durationText(window.minutes, "long")
      : windowDetail(window, timeZone, now);
  return (
    <CommandItem
      value={choice.key}
      onSelect={() => onApply(window)}
      className={cn("gap-2.5", prominent ? "py-2" : "py-1")}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", mode.dot)} />
      {prominent ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {detail} · {mode.label}
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-sm">{title}</span>
          <span className="truncate text-xs text-muted-foreground">{detail}</span>
        </span>
      )}
      {sameWindow(window, current) && (
        <CheckIcon aria-label="Current" className="size-3.5 text-primary" />
      )}
      {choice.shortcut && <Kbd>{choice.shortcut}</Kbd>}
    </CommandItem>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.65rem] text-muted-foreground">
      {children}
    </kbd>
  );
}
