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

#[test]
fn transformer_startup() {
    insta::assert_json_snapshot!(parse_fixture("transformer-startup.log"));
}

/// The startup scan on a transformer's start: like the app, only the events with one of the
/// startup phrases (CloudWatch's filter), parsed, then read for topics.
#[test]
fn a_transformers_start_names_the_topics_it_reads() {
    use contrail_core::topology::{ConsumedTopic, STARTUP_PHRASES, startup_topology};

    let path = format!(
        "{}/tests/fixtures/transformer-startup.log",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap();
    let parsed: Vec<_> = text
        .lines()
        .filter(|line| STARTUP_PHRASES.iter().any(|phrase| line.contains(phrase)))
        .map(parse_line)
        .collect();
    let topology = startup_topology(parsed.iter().map(|line| line.message.as_str()));

    // The configured name of the consumer line and the Kafka name of the container line are one
    // integration topic; the Kafka client's own lines and the status lines don't count.
    assert_eq!(
        topology.reads,
        [ConsumedTopic {
            topic: "integration.orders.order-events".into(),
            group: Some("orders-transformer".into()),
            concurrency: Some(2),
        }]
    );
    assert!(topology.writes.is_empty(), "{:?}", topology.writes);
}
