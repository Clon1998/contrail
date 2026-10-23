import { type ReactNode, useEffect, useId, useState } from "react";
import { CheckIcon, SettingsIcon } from "lucide-react";
import { cn } from "cn";
import type { Accent, ColorMode, TimeZone } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BACKFILL_WINDOWS } from "@/lib/logs";
import { usePrefs } from "@/stores/prefs";

type Section = "appearance" | "logs" | "about";

const SECTIONS: { value: Section; label: string }[] = [
  { value: "appearance", label: "Appearance" },
  { value: "logs", label: "Logs" },
  { value: "about", label: "About" },
];

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The swatch colours match the accent colours in index.css. */
const ACCENTS: { value: Accent; label: string; swatch: string }[] = [
  { value: "neutral", label: "Neutral", swatch: "bg-foreground" },
  { value: "sky", label: "Sky", swatch: "bg-sky-500" },
  { value: "blue", label: "Blue", swatch: "bg-blue-600" },
  { value: "green", label: "Green", swatch: "bg-green-600" },
  { value: "violet", label: "Violet", swatch: "bg-violet-600" },
  { value: "orange", label: "Orange", swatch: "bg-orange-600" },
  { value: "rose", label: "Rose", swatch: "bg-rose-600" },
];

const TIME_ZONES: { value: TimeZone; label: string }[] = [
  { value: "local", label: "Local time" },
  { value: "utc", label: "UTC" },
];

/**
 * App settings (⌘, / Ctrl+,), stored on this computer. Every change is saved and applied right
 * away; there is no "Save" button. Same layout as Frida's settings.
 */
export function SettingsDialog({ version, demo }: { version?: string; demo: boolean }) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<Section>("appearance");
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
      <DialogContent className="gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            {demo
              ? "Demo mode: changes apply right away but are not saved."
              : "Stored on this computer only. Changes apply right away."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex h-[min(28rem,calc(100dvh-9rem))] min-h-0">
          <nav
            aria-label="Settings sections"
            className="flex w-40 shrink-0 flex-col gap-0.5 border-r p-2"
          >
            {SECTIONS.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-current={section === s.value ? "page" : undefined}
                onClick={() => setSection(s.value)}
                className={cn(
                  "rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                  section === s.value && "bg-accent font-medium",
                )}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-auto p-5">
            {section === "appearance" && (
              <Rows>
                <Row label="Theme">
                  <div className="flex gap-1">
                    {COLOR_MODES.map((mode) => (
                      <Button
                        key={mode.value}
                        size="sm"
                        variant={settings.colorMode === mode.value ? "default" : "outline"}
                        aria-pressed={settings.colorMode === mode.value}
                        onClick={() => void update({ colorMode: mode.value })}
                      >
                        {mode.label}
                      </Button>
                    ))}
                  </div>
                </Row>
                <Row label="Accent color" hint="Buttons, focus rings and highlights.">
                  <div className="flex gap-2">
                    {ACCENTS.map((accent) => (
                      <button
                        key={accent.value}
                        type="button"
                        title={accent.label}
                        aria-label={accent.label}
                        aria-pressed={settings.accent === accent.value}
                        onClick={() => void update({ accent: accent.value })}
                        className={cn(
                          "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background",
                          accent.swatch,
                          settings.accent === accent.value && "ring-2 ring-ring",
                        )}
                      >
                        {settings.accent === accent.value && (
                          <CheckIcon className="size-4 text-background" />
                        )}
                      </button>
                    ))}
                  </div>
                </Row>
                <Row label="UI size">
                  <NumberSelect
                    label="UI size"
                    value={settings.uiScale}
                    options={[80, 90, 100, 110, 125, 150]}
                    format={(n) => `${n}%`}
                    onChange={(uiScale) => void update({ uiScale })}
                  />
                </Row>
                <Row label="Log font size" hint="Log lines and stack traces.">
                  <NumberSelect
                    label="Log font size"
                    value={settings.logFontSize}
                    options={[10, 11, 12, 13, 14, 15, 16, 18]}
                    format={(n) => `${n} px`}
                    onChange={(logFontSize) => void update({ logFontSize })}
                  />
                </Row>
              </Rows>
            )}

            {section === "logs" && (
              <Rows>
                <Row
                  label="Default time window"
                  hint="How far back a service's logs start when you open them."
                >
                  <div className="flex gap-1">
                    {BACKFILL_WINDOWS.map((w) => (
                      <Button
                        key={w.minutes}
                        size="sm"
                        variant={settings.backfillMinutes === w.minutes ? "default" : "outline"}
                        aria-pressed={settings.backfillMinutes === w.minutes}
                        onClick={() => void update({ backfillMinutes: w.minutes })}
                      >
                        {w.label}
                      </Button>
                    ))}
                  </div>
                </Row>
                <Row
                  label="Live tail"
                  hint="CloudWatch bills Live Tail per session minute. Paused tails catch up when they resume."
                >
                  <label className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={settings.pauseWhenHidden}
                      onCheckedChange={(checked) =>
                        void update({ pauseWhenHidden: checked === true })
                      }
                    />
                    Pause while Contrail is hidden or minimized
                  </label>
                </Row>
                <Row label="Pause views in the background after">
                  <NumberSelect
                    label="Pause views in the background after"
                    value={settings.autoPauseMinutes}
                    options={[0, 5, 10, 15, 30, 60]}
                    format={(n) => (n === 0 ? "Never" : `${n} min`)}
                    onChange={(autoPauseMinutes) => void update({ autoPauseMinutes })}
                  />
                </Row>
                <Row
                  label="Buffer size"
                  hint="Events kept per open view (about 1–2 KB each); the oldest are dropped. Applies to views opened from now on."
                >
                  <NumberSelect
                    label="Buffer size"
                    value={settings.bufferSize}
                    options={[25_000, 50_000, 100_000, 200_000, 500_000]}
                    format={(n) => `${n / 1000}k events`}
                    onChange={(bufferSize) => void update({ bufferSize })}
                  />
                </Row>
                <Row label="Timestamps" hint="Log times and dates in tooltips.">
                  <div className="flex gap-1">
                    {TIME_ZONES.map((tz) => (
                      <Button
                        key={tz.value}
                        size="sm"
                        variant={settings.timeZone === tz.value ? "default" : "outline"}
                        aria-pressed={settings.timeZone === tz.value}
                        onClick={() => void update({ timeZone: tz.value })}
                      >
                        {tz.label}
                      </Button>
                    ))}
                  </div>
                </Row>
              </Rows>
            )}

            {section === "about" && (
              <Rows>
                <Row label="Version">
                  <p className="text-sm">
                    Contrail {version ? `v${version}` : ""}
                    {demo && <span className="text-muted-foreground"> · demo mode</span>}
                  </p>
                </Row>
                <Row
                  label="Read-only"
                  hint="Contrail only reads from AWS and never stores credentials; the AWS SDK uses your SSO token cache."
                >
                  <span />
                </Row>
              </Rows>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Rows({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-5">{children}</div>;
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  // Named after its label, so screen readers (and the UI tests) can find "Theme" etc.
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={id}>
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </div>
  );
}

/** A choice of numbers. A value set by hand in the preferences file is listed too. */
function NumberSelect({
  label,
  value,
  options,
  format,
  onChange,
}: {
  label: string;
  value: number;
  options: number[];
  format: (n: number) => string;
  onChange: (n: number) => void;
}) {
  const all = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  return (
    <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
      <SelectTrigger size="sm" className="w-32" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {all.map((n) => (
          <SelectItem key={n} value={String(n)}>
            {format(n)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
