//! Property tests for the search query language: random inputs instead of hand-picked examples.
//!
//! `proptest!` generates many inputs from the given strategies (regex-like patterns describe
//! strings) and shrinks a failure to a minimal example, like QuickCheck / jqwik in Java.

use contrail_core::logs::{LogEvent, RawEvent};
use contrail_core::query::{MatchOptions, parse_query};
use contrail_core::timestamp::Timestamp;
use proptest::prelude::*;
use time::OffsetDateTime;

fn event(message: &str) -> LogEvent {
    LogEvent::from_raw(RawEvent {
        stream: "ecs/app/task1".into(),
        timestamp: Timestamp(OffsetDateTime::UNIX_EPOCH),
        message: message.into(),
    })
}

proptest! {
    /// Whatever is typed into the search box, parsing returns a query or an error, never panics,
    /// and errors point inside the input.
    #[test]
    fn parsing_never_panics_and_errors_point_into_the_input(input in "\\PC{0,40}") {
        if let Err(err) = parse_query(&input) {
            prop_assert!(err.start <= err.end);
            prop_assert!(err.end as usize <= input.len());
        }
    }

    /// Typical query characters, more likely to hit the interesting paths.
    #[test]
    fn query_like_inputs_never_panic(input in r#"[a-z.:<>=*?"/\\ -]{0,30}"#) {
        let _ = parse_query(&input);
    }

    /// `-term` matches exactly the events `term` doesn't.
    #[test]
    fn negation_is_the_complement(word in "[a-z]{1,6}", message in "[a-z ]{0,30}") {
        let e = event(&message);
        let positive = parse_query(&word).unwrap().matches(&e, MatchOptions::default());
        let negative = parse_query(&format!("-{word}")).unwrap().matches(&e, MatchOptions::default());
        prop_assert_ne!(positive, negative);
    }

    /// Free text matches exactly when the message contains it, ignoring case.
    #[test]
    fn text_terms_are_case_insensitive_substrings(word in "[a-zA-Z]{1,6}", message in "[a-zA-Z ]{0,30}") {
        let e = event(&message);
        let expected = message.to_lowercase().contains(&word.to_lowercase());
        prop_assert_eq!(parse_query(&word).unwrap().matches(&e, MatchOptions::default()), expected);
    }

    /// Adding a term can only narrow the result (AND).
    #[test]
    fn more_terms_never_match_more(a in "[a-z]{1,4}", b in "[a-z]{1,4}", message in "[a-z ]{0,30}") {
        let e = event(&message);
        let one = parse_query(&a).unwrap().matches(&e, MatchOptions::default());
        let both = parse_query(&format!("{a} {b}")).unwrap().matches(&e, MatchOptions::default());
        prop_assert!(!both || one);
    }
}
