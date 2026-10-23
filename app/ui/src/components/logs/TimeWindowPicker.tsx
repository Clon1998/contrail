import { useState } from "react";
import { CalendarClockIcon } from "lucide-react";
import { cn } from "cn";
import type { TimeWindow } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  BACKFILL_WINDOWS,
  fromDateTimeLocal,
  LIVE_BY_DEFAULT_MINUTES,
  sameWindow,
  toDateTimeLocal,
  windowLabel,
} from "@/lib/logs";
import { usePrefs } from "@/stores/prefs";

const UNITS = { min: 1, h: 60, d: 1440 } as const;
type Unit = keyof typeof UNITS;

/** The presets, plus "Custom": the last N minutes/hours/days, or a fixed from–to range. */
export function TimeWindowPicker({
  value,
  onChange,
}: {
  value: TimeWindow;
  onChange: (timeWindow: TimeWindow) => void;
}) {
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const isPreset = BACKFILL_WINDOWS.some((w) => sameWindow(value, { kind: "last", ...w }));
  const tab = (checked: boolean) =>
    cn(
      "rounded px-2 py-0.5",
      checked
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      role="radiogroup"
      aria-label="Time window"
      className="flex rounded-md border border-border p-0.5"
    >
      {BACKFILL_WINDOWS.map((w) => {
        const checked = sameWindow(value, { kind: "last", minutes: w.minutes });
        return (
          <button
            key={w.minutes}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onChange({ kind: "last", minutes: w.minutes })}
            className={tab(checked)}
          >
            {w.label}
          </button>
        );
      })}
      <CustomWindow value={value} onChange={onChange} timeZone={timeZone}>
        <button
          type="button"
          role="radio"
          aria-checked={!isPreset}
          className={cn(tab(!isPreset), "flex items-center gap-1")}
        >
          <CalendarClockIcon className="size-3" />
          {isPreset ? "Custom" : windowLabel(value, timeZone)}
        </button>
      </CustomWindow>
    </div>
  );
}

function CustomWindow({
  value,
  onChange,
  timeZone,
  children,
}: {
  value: TimeWindow;
  onChange: (timeWindow: TimeWindow) => void;
  timeZone: "local" | "utc";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<Unit>("h");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // Start the form from the current window each time it opens.
  const onOpenChange = (next: boolean) => {
    if (next) {
      const now = new Date().toISOString();
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      setFrom(toDateTimeLocal(value.kind === "range" ? value.from : hourAgo, timeZone));
      setTo(toDateTimeLocal(value.kind === "range" ? value.to : now, timeZone));
    }
    setOpen(next);
  };
  const apply = (timeWindow: TimeWindow) => {
    onChange(timeWindow);
    setOpen(false);
  };

  const minutes = Math.round(Number(amount) * UNITS[unit]);
  const relativeValid = Number.isFinite(minutes) && minutes >= 1;
  const fromIso = fromDateTimeLocal(from, timeZone);
  const toIso = fromDateTimeLocal(to, timeZone);
  const rangeValid = fromIso !== null && toIso !== null && fromIso < toIso;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-4 text-xs">
        <form
          aria-label="Relative time window"
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (relativeValid) apply({ kind: "last", minutes });
          }}
        >
          <p className="font-medium">Last</p>
          <div className="flex gap-1.5">
            <Input
              type="number"
              min={1}
              aria-label="Amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-7 w-20 text-xs"
            />
            <div
              role="radiogroup"
              aria-label="Unit"
              className="flex rounded-md border border-border p-0.5"
            >
              {(Object.keys(UNITS) as Unit[]).map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={u === unit}
                  onClick={() => setUnit(u)}
                  className={cn(
                    "rounded px-2",
                    u === unit ? "bg-secondary text-foreground" : "text-muted-foreground",
                  )}
                >
                  {u}
                </button>
              ))}
            </div>
            <Button type="submit" size="xs" className="ml-auto" disabled={!relativeValid}>
              Apply
            </Button>
          </div>
          <p className="text-muted-foreground">
            Windows longer than {LIVE_BY_DEFAULT_MINUTES} min open paused; ▶ follows new events.
          </p>
        </form>

        <form
          aria-label="Fixed time range"
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (rangeValid) apply({ kind: "range", from: fromIso, to: toIso });
          }}
        >
          <p className="font-medium">
            From – to{" "}
            <span className="font-normal text-muted-foreground">
              ({timeZone === "utc" ? "UTC" : "local time"})
            </span>
          </p>
          <Input
            type="datetime-local"
            aria-label="From"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-7 text-xs"
          />
          <Input
            type="datetime-local"
            aria-label="To"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-7 text-xs"
          />
          <div className="flex items-center gap-2">
            <p className="text-muted-foreground">A fixed range is not followed live.</p>
            <Button type="submit" size="xs" className="ml-auto" disabled={!rangeValid}>
              Apply
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
