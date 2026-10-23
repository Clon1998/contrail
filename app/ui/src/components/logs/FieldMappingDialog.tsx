import { useState } from "react";
import { BracesIcon } from "lucide-react";
import type { FieldMapping } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { noiseKey, usePrefs } from "@/stores/prefs";

const PARTS: { key: keyof FieldMapping; label: string; defaults: string }[] = [
  { key: "message", label: "Message", defaults: "message, msg, log" },
  { key: "level", label: "Level", defaults: "log.level, level, severity, lvl" },
  { key: "timestamp", label: "Timestamp", defaults: "@timestamp, timestamp, time, ts" },
];

/** Field names seen in the loaded rows, for suggestions. */
function useFieldKeys(): string[] {
  const pages = useLogs((s) => s.pages);
  const keys = new Set<string>();
  for (const rows of pages.values()) {
    for (const row of rows) for (const field of row.line.fields) keys.add(field.key);
  }
  return [...keys].sort();
}

/**
 * Which JSON fields hold a service's message, level and timestamp, for logs that use other
 * names than ECS or the common ones. Saving reloads the view.
 */
export function FieldMappingDialog() {
  const service = useLogs((s) => s.service);
  const taskId = useLogs((s) => s.taskId);
  const timeWindow = useLogs((s) => s.timeWindow);
  const open = useLogs((s) => s.open);
  const ctx = useEcs((s) => s.ctx);
  const profile = useLogs((s) => s.profile);
  const saved = usePrefs((s) =>
    profile && service ? s.prefs.fieldMappings[noiseKey(profile, service)] : undefined,
  );
  const setFieldMapping = usePrefs((s) => s.setFieldMapping);
  const keys = useFieldKeys();
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState<FieldMapping>({ message: null, level: null, timestamp: null });
  if (!service || !profile || !ctx) return null;

  async function save(mapping: FieldMapping) {
    if (!service || !profile || !ctx) return;
    const clean = (v: string | null) => (v?.trim() ? v.trim() : null);
    await setFieldMapping(profile, service, {
      message: clean(mapping.message),
      level: clean(mapping.level),
      timestamp: clean(mapping.timestamp),
    });
    setShown(false);
    await open(ctx, service, timeWindow, taskId);
  }

  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => {
        if (next) setDraft(saved ?? { message: null, level: null, timestamp: null });
        setShown(next);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Field mapping"
          title="Field mapping"
          className={saved ? "text-primary" : undefined}
        >
          <BracesIcon />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Field mapping</DialogTitle>
          <DialogDescription>
            For JSON logs of {service.serviceName} that name these fields differently. Leave a field
            empty to use the defaults. Saved per service; the view reloads.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft);
          }}
        >
          {PARTS.map((part) => (
            <label key={part.key} className="block space-y-1 text-sm">
              <span>{part.label}</span>
              <Input
                aria-label={`${part.label} field`}
                list="field-mapping-keys"
                placeholder={part.defaults}
                value={draft[part.key] ?? ""}
                onChange={(e) => setDraft({ ...draft, [part.key]: e.target.value })}
                className="font-mono"
              />
            </label>
          ))}
          <datalist id="field-mapping-keys">
            {keys.map((key) => (
              <option key={key} value={key} />
            ))}
          </datalist>
          <DialogFooter>
            {saved && (
              <Button
                type="button"
                variant="outline"
                onClick={() => void save({ message: null, level: null, timestamp: null })}
              >
                Use defaults
              </Button>
            )}
            <Button type="submit">Save and reload</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
