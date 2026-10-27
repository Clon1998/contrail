# Log parser fixtures (synthetic)

Invented log events with the same structure as the formats Contrail sees in production: field names,
nesting, padding, value types and edge cases match; the content (`com.example.*`, service names, IDs) is made
up. Real samples never go into the repository.

| File | Format |
|---|---|
| `ecs-nested.jsonl` | ECS structured logging, nested objects (newer Spring Boot), incl. a custom `pipeline.*` object with numeric fields, an empty `service.node` object, `trace.id`/`span.id` |
| `ecs-dotted-errors.jsonl` | ECS with dotted keys (older Spring Boot), `error.*` with long stack traces (`Caused by:`, `... N common frames omitted`), JSON-escaped `\/` |
| `plain-spring-default.log` | Spring Boot's default console pattern, incl. an embedded JSON body, a `+01:00` offset, the older format without `[app]`, ANSI colours, and non-Spring lines |
| `plain-stacktrace-split.log` | A plain-text Java stack trace that CloudWatch stored as one event per line (for the multi-line joiner) |
| `transformer-startup.log` | A transformer's start in Spring Boot's console pattern: the framework's consumer lines (the configured topic name, then the Kafka container line with the `integration.` name, concurrency and group), Kafka client config blocks with tab-indented continuation lines, Camel's route start, and status lines. Like the real one it reads one topic and writes none |
