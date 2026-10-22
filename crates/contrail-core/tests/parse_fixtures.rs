//! Snapshot tests: every event of every synthetic fixture through the parser.
//!
//! The snapshots (in `tests/snapshots/`) show exactly what Contrail extracts from each line;
//! review changes with `cargo insta review`.

use contrail_core::logs::parse_line;

fn parse_fixture(name: &str) -> Vec<contrail_core::logs::ParsedLine> {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("{path}: {err}"))
        .lines()
        .map(parse_line)
        .collect()
}

#[test]
fn ecs_nested() {
    insta::assert_json_snapshot!(parse_fixture("ecs-nested.jsonl"));
}

#[test]
fn ecs_dotted_errors() {
    insta::assert_json_snapshot!(parse_fixture("ecs-dotted-errors.jsonl"));
}

#[test]
fn plain_spring_default() {
    insta::assert_json_snapshot!(parse_fixture("plain-spring-default.log"));
}

#[test]
fn plain_stacktrace_split_lines() {
    insta::assert_json_snapshot!(parse_fixture("plain-stacktrace-split.log"));
}
