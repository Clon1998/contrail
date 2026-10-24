# Search syntax

The search box above a log view filters (or highlights) the events loaded in that view — nothing is sent
to CloudWatch. All terms must match.

| Example | Matches |
|---|---|
| `timeout` | the message contains "timeout" (any case) |
| `"read timed out"` | the message contains the phrase |
| `/time(out\|d out)/` | the message matches the regular expression (any case, [Rust syntax](https://docs.rs/regex/latest/regex/#syntax)) |
| `level:ERROR` | the level is ERROR |
| `level>=WARN` | WARN or ERROR (also `>`, `<`, `<=`; order: TRACE < DEBUG < INFO < WARN < ERROR) |
| `trace.id:abc123` | the field equals the value (any case) |
| `log.logger:*Camel*` | the field matches the pattern (`*` any text, `?` one character) |
| `http.response.status_code>=500` | a numeric field compared |
| `task:5f2a` | the task ID starts with "5f2a" |
| `message:x` | the message contains "x" (same as plain `x`) |
| `stream:*orders*` | the log stream matches |
| `-healthcheck` | excludes: any term can be negated |

Field names are the dotted names shown when a line is expanded (`log.logger`, `process.thread.name`,
`service.version`, your own objects like `order.id`). Values with spaces go in quotes:
`log.logger:"com.example.Some Thing"`. Clicking a field value in an expanded line adds it to the search.

**Options**

- **Filter / Highlight:** filter lists only matching lines; highlight keeps all lines and marks matches.
- **`.*` (regex mode):** the whole search is one regular expression (any case): no query syntax, so spaces,
  quotes and slashes need no escaping, e.g. `order \d+ (failed|timed out)`.
- **whole line:** text and regular expressions search the whole raw line (all JSON fields, the full stack
  trace) instead of just the message.
- **Level chips:** click a level to hide or show it (combined with the search); middle click shows only that
  level (again: all levels); right click offers "only", "and above" and "show all".
- **Fields (F):** the panel beside the list shows every field of the events that match the search: in how many
  of them it occurs and its most common values with their counts. Click a value to add `field:value` to the
  search (click again to remove it), Alt+click to exclude it (`-field:value`). The counts follow the search, so
  you can narrow down step by step. Fields whose values are all different (IDs, timestamps) just say so.
- **Noise:** "Hide lines like this" in an expanded line hides every line of that service whose message
  contains the same text; the Noise menu lists and removes them (saved per service).

**Keys:** Enter / F3 next match, Shift+Enter / Shift+F3 previous, Esc clears, ⌘F / Ctrl+F focuses the search,
F shows or hides the Fields panel.

Invalid queries are explained under the search box (e.g. `unknown level "LOUD"`), and the previous search
stays in effect until the query is fixed.
