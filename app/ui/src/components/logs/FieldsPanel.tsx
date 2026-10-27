import { useEffect, useRef, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import {
  commands,
  type DocumentGroup,
  type FieldStats,
  type FieldSummary,
  type Outcome,
  type PipelineSummary,
} from "@/bindings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fieldTerm,
  hasTerm,
  phraseTerm,
  replaceTerm,
  termValue,
  toggleTerm,
} from "@/lib/queryTerms";
import { useLogs } from "@/stores/logs";
import { stateTone } from "./states";

/** While events keep arriving, the panel counts again at most this often. */
const REFRESH_MS = 1_000;

/**
 * The view's field summary, counted again when a search is applied (right away) and while events
 * arrive or older ones are loaded (at most every `REFRESH_MS`). Only while the panel is shown.
 */
function useFieldSummary(): FieldSummary | null {
  const view = useLogs((s) => s.view);
  const revision = useLogs((s) => s.searchRevision);
  const [summary, setSummary] = useState<FieldSummary | null>(null);
  const last = useRef({ at: 0, revision: -1 });
  const viewId = view?.viewId;

  useEffect(() => {
    if (viewId === undefined) return;
    let current = true;
    const searched = last.current.revision !== revision;
    const wait = searched ? 0 : Math.max(0, last.current.at + REFRESH_MS - Date.now());
    const timer = setTimeout(() => {
      last.current = { at: Date.now(), revision };
      void commands.fieldSummary(viewId).then((result) => {
        if (current && result.status === "ok") setSummary(result.data);
      });
    }, wait);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `view` changes with every live update (its stats), which is when to count again.
  }, [viewId, view, revision]);

  return summary;
}

/** How the panel changes the search: the query with a term added, removed or replaced. */
interface Terms {
  query: string;
  /** `null` in regex mode, where the query isn't query syntax. */
  apply: ((query: string) => void) | null;
}

function percent(count: number, total: number): string {
  if (total === 0) return "0%";
  const value = (count / total) * 100;
  return value < 1 && count > 0 ? "<1%" : `${Math.round(value)}%`;
}

/**
 * The Fields panel beside the log list (like Splunk's field sidebar): the fields of the events
 * that match the search, their most common values, and an overview of the pipeline status events.
 * A click on a value adds it to the search (Alt+click excludes it), so the counts narrow down.
 */
