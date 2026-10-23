//! A point in time that crosses the IPC boundary as an RFC 3339 string.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use specta::Type;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// An `OffsetDateTime` that serializes as an RFC 3339 string (`2026-10-22T12:00:00Z`).
///
/// A *newtype* (a tuple struct with one field) wraps an existing type to give it its own
/// behaviour, here the serialization format and its TypeScript type, at zero runtime cost.
/// `#[specta(transparent)]` + `type = String` tell the bindings generator it is a plain string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Type)]
#[specta(transparent)]
pub struct Timestamp(#[specta(type = String)] pub OffsetDateTime);

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let text = self.0.format(&Rfc3339).map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(&text)
    }
}

/// Parses the same format back (the UI sends times, e.g. a custom time window).
///
/// `'de` is the lifetime of the input being deserialized; `Deserialize<'de>` could borrow from
/// it. Here the text is parsed into an owned value, so the lifetime is just passed along.
impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        OffsetDateTime::parse(&text, &Rfc3339)
            .map(Timestamp)
            .map_err(serde::de::Error::custom)
    }
}

impl From<OffsetDateTime> for Timestamp {
    fn from(value: OffsetDateTime) -> Self {
        Self(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn serializes_as_rfc3339_keeping_sub_second_precision() {
        let ts = Timestamp(datetime!(2026-10-22 12:00:00.123456789 UTC));
        assert_eq!(
            serde_json::to_string(&ts).unwrap(),
            r#""2026-10-22T12:00:00.123456789Z""#
        );
    }

    #[test]
    fn parses_rfc3339_with_an_offset() {
        let ts: Timestamp = serde_json::from_str(r#""2026-10-22T14:00:00+02:00""#).unwrap();
        assert_eq!(ts, Timestamp(datetime!(2026-10-22 12:00:00 UTC)));
        assert!(serde_json::from_str::<Timestamp>(r#""yesterday""#).is_err());
    }
}
