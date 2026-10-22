//! The error type shared by the AWS-backed sources (ECS, CloudWatch Logs).

/// What can go wrong when reading from AWS (or the demo fake).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SourceError {
    /// The profile's credentials are missing, expired or rejected: a login usually fixes it.
    #[error("no valid credentials for profile \"{profile}\": {message}")]
    Credentials { profile: String, message: String },
    /// Something AWS (or the connection to it) reported.
    #[error("AWS error: {0}")]
    Aws(String),
    /// A cluster, service or task that doesn't (or no longer) exist.
    #[error("{0} not found")]
    NotFound(String),
    #[error("can't read the AWS configuration: {0}")]
    Config(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages() {
        assert_eq!(
            SourceError::NotFound("service orders-api".into()).to_string(),
            "service orders-api not found"
        );
        assert_eq!(
            SourceError::Credentials {
                profile: "dev".into(),
                message: "ExpiredToken".into()
            }
            .to_string(),
            "no valid credentials for profile \"dev\": ExpiredToken"
        );
    }
}
