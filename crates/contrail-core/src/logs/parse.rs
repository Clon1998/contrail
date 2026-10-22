//! Turning one raw CloudWatch log line into a [`ParsedLine`].

use std::sync::LazyLock;

use regex::Regex;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::json::parse_json;
use super::spring::parse_spring;
use super::{Level, LogKind, ParsedLine};
use crate::timestamp::Timestamp;

/// Parses a raw log line: ECS/other JSON, the Spring Boot console pattern, or plain text.
pub fn parse_line(raw: &str) -> ParsedLine {
    let line = raw.trim_end_matches(['\n', '\r']);
    if line.trim_start().starts_with('{')
        && let Some(parsed) = parse_json(line.trim_start())
    {
        return parsed;
    }
    if let Some(parsed) = parse_spring(line) {
        return parsed;
    }
    parse_plain(line)
}

/// `ERROR`, `WARN`, … as whole upper-case words (lower-case "error" is usually prose).
static LEVEL_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL)\b").expect("valid level pattern")
});

fn parse_plain(line: &str) -> ParsedLine {
    let text = strip_ansi(line);
    let level = LEVEL_WORD
        .find(&text)
        .and_then(|m| Level::parse(m.as_str()));
    ParsedLine {
        kind: LogKind::Plain,
        timestamp: None,
        level,
        message: line.to_owned(),
        fields: Vec::new(),
        error: None,
        json_span: find_json_span(line),
    }
}

/// ANSI escape sequences (colours, cursor movement): `ESC [ … letter`.
static ANSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[A-Za-z]").expect("valid ANSI pattern"));

/// The text without ANSI escape sequences. Returns a `Cow`: borrowed (no copy) when there is
/// nothing to strip, owned when something was removed.
pub(super) fn strip_ansi(text: &str) -> std::borrow::Cow<'_, str> {
    ANSI.replace_all(text, "")
}

/// An offset without a colon (`+0100`), which Java may write but RFC 3339 doesn't allow.
static COMPACT_OFFSET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([+-]\d{2})(\d{2})$").expect("valid offset pattern"));

/// Parses an RFC 3339 timestamp, also with a space instead of `T` or a `+0100` offset. Times
/// without a zone are ambiguous and return `None`, so the CloudWatch timestamp is used instead.
pub(super) fn parse_timestamp(text: &str) -> Option<Timestamp> {
    let normalized = COMPACT_OFFSET
        .replace(&text.trim().replacen(' ', "T", 1), "$1:$2")
        .into_owned();
    OffsetDateTime::parse(&normalized, &Rfc3339)
        .ok()
        .map(Timestamp)
}

/// Finds the first balanced `{…}` in `text` that is valid JSON (e.g. an HTTP error body in a
/// log message) and returns its byte range.
pub(super) fn find_json_span(text: &str) -> Option<(u32, u32)> {
    let bytes = text.as_bytes();
    let mut search_from = 0;
    while let Some(offset) = text[search_from..].find('{') {
        let start = search_from + offset;
        if let Some(end) = balanced_end(bytes, start)
            && serde_json::from_str::<serde_json::Value>(&text[start..end]).is_ok()
        {
            return Some((u32::try_from(start).ok()?, u32::try_from(end).ok()?));
        }
        search_from = start + 1;
    }
    None
}

/// The index after the `}` that closes the `{` at `start`, honouring strings and escapes.
fn balanced_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            match (escaped, b) {
                (true, _) => escaped = false,
                (false, b'\\') => escaped = true,
                (false, b'"') => in_string = false,
                _ => {}
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i + 1);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn levels_parse_case_insensitively_with_aliases() {
        assert_eq!(Level::parse("warning"), Some(Level::Warn));
        assert_eq!(Level::parse(" FATAL "), Some(Level::Error));
        assert_eq!(Level::parse("verbose"), None);
        assert!(Level::Error > Level::Warn && Level::Warn > Level::Info);
    }

    #[test]
    fn timestamps_keep_nanoseconds_and_need_a_zone() {
        assert_eq!(
            parse_timestamp("2026-01-15T09:12:01.768108328Z").map(|t| t.0),
            Some(datetime!(2026-01-15 09:12:01.768108328 UTC))
        );
        assert_eq!(
            parse_timestamp("2026-01-15 09:12:01.5+01:00").map(|t| t.0),
            Some(datetime!(2026-01-15 08:12:01.5 UTC))
        );
        assert_eq!(
            parse_timestamp("2026-01-15T09:12:01.000+0100").map(|t| t.0),
            Some(datetime!(2026-01-15 08:12:01 UTC))
        );
        assert_eq!(parse_timestamp("2026-01-15T09:12:01.768"), None);
    }

    #[test]
    fn finds_embedded_json_and_skips_braces_that_are_not_json() {
        let text =
            r#"set {a} then got 404: "{"title":"Not Found","detail":"a } in a string"}" done"#;
        let (start, end) = find_json_span(text).unwrap();
        assert_eq!(
            &text[start as usize..end as usize],
            r#"{"title":"Not Found","detail":"a } in a string"}"#
        );
        assert_eq!(find_json_span("no json { here"), None);
    }

    #[test]
    fn strips_ansi_colours() {
        assert_eq!(strip_ansi("\u{1b}[32m INFO\u{1b}[0;39m ok"), " INFO ok");
    }

    #[test]
    fn plain_lines_detect_upper_case_levels_only() {
        assert_eq!(
            parse_line("[entrypoint] WARNING: x").level,
            Some(Level::Warn)
        );
        assert_eq!(parse_line("no errors found").level, None);
        assert_eq!(parse_line("plain").kind, LogKind::Plain);
    }

    #[test]
    fn json_without_ecs_uses_common_keys() {
        let parsed = parse_line(
            r#"{"time":1768471921000,"level":"warn","msg":"disk 91% full","disk":"/data"}"#,
        );
        assert_eq!(parsed.kind, LogKind::Json);
        assert_eq!(parsed.level, Some(Level::Warn));
        assert_eq!(parsed.message, "disk 91% full");
        assert_eq!(
            parsed.timestamp.map(|t| t.0),
            Some(datetime!(2026-01-15 10:12:01 UTC))
        );
        assert_eq!(parsed.field("disk"), Some(&serde_json::json!("/data")));
    }

    #[test]
    fn json_arrays_and_non_objects() {
        assert_eq!(parse_line("[1,2,3]").kind, LogKind::Plain);
        assert_eq!(parse_line("{ not json").kind, LogKind::Plain);
        let parsed = parse_line(r#"{"message":"m","tags":["a","b"]}"#);
        assert_eq!(parsed.field("tags"), Some(&serde_json::json!(["a", "b"])));
    }
}