export function FieldsPanel() {
  const summary = useFieldSummary();
  const query = useLogs((s) => s.search.query);
  const regex = useLogs((s) => s.search.regex);
  const setSearch = useLogs((s) => s.setSearch);
  const setOpen = useLogs((s) => s.setFieldsOpen);
  const terms: Terms = {
    query,
    apply: regex ? null : (next) => void setSearch({ query: next }),
  };

  return (
    <aside
      aria-label="Fields"
      className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-border text-xs"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <h2 className="font-medium">Fields</h2>
        {summary && (
          <span className="text-muted-foreground tabular-nums">
            {summary.events.toLocaleString()} {query.trim() ? "matching events" : "events"}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label="Close fields"
          tooltip="Close the Fields panel (F)"
          onClick={() => setOpen(false)}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {regex && (
          <p className="border-b border-border px-3 py-1.5 text-muted-foreground">
            Regex mode: switch it off to filter by clicking a value.
          </p>
        )}
        {summary?.pipeline && <PipelineSection pipeline={summary.pipeline} terms={terms} />}
        {summary ? (
          <FieldList summary={summary} terms={terms} />
        ) : (
          <div role="status" aria-label="Counting fields" className="flex flex-col gap-2.5 p-3">
            {["w-1/3", "w-2/3", "w-1/2", "w-1/4", "w-3/5", "w-2/5"].map((width) => (
              <Skeleton key={width} className={cn("h-3.5", width)} />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  inProgress: "In progress",
  failed: "Failed",
  completed: "Completed",
  published: "Published",
  retried: "Retried",
};

const OUTCOME_HINT: Record<Outcome, string> = {
  inProgress: "Last seen while being worked on: still running, or stuck",
  failed: "Last state FAILED",
  completed: "Last state COMPLETED",
  published: "Handed on to Kafka: where an input service's part ends",
  retried: "Went through RETRYING (also counted under its outcome)",
};

/** Pipeline status events: states, states per topic, documents and why they failed. */
function PipelineSection({ pipeline, terms }: { pipeline: PipelineSummary; terms: Terms }) {
  const { query, apply } = terms;
  const state = termValue(query, "state:")?.toUpperCase() ?? null;
  const topic = termValue(query, "topic:");
  const correlation = termValue(query, "correlation:");
  const setState = (value: string | null, next = query) =>
    replaceTerm(next, "state:", value ? `state:${value}` : null);
  const setTopic = (value: string | null, next = query) =>
    replaceTerm(next, "topic:", value ? fieldTerm("topic", value) : null);
  const columns = pipeline.states.map((s) => s.value);
  // A chosen state stays visible (and can be switched off) when its count drops to 0.
  const states =
    state && !columns.some((c) => c.toUpperCase() === state)
      ? [...pipeline.states, { value: state, count: 0 }]
      : pipeline.states;
  const reasonTerm = (reason: string) =>
    pipeline.prefix ? fieldTerm(`${pipeline.prefix}.message`, reason) : phraseTerm(reason);

  return (
    <section aria-label="Pipeline" className="space-y-3 border-b border-border px-3 py-2">
      <div>
        <SectionTitle>
          Pipeline · {pipeline.events.toLocaleString()} status{" "}
          {pipeline.events === 1 ? "event" : "events"}
        </SectionTitle>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Pipeline states">
          {states.map(({ value, count }) => {
            const active = state === value.toUpperCase();
            return (
              <button
                key={value}
                type="button"
                disabled={!apply}
                aria-label={`${value} ${count}`}
                aria-pressed={active}
                onClick={() => apply?.(setState(active ? null : value))}
                className={cn(
                  "rounded border px-1.5 py-0.5 tabular-nums",
                  stateTone(value),
                  active && "bg-accent",
                  state && !active && "opacity-50",
                )}
              >
                {value} {count.toLocaleString()}
              </button>
            );
          })}
        </div>
      </div>

      {pipeline.topics.length > 0 && (
        <div>
          <SectionTitle>States per topic</SectionTitle>
          <ul aria-label="States per topic" className="space-y-1">
            {pipeline.topics.map((row) => {
              const rowActive = topic?.toLowerCase() === row.topic.toLowerCase();
              return (
                <li key={row.topic}>
                  <button
                    type="button"
                    disabled={!apply}
                    aria-pressed={rowActive}
                    title={row.topic}
                    onClick={() => apply?.(setTopic(rowActive ? null : row.topic))}
                    className={cn(
                      "block w-full truncate rounded px-1 text-left font-mono hover:bg-accent",
                      rowActive && "bg-accent",
                    )}
                  >
                    {row.topic}
                  </button>
                  <div className="flex flex-wrap gap-1 px-1 pt-0.5">
                    {row.states.map(({ value, count }) => {
                      const active = rowActive && state === value.toUpperCase();
                      return (
                        <button
                          key={value}
                          type="button"
                          disabled={!apply}
                          aria-label={`${row.topic} ${value} ${count}`}
                          aria-pressed={active}
                          onClick={() =>
                            apply?.(
                              active
                                ? setState(null, setTopic(null))
                                : setTopic(row.topic, setState(value)),
                            )
                          }
                          className={cn(
                            "rounded border px-1 text-[10px] tabular-nums",
                            stateTone(value),
                            active && "bg-accent",
                          )}
                        >
                          {value} {count.toLocaleString()}
                        </button>
                      );
                    })}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {pipeline.documents.total > 0 && (
        <div>
          <SectionTitle>Documents · {pipeline.documents.total.toLocaleString()}</SectionTitle>
          <ul aria-label="Documents" className="space-y-0.5">
            {[...pipeline.documents.outcomes, pipeline.documents.retried]
              .filter((group) => group.count > 0)
              .map((group) => (
                <DocumentRow
                  key={group.outcome}
                  group={group}
                  total={pipeline.documents.total}
                  correlation={correlation}
                  onPick={
                    apply &&
                    ((id) =>
                      apply(
                        replaceTerm(
                          query,
                          "correlation:",
                          correlation === id ? null : fieldTerm("correlation", id),
                        ),
                      ))
                  }
                />
              ))}
          </ul>
        </div>
      )}

      {pipeline.failureReasons.length > 0 && (
        <div>
          <SectionTitle>Failure reasons</SectionTitle>
          <ul aria-label="Failure reasons" className="space-y-0.5">
            {pipeline.failureReasons.map(({ value, count }) => {
              const term = reasonTerm(value);
              const active = hasTerm(query, term);
              return (
                <li key={value}>
                  <button
                    type="button"
                    disabled={!apply}
                    aria-pressed={active}
                    title={value}
                    onClick={() =>
                      apply?.(
                        active ? toggleTerm(query, term) : toggleTerm(setState("FAILED"), term),
                      )
                    }
                    className={cn(
                      "flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-accent",
                      active && "bg-accent",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate text-destructive">{value.trim()}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {count.toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

const OUTCOME_STATE: Record<Outcome, string> = {
  inProgress: "CONSUMING",
  failed: "FAILED",
  completed: "COMPLETED",
  published: "PUBLISHED",
  retried: "RETRYING",
};

/** One outcome of the documents; expands to its newest correlation IDs. */
function DocumentRow({
  group,
  total,
  correlation,
  onPick,
}: {
  group: DocumentGroup;
  total: number;
  correlation: string | null;
  onPick: ((id: string) => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const label = OUTCOME_LABEL[group.outcome];
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        title={OUTCOME_HINT[group.outcome]}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        {open ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
        <span className={cn("rounded border px-1", stateTone(OUTCOME_STATE[group.outcome]))}>
          {label}
        </span>
        <span className="ml-auto tabular-nums">{group.count.toLocaleString()}</span>
        <span className="w-9 text-right text-muted-foreground tabular-nums">
          {percent(group.count, total)}
        </span>
      </button>
      {open && (
        <ul aria-label={`${label} documents`} className="ml-4 py-0.5">
          {group.ids.map((id) => (
            <li key={id}>
              <button
                type="button"
                disabled={!onPick}
                aria-pressed={correlation?.toLowerCase() === id.toLowerCase()}
                onClick={() => onPick?.(id)}
                className={cn(
                  "w-full truncate rounded px-1 text-left font-mono hover:bg-accent",
                  correlation?.toLowerCase() === id.toLowerCase() && "bg-accent",
                )}
              >
                {id}
              </button>
            </li>
          ))}
          {group.count > group.ids.length && (
            <li className="px-1 text-muted-foreground">
              and {(group.count - group.ids.length).toLocaleString()} more
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** All fields of the matching events, most common first, with a filter by name. */
function FieldList({ summary, terms }: { summary: FieldSummary; terms: Terms }) {
  const [filter, setFilter] = useState("");
  const expanded = useLogs((s) => s.fieldsExpanded);
  const toggle = useLogs((s) => s.toggleFieldExpanded);
  const needle = filter.trim().toLowerCase();
  const fields = needle
    ? summary.fields.filter((f) => f.key.toLowerCase().includes(needle))
    : summary.fields;

  return (
    <section aria-label="All fields" className="px-3 py-2">
      <SectionTitle>All fields · {summary.fields.length}</SectionTitle>
      <Input
        aria-label="Filter fields"
        placeholder="Filter fields…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="mb-1.5 h-6 text-xs"
      />
      {summary.fields.length === 0 && (
        <p className="text-muted-foreground">These events have no structured fields.</p>
      )}
      <ul className="space-y-0.5">
        {fields.map((field) => (
          <FieldRow
            key={field.key}
            field={field}
            events={summary.events}
            open={expanded.includes(field.key)}
            onToggle={() => toggle(field.key)}
            terms={terms}
          />
        ))}
      </ul>
      {fields.length > 0 && (
        <p className="mt-2 text-muted-foreground">Click a value to filter, Alt+click to exclude.</p>
      )}
    </section>
  );
}

function FieldRow({
  field,
  events,
  open,
  onToggle,
  terms,
}: {
  field: FieldStats;
  events: number;
  open: boolean;
  onToggle: () => void;
  terms: Terms;
}) {
  const { query, apply } = terms;
  // ID-like: every value seen once, so a top 10 says nothing.
  const unique = (field.top[0]?.count ?? 0) <= 1 && field.distinct > field.top.length;
  const distinct = `${field.distinct.toLocaleString()}${field.moreDistinct ? "+" : ""}`;

  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-accent"
      >
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono" title={field.key}>
          {field.key}
        </span>
        <span
          className="w-9 text-right text-muted-foreground tabular-nums"
          title={`In ${field.count.toLocaleString()} of ${events.toLocaleString()} events`}
        >
          {percent(field.count, events)}
        </span>
      </button>
      {open && (
        <ul aria-label={`Values of ${field.key}`} className="mb-1 ml-4">
          {unique ? (
            <li className="px-1 py-0.5 text-muted-foreground">
              {distinct} distinct values, none more than once.
            </li>
          ) : (
            field.top.map(({ value, count }) => {
              const include = fieldTerm(field.key, value);
              const exclude = fieldTerm(field.key, value, true);
              const included = hasTerm(query, include);
              const excluded = hasTerm(query, exclude);
              return (
                <li key={value}>
                  <button
                    type="button"
                    disabled={!apply}
                    aria-pressed={included}
                    title={value}
                    onClick={(e) => apply?.(toggleTerm(query, e.altKey ? exclude : include))}
                    className={cn(
                      "relative flex w-full items-baseline gap-2 overflow-hidden rounded px-1 py-0.5 text-left hover:bg-accent",
                      included && "bg-accent",
                    )}
                  >
                    <span
                      aria-hidden
                      className="absolute inset-y-0 left-0 bg-primary/10"
                      style={{ width: `${(count / field.count) * 100}%` }}
                    />
                    <span
                      className={cn(
                        "relative min-w-0 flex-1 truncate font-mono",
                        excluded && "text-muted-foreground line-through",
                      )}
                    >
                      {value === "" ? <em>empty</em> : value}
                    </span>
                    <span className="relative text-muted-foreground tabular-nums">
                      {count.toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })
          )}
          {!unique && (
            <li className="px-1 text-muted-foreground">
              {distinct} distinct {field.distinct === 1 ? "value" : "values"}
              {field.distinct > field.top.length && `, the ${field.top.length} most common shown`}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}
