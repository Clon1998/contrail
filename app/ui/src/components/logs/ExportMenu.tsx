import { useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { DownloadIcon } from "lucide-react";
import { commands, type ExportFormat } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogs } from "@/stores/logs";

const FORMATS: { format: ExportFormat; extension: string; label: string }[] = [
  { format: "log", extension: "log", label: "Raw lines (.log)" },
  { format: "jsonl", extension: "jsonl", label: "JSON Lines (.jsonl)" },
];

/** `orders-api-20260301-1004` */
function defaultName(service: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  return `${service}-${date}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** Saves the listed rows (the matches, when filtering) to a file. */
export function ExportMenu() {
  const view = useLogs((s) => s.view);
  const service = useLogs((s) => s.service);
  const filtering = useLogs((s) => s.search.mode === "filter" && s.matches !== null);
  const [status, setStatus] = useState<string | null>(null);
  if (!view || !service) return null;

  async function exportAs(format: ExportFormat, extension: string) {
    if (!view || !service) return;
    const path = await save({
      defaultPath: `${defaultName(service.serviceName)}.${extension}`,
      filters: [{ name: extension, extensions: [extension] }],
    });
    if (!path) return;
    const result = await commands.exportLogView(view.viewId, path, format);
    setStatus(
      result.status === "ok"
        ? `Exported ${result.data.toLocaleString()} events`
        : `Export failed: ${result.error.message}`,
    );
    setTimeout(() => setStatus(null), 5_000);
  }

  return (
    <>
      {status && (
        <span role="status" className="text-muted-foreground">
          {status}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Export">
            <DownloadIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>
            {filtering ? "Export the matches" : "Export all events"}
          </DropdownMenuLabel>
          {FORMATS.map(({ format, extension, label }) => (
            <DropdownMenuItem key={format} onSelect={() => void exportAs(format, extension)}>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
