import { useEffect, useState } from "react";
import { MonitorIcon, MoonIcon, SettingsIcon, SunIcon } from "lucide-react";
import { cn } from "cn";
import type { Accent, ColorMode, TimeZone } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { usePrefs } from "@/stores/prefs";

/** One option of a {@link Choice}. */
interface Option<T extends string> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

/** A row of mutually exclusive buttons (a radio group). */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-sm">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex rounded-md border border-border p-0.5"
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            onClick={() => onChange(option.value)}
            className={cn(
              "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              option.value === value
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const COLOR_MODES: Option<ColorMode>[] = [
  { value: "system", label: "System", icon: <MonitorIcon className="size-3.5" /> },
  { value: "light", label: "Light", icon: <SunIcon className="size-3.5" /> },
  { value: "dark", label: "Dark", icon: <MoonIcon className="size-3.5" /> },
];

/** Swatch colours (Tailwind 500), only for the picker itself. */
const ACCENTS: { value: Accent; label: string; swatch: string }[] = [
  { value: "sky", label: "Sky", swatch: "bg-sky-500" },
  { value: "blue", label: "Blue", swatch: "bg-blue-500" },
  { value: "green", label: "Green", swatch: "bg-green-500" },
  { value: "violet", label: "Violet", swatch: "bg-violet-500" },
  { value: "orange", label: "Orange", swatch: "bg-orange-500" },
  { value: "rose", label: "Rose", swatch: "bg-rose-500" },
  { value: "neutral", label: "Neutral", swatch: "bg-foreground" },
];

const TIME_ZONES: Option<TimeZone>[] = [
  { value: "local", label: "Local time" },
  { value: "utc", label: "UTC" },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/** The settings dialog. Changes apply and are saved immediately. Opens with ⌘, / Ctrl+,. */
export function SettingsDialog({ version, demo }: { version?: string; demo: boolean }) {
  const [open, setOpen] = useState(false);
  const settings = usePrefs((s) => s.prefs.settings);
  const update = usePrefs((s) => s.updateSettings);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        setOpen(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Settings" title="Settings (⌘,)">
          <SettingsIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Changes apply right away and are saved on this machine.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <Section title="Appearance">
            <Choice
              label="Colour mode"
              value={settings.colorMode}
              options={COLOR_MODES}
              onChange={(colorMode) => void update({ colorMode })}
            />
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm">Accent colour</span>
              <div role="radiogroup" aria-label="Accent colour" className="flex gap-1.5">
                {ACCENTS.map((accent) => (
                  <button
                    key={accent.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.accent === accent.value}
                    aria-label={accent.label}
                    title={accent.label}
                    onClick={() => void update({ accent: accent.value })}
                    className={cn(
                      "size-6 rounded-full outline-none ring-offset-2 ring-offset-background focus-visible:ring-2 focus-visible:ring-ring",
                      accent.swatch,
                      settings.accent === accent.value && "ring-2 ring-foreground",
                    )}
                  />
                ))}
              </div>
            </div>
          </Section>

          <Section title="Time">
            <Choice
              label="Timestamps"
              value={settings.timeZone}
              options={TIME_ZONES}
              onChange={(timeZone) => void update({ timeZone })}
            />
          </Section>

          <p className="text-xs text-muted-foreground">
            Contrail {version ? `v${version}` : ""}
            {demo && " · demo mode (settings are not saved)"}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
