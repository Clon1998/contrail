import { useState, type ReactNode } from "react";
import { ArrowRightIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "cn";
import type { LogEvent } from "@/bindings";
import { Button } from "@/components/ui/button";
import {
  classifyTrace,
  formatFullTime,
  prettyJson,
  splitEmbeddedJson,
  tokenizeJson,
  type JsonToken,
  type TraceLineKind,
} from "@/lib/logs";
import { appendTerm, fieldTerm } from "@/lib/highlight";
import { useLogs } from "@/stores/logs";
import { usePrefs } from "@/stores/prefs";
import { CopyButton } from "@/components/CopyButton";
import { Ansi } from "./Ansi";
import { LineContextDialog } from "./LineContextDialog";
import { useLineActions, type LineAction } from "./lineActions";
import { StateBadge } from "./StateBadge";

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

/**
 * A pipeline status change: the transition, the document's correlation ID and its topic, then
 * `actions` for the document.
 */
export function StatusSummary({ event, actions }: { event: LogEvent; actions?: ReactNode }) {
  const status = event.status;
  if (!status) return null;
  const id = status.correlationId;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-sans text-xs">
      <span className="flex items-center gap-1.5">
        {status.previousState ? (
          <StateBadge state={status.previousState} />
        ) : (
          <span className="text-muted-foreground">new</span>
        )}
        <ArrowRightIcon className="size-3 text-muted-foreground" />
        <StateBadge state={status.state} />
      </span>
      {status.topic && (
        <span className="text-muted-foreground">
          topic <span className="font-mono text-foreground">{status.topic}</span>
        </span>
      )}
      {id && (
        <span className="text-muted-foreground">
          document <span className="font-mono text-foreground">{id}</span>
        </span>
      )}
      {id && actions}
    </div>
  );
}

/** A line's action as a small button (copy actions say "Copied" for a moment). */
function ActionButton({ action }: { action: LineAction }) {
  if (action.copy !== undefined) return <CopyButton label={action.label} text={action.copy} />;
  const Icon = action.icon;
  return (
    <Button variant="outline" size="xs" tooltip={action.hint} onClick={action.run}>
      <Icon /> {action.label}
    </Button>
  );
}

/** The expanded view of one event in a service's log view: actions, then the event itself. */
export function LogDetails({
  event,
  nested = false,
}: {
  event: LogEvent;
  /** Shown among the surrounding lines: no way to open them again from there. */
  nested?: boolean;
}) {
  const query = useLogs((s) => s.search.query);
  const setSearch = useLogs((s) => s.setSearch);
  const view = useLogs((s) => s.view);
  const filterBy = (term: string) => void setSearch({ query: appendTerm(query, term) });
  const [aroundOpen, setAroundOpen] = useState(false);
  const { actions, documentActions } = useLineActions(
    event,
    nested ? undefined : () => setAroundOpen(true),
  );

  return (
    <div className="space-y-3 border-l-2 border-primary/60 bg-muted/30 py-2 pr-4 pl-4">
      <div className="flex flex-wrap gap-1.5">
        {actions.map((action) => (
          <ActionButton key={action.label} action={action} />
        ))}
        {view && aroundOpen && (
          <LineContextDialog viewId={view.viewId} event={event} open onOpenChange={setAroundOpen} />
        )}
      </div>

      {event.status && (
        <StatusSummary
          event={event}
          actions={documentActions.map((action) => (
            <ActionButton key={action.label} action={action} />
          ))}
        />
      )}

      <EventBody event={event} onField={filterBy} />
    </div>
  );
}

/**
 * An event's content: message (with embedded JSON), error and stack trace, fields, raw JSON.
 * With `onField`, a field's value adds a search term when clicked.
 */
export function EventBody({
  event,
  onField,
}: {
  event: LogEvent;
  onField?: (term: string) => void;
}) {
  const { line } = event;
  const timeZone = usePrefs((s) => s.prefs.settings.timeZone);
  const embedded = splitEmbeddedJson(line.message, line.jsonSpan);
  const embeddedPretty = embedded ? prettyJson(embedded.json) : null;
  const rawPretty = line.kind === "ecs" || line.kind === "json" ? prettyJson(event.raw) : null;

  return (
    <>
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

      <dl
        aria-label="Fields"
        className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-0.5"
      >
        {/* The event's time with its date, whatever the line's format (the list shows less). */}
        <div className="contents">
          <dt className="text-muted-foreground">time</dt>
          <dd className="tabular-nums">{formatFullTime(event.timestamp, timeZone)}</dd>
        </div>
        {line.fields.map((field) => (
          <div key={field.key} className="contents">
            <dt className="text-muted-foreground">{field.key}</dt>
            <dd className="break-all">
              {onField ? (
                <button
                  type="button"
                  title="Add to the search"
                  onClick={() => onField(fieldTerm(field.key, String(field.value)))}
                  className="text-left hover:text-primary hover:underline"
                >
                  {String(field.value)}
                </button>
              ) : (
                String(field.value)
              )}
            </dd>
          </div>
        ))}
      </dl>

      {rawPretty && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Raw JSON</summary>
          <JsonView json={rawPretty} label="Raw JSON" />
        </details>
      )}

      <p className="text-muted-foreground">
        {line.kind} · {event.stream}
      </p>
    </>
  );
}
