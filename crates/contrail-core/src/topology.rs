//! What a service reads and writes, from the lines the pipeline framework logs at startup.
//!
//! Route services describe their routes in env vars (see [`crate::routes`]). Transformers have
//! theirs in code, but the framework logs each Kafka consumer and producer it creates when the
//! app starts, so the start of a task's log stream tells which topics it reads and writes.

use serde::Serialize;
use specta::Type;

/// A topic a service consumes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ConsumedTopic {
    pub topic: String,
    /// The consumer group, from the line about its listener container (if there was one).
    pub group: Option<String>,
    /// How many consumers the container runs in parallel.
    pub concurrency: Option<u32>,
}

/// The topics found in a service's startup lines, each once, sorted by name.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StartupTopology {
    pub reads: Vec<ConsumedTopic>,
    pub writes: Vec<String>,
}

impl StartupTopology {
    pub fn is_empty(&self) -> bool {
        self.reads.is_empty() && self.writes.is_empty()
    }
}

/// A phrase every startup line contains: the log source filters on it, so only these lines
/// (and a few others) are read.
pub const STARTUP_PHRASE: &str = "Creating";

/// What one startup line says.
#[derive(Debug, Clone, PartialEq, Eq)]
enum StartupLine {
    /// A consumer of a topic (raw or integration topic, the framework logs them differently).
    Consumer {
        topic: String,
    },
    /// The listener container of a consumer: its topic, concurrency and consumer group.
    Container {
        topic: String,
        concurrency: Option<u32>,
        group: Option<String>,
    },
    Producer {
        topic: String,
    },
}

/// The text between the first pair of single quotes after `marker` in `message`.
fn quoted_after<'a>(message: &'a str, marker: &str) -> Option<&'a str> {
    let rest = &message[message.find(marker)? + marker.len()..];
    let start = rest.find('\'')? + 1;
    let len = rest[start..].find('\'')?;
    Some(&rest[start..start + len])
}

/// Reads one log message; `None` for anything that isn't a startup line.
fn parse_line(message: &str) -> Option<StartupLine> {
    const RAW_CONSUMER: &str = "Creating a raw Kafka consumer for topic ";
    const INTEGRATION_CONSUMER: &str = "Creating an integration consumer for topic ";
    const CONTAINER: &str = "Creating a Kafka container for topic: ";
    const PRODUCER: &str = "Creating producer for topic: ";

    let topic = |marker| quoted_after(message, marker).map(str::to_owned);
    if message.contains(RAW_CONSUMER) {
        return topic(RAW_CONSUMER).map(|topic| StartupLine::Consumer { topic });
    }
    if message.contains(INTEGRATION_CONSUMER) {
        return topic(INTEGRATION_CONSUMER).map(|topic| StartupLine::Consumer { topic });
    }
    if message.contains(CONTAINER) {
        return topic(CONTAINER).map(|topic| StartupLine::Container {
            topic,
            concurrency: quoted_after(message, "concurrency=").and_then(|n| n.parse().ok()),
            group: quoted_after(message, "consumerGroup=").map(str::to_owned),
        });
    }
    // The producer's topic isn't quoted: it's the rest of the line.
    let (_, rest) = message.split_once(PRODUCER)?;
    let topic = rest.trim().trim_matches('\'');
    (!topic.is_empty()).then(|| StartupLine::Producer {
        topic: topic.to_owned(),
    })
}

