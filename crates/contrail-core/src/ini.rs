//! A small, lenient parser for the INI dialect of `~/.aws/config` and `~/.aws/credentials`.
//!
//! Only what Contrail needs: section headers, `key = value` pairs and comments. Lines it doesn't
//! understand are skipped rather than failing the whole file, like the AWS CLI does for most
//! oddities. Indented lines (sub-properties such as `s3 =\n  max_concurrent_requests = 10`)
//! belong to the previous key and are ignored.

use std::collections::BTreeMap;

/// One `[header]` with its properties, in file order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Section {
    /// The header text between the brackets, trimmed (e.g. `profile dev`, `default`).
    pub header: String,
    /// Keys are lower-cased (the AWS tools treat them case-insensitively).
    pub properties: BTreeMap<String, String>,
}

/// Parses the text of an AWS config or credentials file into its sections.
///
/// The returned sections *borrow nothing* from `text`: every `String` is a fresh copy, so the
/// caller may drop the file contents right after parsing.
pub(crate) fn parse(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();

    for raw_line in text.lines() {
        // Sub-properties and continuation lines start with whitespace: skip them.
        if raw_line.starts_with([' ', '\t']) {
            continue;
        }
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with(['#', ';']) {
            continue;
        }

        if let Some(rest) = line.strip_prefix('[') {
            // `[profile dev] # comment` → `profile dev`
            if let Some(end) = rest.find(']') {
                sections.push(Section {
                    header: rest[..end].trim().to_owned(),
                    properties: BTreeMap::new(),
                });
            }
            continue;
        }

        // Properties before the first header have no section and are ignored.
        let (Some(section), Some((key, value))) = (sections.last_mut(), line.split_once('='))
        else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        if !key.is_empty() {
            section.properties.insert(key, value.trim().to_owned());
        }
    }

    sections
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_sections_and_properties() {
        let sections = parse(
            "[default]\nregion = eu-central-1\n\n[profile dev]\nsso_session=corp\nOutput = json\n",
        );
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[0].header, "default");
        assert_eq!(sections[0].properties["region"], "eu-central-1");
        assert_eq!(sections[1].header, "profile dev");
        assert_eq!(sections[1].properties["sso_session"], "corp");
        assert_eq!(
            sections[1].properties["output"], "json",
            "keys are lower-cased"
        );
    }

    #[test]
    fn skips_comments_blank_lines_and_junk() {
        let sections = parse(
            "# leading comment\nregion = ignored-before-header\n[ profile a ] ; trailing\n; comment\nnot a property\n  indented = ignored\nregion=us-east-1\n",
        );
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].header, "profile a");
        assert_eq!(sections[0].properties.len(), 1);
        assert_eq!(sections[0].properties["region"], "us-east-1");
    }

    #[test]
    fn ignores_nested_sub_properties() {
        let sections =
            parse("[profile a]\ns3 =\n  max_concurrent_requests = 20\nregion = eu-west-1\n");
        let props = &sections[0].properties;
        assert_eq!(props["s3"], "");
        assert_eq!(props["region"], "eu-west-1");
        assert!(!props.contains_key("max_concurrent_requests"));
    }

    #[test]
    fn keeps_equals_signs_inside_values() {
        let sections = parse("[profile a]\ncredential_process = tool --arg=1\n");
        assert_eq!(sections[0].properties["credential_process"], "tool --arg=1");
    }

    #[test]
    fn handles_windows_line_endings() {
        let sections = parse("[default]\r\nregion = eu-central-1\r\n");
        assert_eq!(sections[0].properties["region"], "eu-central-1");
    }
}
