import { useEffect, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleHelpIcon,
  EyeOffIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { cn } from "cn";
import type { Level } from "@/bindings";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useEcs } from "@/stores/ecs";
import { useLogs } from "@/stores/logs";
import { noiseKey, usePrefs } from "@/stores/prefs";
import { stateTone } from "./states";
import { hiddenForAtLeast, hiddenForOnly, LEVEL_TONE, LEVELS, toggleLevel } from "./levels";
import { Hint } from "@/components/ui/tooltip";

/** Typing pauses this long before the search runs. */
const DEBOUNCE_MS = 200;

const SYNTAX: [string, string][] = [
  ["timeout", "text in the message (any case)"],
  ['"read timed out"', "a phrase"],
  ["/time(out|d out)/", "a regular expression"],
  ["level:ERROR  level>=WARN", "the log level"],
  ["trace.id:abc123", "a field equals"],
  ["log.logger:*Camel*", "a field matches (* and ?)"],
  ["pipeline.offset>=230000", "a number compared (> >= < <=)"],
  ["task:5f2a  message:x", "task ID prefix, message"],
  ["state:FAILED  correlation:DE40…", "pipeline status, one document"],
  ["-healthcheck", "exclude (any term)"],
];

function SyntaxHelp() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Search syntax">
          <CircleHelpIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[28rem] text-xs">
        <p className="mb-2 font-medium">Search syntax</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {SYNTAX.map(([example, meaning]) => (
            <div key={example} className="contents">
              <dt className="font-mono">{example}</dt>
              <dd className="text-muted-foreground">{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 text-muted-foreground">
          All terms must match. Enter / F3: next match, Shift+Enter / Shift+F3: previous. With
          <span className="font-mono"> .*</span> on, the whole search is one regular expression.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** "Hide noise": the toggle and the service's list of hidden texts. */
function NoiseMenu() {
  const service = useLogs((s) => s.service);
  const hideNoise = useLogs((s) => s.search.hideNoise);
  const setSearch = useLogs((s) => s.setSearch);
  const applySearch = useLogs((s) => s.applySearch);
  const profile = useLogs((s) => s.profile);
  const noise = usePrefs((s) => s.prefs.noise);
  const removeNoise = usePrefs((s) => s.removeNoise);
  if (!service || !profile) return null;
  const list = noise[noiseKey(profile, service)] ?? [];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Noise"
          className={cn(list.length > 0 && hideNoise && "text-primary")}
        >
          <EyeOffIcon /> Noise {list.length > 0 && `(${list.length})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 space-y-2 text-xs">
        <label className="flex items-center gap-2">
          <Checkbox
            checked={hideNoise}
            onCheckedChange={(checked) => void setSearch({ hideNoise: checked === true })}
          />
          Hide lines containing these texts
        </label>
        {list.length === 0 ? (
          <p className="text-muted-foreground">
            Nothing yet. Expand a log line and choose “Hide lines like this”.
          </p>
        ) : (
          <ul aria-label="Noise texts" className="space-y-1">
            {list.map((text) => (
              <li key={text} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono" title={text}>
                  {text}
                </span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Show lines like ${text} again`}
                  onClick={() => void removeNoise(profile, service, text).then(applySearch)}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Level chips with counts per level. Click hides or shows a level, middle click shows only that
 * level (again: all), right click opens a menu with all options.
 */
function LevelChips() {
  const stats = useLogs((s) => s.view?.stats);
  const hidden = useLogs((s) => s.search.hiddenLevels);
  const setSearch = useLogs((s) => s.setSearch);
  if (!stats) return null;
  const hide = (hiddenLevels: Level[]) => void setSearch({ hiddenLevels });
  return (
    <span className="flex items-center gap-1" role="group" aria-label="Levels">
      {LEVELS.map((level) => {
        const shown = !hidden.includes(level);
        const count = stats[level.toLowerCase() as Lowercase<Level>];
        return (
          <ContextMenu key={level}>
            <Hint content={"Click: hide or show\nMiddle click: only this level\nRight click: more"}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  aria-pressed={shown}
                  aria-label={`${level} ${count}`}
                  onClick={() => hide(toggleLevel(hidden, level))}
                  // Middle click on mousedown: WebKit sends no `auxclick` (see the tabs).
                  onMouseDown={(e) => {
                    if (e.button === 1) {
                      e.preventDefault();
                      hide(hiddenForOnly(hidden, level));
                    }
                  }}
                  className={cn(
                    "rounded border px-1.5 py-0.5 tabular-nums",
                    shown
                      ? cn("border-border", LEVEL_TONE[level])
                      : "border-transparent text-muted-foreground/50 line-through",
                  )}
                >
                  {level} {count.toLocaleString()}
                </button>
              </ContextMenuTrigger>
            </Hint>
            <ContextMenuContent>
              <ContextMenuLabel>{level}</ContextMenuLabel>
              <ContextMenuItem onSelect={() => hide(LEVELS.filter((l) => l !== level))}>
                Only {level}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => hide(hiddenForAtLeast(level))}>
                {level} and above
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => hide(toggleLevel(hidden, level))}>
                {shown ? `Hide ${level}` : `Show ${level}`}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => hide([])}>Show all levels</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
    </span>
  );
}

/**
 * Pipeline state chips (only for services that log framework status events): counts per state;
 * clicking one filters by that state (again: shows all states).
 */
function StateChips() {
  const states = useLogs((s) => s.view?.stats.states);
  const query = useLogs((s) => s.search.query);
  const setSearch = useLogs((s) => s.setSearch);
  const entries = Object.entries(states ?? {});
  if (entries.length === 0) return null;
  const terms = query.trim().split(/\s+/).filter(Boolean);
  const active = terms
    .find((t) => /^state:/i.test(t))
    ?.slice("state:".length)
    .toUpperCase();
  const choose = (state: string) => {
    const rest = terms.filter((t) => !/^state:/i.test(t));
    const next = active === state ? rest : [...rest, `state:${state}`];
    void setSearch({ query: next.join(" ") });
  };
  return (
    <span className="flex items-center gap-1" role="group" aria-label="Pipeline states">
      {entries.map(([state, count]) => (
        <button
          key={state}
          type="button"
          aria-label={`${state} ${count}`}
          aria-pressed={active === state}
          onClick={() => choose(state)}
          className={cn(
            "rounded border px-1.5 py-0.5 tabular-nums",
            stateTone(state),
            active === state && "bg-accent",
            active && active !== state && "opacity-50",
          )}
        >
          {state} {count.toLocaleString()}
        </button>
      ))}
    </span>
  );
}

/** The search row of the log view. */
export function SearchBar() {
  const search = useLogs((s) => s.search);
  const setSearch = useLogs((s) => s.setSearch);
  const queryError = useLogs((s) => s.queryError);
  const matches = useLogs((s) => s.matches);
  const visible = useLogs((s) => s.visible);
  const total = useLogs((s) => s.view?.stats.total ?? 0);
  const positions = useLogs((s) => s.matchPositions);
  const currentMatch = useLogs((s) => s.currentMatch);
  const scrollTarget = useLogs((s) => s.scrollTarget);
  const gotoMatch = useLogs((s) => s.gotoMatch);
  const selected = useEcs((s) => s.selected);
  const [text, setText] = useState(search.query);
  const input = useRef<HTMLInputElement>(null);

  // Typing → search after a short pause.
  useEffect(() => {
    if (text === search.query) return;
    const timer = setTimeout(() => void setSearch({ query: text }), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, search.query, setSearch]);

  // Click-to-filter and similar change the query from outside: show it.
  const [shownQuery, setShownQuery] = useState(search.query);
  if (shownQuery !== search.query) {
    setShownQuery(search.query);
    setText(search.query);
  }

  const from =
    search.mode === "highlight" ? (positions[currentMatch] ?? -1) : (scrollTarget?.index ?? -1);
  const step = (direction: 1 | -1) => void gotoMatch(direction, from);

  // F3 / Shift+F3 anywhere in the log view; ⌘F / Ctrl+F focuses the search.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "F3") {
        event.preventDefault();
        void gotoMatch(event.shiftKey ? -1 : 1, from);
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [gotoMatch, from]);

  const active = search.query.trim() !== "";
  return (
    <div className="space-y-1 border-b border-border px-4 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className={cn(
            "flex min-w-64 flex-1 items-center gap-1.5 rounded-md border px-2",
            queryError ? "border-destructive" : "border-input",
          )}
        >
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={input}
            aria-label="Search logs"
            aria-invalid={queryError !== null}
            placeholder={
              !selected
                ? "Search"
                : search.regex
                  ? "Regular expression: order \\d+ (failed|timed out)"
                  : "Search: timeout level>=WARN trace.id:abc -health …"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void setSearch({ query: text }).then(() => step(e.shiftKey ? -1 : 1));
              } else if (e.key === "Escape") {
                setText("");
                void setSearch({ query: "" });
              }
            }}
            className="h-7 min-w-0 flex-1 bg-transparent font-mono outline-none"
          />
          {text && (
            <button type="button" aria-label="Clear search" onClick={() => setText("")}>
              <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
            </button>
          )}
        </div>
        <Hint content="Regular expression: the whole search is one regex (Rust syntax, any case)">
          <button
            type="button"
            aria-label="Regular expression"
            aria-pressed={search.regex}
            onClick={() => void setSearch({ regex: !search.regex })}
            className={cn(
              "rounded border px-1.5 py-0.5 font-mono",
              search.regex
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            .*
          </button>
        </Hint>
        <SyntaxHelp />
        <div
          role="radiogroup"
          aria-label="Search mode"
          className="flex rounded-md border border-border p-0.5"
        >
          {(["filter", "highlight"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={search.mode === mode}
              onClick={() => void setSearch({ mode })}
              className={cn(
                "rounded px-2 py-0.5 capitalize",
                search.mode === mode
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <Hint content="Search all fields and the full stack trace, not just the message">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <Checkbox
              checked={search.raw}
              onCheckedChange={(checked) => void setSearch({ raw: checked === true })}
            />
            whole line
          </label>
        </Hint>
        {active && !queryError && (
          <span aria-label="Match count" className="text-muted-foreground tabular-nums">
            {search.mode === "highlight"
              ? `${positions.length > 0 && currentMatch >= 0 ? `${currentMatch + 1} / ` : ""}${(matches ?? 0).toLocaleString()} matches`
              : `${visible.toLocaleString()} of ${total.toLocaleString()}`}
          </span>
        )}
        {active && (
          <span className="flex">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Previous match"
              onClick={() => step(-1)}
            >
              <ChevronUpIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-label="Next match" onClick={() => step(1)}>
              <ChevronDownIcon />
            </Button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <StateChips />
          <LevelChips />
          <NoiseMenu />
        </span>
      </div>
      {queryError && (
        <p role="alert" className="text-destructive">
          {queryError.message}
          {queryError.hint && <span className="text-muted-foreground"> · {queryError.hint}</span>}
        </p>
      )}
    </div>
  );
}