/// The topics the startup lines among `messages` name. Several lines about the same topic (its
/// consumer and its container, or several tasks) become one entry.
///
/// `impl IntoIterator<Item = &'a str>` accepts an array, a `Vec` or a lazy iterator of borrowed
/// strings alike (like taking an `Iterable<String>` in Java). `'a` says the strings live somewhere
/// else for as long as the call needs them; nothing is copied until a topic is kept.
pub fn startup_topology<'a>(messages: impl IntoIterator<Item = &'a str>) -> StartupTopology {
    // `BTreeMap`/`BTreeSet` keep their keys sorted (like Java's `TreeMap`), so the result is too.
    let mut reads = std::collections::BTreeMap::<String, ConsumedTopic>::new();
    let mut writes = std::collections::BTreeSet::new();
    for line in messages.into_iter().filter_map(parse_line) {
        match line {
            StartupLine::Consumer { topic } => {
                reads.entry(topic.clone()).or_insert(ConsumedTopic {
                    topic,
                    group: None,
                    concurrency: None,
                });
            }
            StartupLine::Container {
                topic,
                concurrency,
                group,
            } => {
                let read = reads.entry(topic.clone()).or_insert(ConsumedTopic {
                    topic,
                    group: None,
                    concurrency: None,
                });
                read.group = group.or(read.group.take());
                read.concurrency = concurrency.or(read.concurrency);
            }
            StartupLine::Producer { topic } => {
                writes.insert(topic);
            }
        }
    }
    StartupTopology {
        reads: reads.into_values().collect(),
        writes: writes.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(topic: &str, group: Option<&str>, concurrency: Option<u32>) -> ConsumedTopic {
        ConsumedTopic {
            topic: topic.to_owned(),
            group: group.map(str::to_owned),
            concurrency,
        }
    }

    #[test]
    fn raw_and_integration_consumers_with_their_containers() {
        let topology = startup_topology([
            "Creating a raw Kafka consumer for topic 'demo.events'",
            "Creating a Kafka container for topic: 'demo.events' with concurrency='3' and consumerGroup='event-enricher'",
            "Creating an integration consumer for topic 'integration.demo.orders'",
            "Creating a Kafka container for topic: 'integration.demo.orders' with concurrency='1' and consumerGroup='enricher-orders'",
            "Started EventEnricherApplication in 12.3 seconds",
        ]);
        assert_eq!(
            topology.reads,
            [
                read("demo.events", Some("event-enricher"), Some(3)),
                read("integration.demo.orders", Some("enricher-orders"), Some(1)),
            ]
        );
        assert!(topology.writes.is_empty());
    }

    #[test]
    fn producers_with_or_without_quotes() {
        let topology = startup_topology([
            "Creating producer for topic: demo.events.enriched",
            "Creating producer for topic: 'demo.events.audit' ",
            // Logged again by a second task: listed once.
            "Creating producer for topic: demo.events.enriched",
        ]);
        assert_eq!(
            topology.writes,
            ["demo.events.audit", "demo.events.enriched"]
        );
        assert!(topology.reads.is_empty());
    }

    #[test]
    fn a_consumer_without_its_container_line_has_no_group() {
        let topology = startup_topology(["Creating a raw Kafka consumer for topic 'demo.events'"]);
        assert_eq!(topology.reads, [read("demo.events", None, None)]);
    }

    #[test]
    fn the_container_line_alone_is_enough() {
        let topology = startup_topology([
            "Creating a Kafka container for topic: 'demo.events' with concurrency='x' and consumerGroup='g1'",
        ]);
        // A concurrency that isn't a number is left out, the rest is kept.
        assert_eq!(topology.reads, [read("demo.events", Some("g1"), None)]);
    }

    #[test]
    fn other_lines_and_broken_ones_are_ignored() {
        let topology = startup_topology([
            "Creating bean 'kafkaTemplate'",
            "Creating a raw Kafka consumer for topic ",
            "Creating producer for topic:   ",
            "",
        ]);
        assert!(topology.is_empty());
    }

    #[test]
    fn lines_with_a_prefix_still_count() {
        // Some apps put MDC values in front of the message.
        let topology = startup_topology([
            "[main] Creating producer for topic: demo.out",
            "[main] Creating a raw Kafka consumer for topic 'demo.in'",
        ]);
        assert_eq!(topology.writes, ["demo.out"]);
        assert_eq!(topology.reads, [read("demo.in", None, None)]);
    }
}
