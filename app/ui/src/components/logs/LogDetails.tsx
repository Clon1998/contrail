import { useState } from "react";
import { CheckIcon, ChevronRightIcon, CopyIcon, EyeOffIcon } from "lucide-react";
import { cn } from "cn";
import type { LogEvent } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  classifyTrace,
  prettyJson,
  splitEmbeddedJson,
  tokenizeJson,
  type JsonToken,
  type TraceLineKind,
} from "@/lib/logs";
import { appendTerm, fieldTerm } from "@/lib/highlight";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { Ansi } from "./Ansi";

/** Stack traces longer than this start collapsed. */
const COLLAPSED_TRACE_LINES = 12;

const TOKEN_CLASS: Record<JsonToken["kind"], string> = {
  key: "text-sky-600 dark:text-sky-300",
  string: "text-amber-700 dark:text-amber-200",
  number: "text-fuchsia-600 dark:text-fuchsia-300",
  literal: "text-rose-600 dark:text-rose-300",
  punctuation: "text-muted-foreground",
};

const TRACE_CLASS: Record<TraceLineKind, string> = {
  header: "text-destructive font-semibold",
  frame: "",
  causedBy: "text-destructive font-semibold",
  omitted: "text-muted-foreground",
  other: "",
};

/** Pretty JSON with coloured keys, strings and numbers. */
function JsonView({ json, label }: { json: string; label: string }) {
  return (
    <pre aria-label={label} className="overflow-x-auto whitespace-pre">
      {tokenizeJson(json).map((token, i) => (
        <span key={i} className={TOKEN_CLASS[token.kind]}>
          {token.text}
        </span>
      ))}
    </pre>
  );
}

function CopyButton({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? "Copied" : label}
    </Button>
  );
}

function StackTrace({ trace }: { trace: string }) {
  const lines = classifyTrace(trace);
  const [open, setOpen] = useState(lines.length <= COLLAPSED_TRACE_LINES);
  const shown = open ? lines : lines.slice(0, 3);
  return (
    <div>
      <pre aria-label="Stack trace" className="overflow-x-auto whitespace-pre">
        {shown.map((line, i) => (
          <div key={i} className={TRACE_CLASS[line.kind]}>
            {line.text}
          </div>
        ))}
      </pre>
      {lines.length > COLLAPSED_TRACE_LINES && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 flex items-center gap-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon className={cn("size-3", open && "rotate-90")} />
          {open ? "Collapse stack trace" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

/** The expanded view of one event: message, error, fields, raw JSON and copy actions. */
export function LogDetails({ event }: { event: LogEvent }) {
  const { line } = event;
  const query = useLogs((s) => s.search.query);
  const setSearch = useLogs((s) => s.setSearch);
  const applySearch = useLogs((s) => s.applySearch);
  const service = useLogs((s) => s.service);
  const profile = useLogs((s) => s.profile);
  const addNoise = usePrefs((s) => s.addNoise);
  const filterBy = (term: string) => void setSearch({ query: appendTerm(query, term) });
  // The first line of the message, cut at 80 characters: specific enough, short enough to read.
  const noiseText = (line.message.split("\n", 1)[0] ?? "").trim().slice(0, 80);
  const embedded = splitEmbeddedJson(line.message, line.jsonSpan);
  const embeddedPretty = embedded ? prettyJson(embedded.json) : null;
  const rawPretty = line.kind === "ecs" || line.kind === "json" ? prettyJson(event.raw) : null;

  return (
    <div className="space-y-3 border-l-2 border-primary/60 bg-muted/30 py-2 pr-4 pl-4">
      <div className="flex flex-wrap gap-1.5">
        <CopyButton label="Copy message" text={line.message} />
        {rawPretty && <CopyButton label="Copy JSON" text={rawPretty} />}
        <CopyButton label="Copy as single line" text={event.raw.replace(/\s*\n\s*/g, " ")} />
        {profile && service && noiseText && (
          <Button
            variant="outline"
            size="xs"
            tooltip={`Hide lines containing “${noiseText}” in this service`}
            onClick={() => void addNoise(profile, service, noiseText).then(applySearch)}
          >
            <EyeOffIcon /> Hide lines like this
          </Button>
        )}
      </div>

      <div className="whitespace-pre-wrap break-words">
        {embedded && embeddedPretty ? (
          <>
            <Ansi text={embedded.before} />
            <JsonView json={embeddedPretty} label="Embedded JSON" />
            <Ansi text={embedded.after} />
          </>
        ) : (
          <Ansi text={line.message} />
        )}
      </div>

      {line.error && (
        <div className="space-y-1">
          {/* The trace's first line already says "type: message". */}
          {!line.error.stackTrace && (line.error.errorType ?? line.error.message) && (
            <p className="text-destructive">
              {line.error.errorType}
              {line.error.message && `: ${line.error.message}`}
            </p>
          )}
          {line.error.stackTrace && <StackTrace trace={line.error.stackTrace} />}
        </div>
      )}

      {line.fields.length > 0 && (
        <dl
          aria-label="Fields"
          className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5"
        >
          {line.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="text-muted-foreground">{field.key}</dt>
              <dd className="break-all">
                <button
                  type="button"
                  title="Add to the search"
                  onClick={() => filterBy(fieldTerm(field.key, String(field.value)))}
                  className="text-left hover:text-primary hover:underline"
                >
                  {String(field.value)}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {rawPretty && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw JSON</summary>
          <JsonView json={rawPretty} label="Raw JSON" />
        </details>
      )}

      <p className="text-muted-foreground">
        {line.kind} · {event.stream}
      </p>
    </div>
  );
}
