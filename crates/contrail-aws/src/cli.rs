//! Running `aws sso login` (the AWS CLI does the browser-based login; Contrail only starts it).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use contrail_core::auth::{AuthError, LoginProgress};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command;

#[cfg(windows)]
const AWS_EXE: &str = "aws.exe";
#[cfg(not(windows))]
const AWS_EXE: &str = "aws";

/// Finds the `aws` executable.
///
/// Looks in `PATH` first, then in the usual install locations: an app started from the macOS
/// Finder/Dock gets a minimal `PATH` without Homebrew's directories, even though `aws` works in
/// the terminal.
pub fn find_aws_cli() -> Option<PathBuf> {
    let home = std::env::home_dir();
    let mut fallbacks: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        fallbacks.push(PathBuf::from(r"C:\Program Files\Amazon\AWSCLIV2"));
    } else {
        fallbacks.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
        if let Some(home) = home {
            fallbacks.push(home.join(".local/bin"));
        }
    }
    find_executable(std::env::var_os("PATH"), &fallbacks, AWS_EXE)
}

/// Searches `name` in the directories of a `PATH`-style value, then in `fallbacks`.
fn find_executable(
    path_var: Option<OsString>,
    fallbacks: &[PathBuf],
    name: &str,
) -> Option<PathBuf> {
    let from_path = path_var
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    // `chain` + `find` iterate lazily: the search stops at the first hit, like a Java Stream.
    from_path
        .iter()
        .chain(fallbacks)
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Runs `<aws> sso login --profile <profile>` and streams its output lines to `progress`.
///
/// The CLI opens the browser and waits until the user has approved the login (or gives up
/// after its own timeout). If the returned future is dropped, the process is killed.
pub async fn sso_login(
    aws: &Path,
    profile: &str,
    progress: &(dyn Fn(LoginProgress) + Send + Sync),
) -> Result<(), AuthError> {
    let mut child = Command::new(aws)
        .args(["sso", "login", "--profile", profile])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => AuthError::CliMissing,
            _ => AuthError::Config(format!("can't start {}: {err}", aws.display())),
        })?;

    // `take()` moves the pipes out of `child`, so they can be read while we wait on `child`.
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");
    // Read both pipes at the same time: the CLI prints the URL/code on one and errors on the
    // other, and a full, unread pipe would block it.
    let (status, (), ()) = tokio::join!(
        child.wait(),
        forward_lines(stdout, progress),
        forward_lines(stderr, progress),
    );

    let status = status.map_err(|err| AuthError::Config(format!("aws sso login: {err}")))?;
    if status.success() {
        Ok(())
    } else {
        Err(AuthError::LoginFailed {
            exit_code: status.code(),
        })
    }
}

/// Sends every non-empty line read from `pipe` to `progress`.
///
/// `impl AsyncRead + Unpin` accepts any readable stream type (stdout and stderr are different
/// types); the compiler generates a version per type, like Java generics but without erasure.
async fn forward_lines(
    pipe: impl AsyncRead + Unpin,
    progress: &(dyn Fn(LoginProgress) + Send + Sync),
) {
    let mut lines = BufReader::new(pipe).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim_end();
        if !line.is_empty() {
            progress(LoginProgress::Output {
                line: line.to_owned(),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[cfg(unix)]
    fn write_script(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// Collects the progress lines a login reports.
    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);

    impl Recorder {
        fn push(&self, progress: LoginProgress) {
            let LoginProgress::Output { line } = progress;
            self.0.lock().unwrap().push(line);
        }

        fn lines(self) -> Vec<String> {
            self.0.into_inner().unwrap()
        }
    }

    #[cfg(unix)]
    #[test]
    fn finds_executable_on_path_before_fallbacks() {
        let path_dir = tempfile::tempdir().unwrap();
        let fallback_dir = tempfile::tempdir().unwrap();
        let on_path = write_script(path_dir.path(), "aws", "true");
        write_script(fallback_dir.path(), "aws", "true");

        let path_var = std::env::join_paths([path_dir.path()]).unwrap();
        let found = find_executable(Some(path_var), &[fallback_dir.path().to_owned()], "aws");
        assert_eq!(found, Some(on_path));
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_to_known_locations_and_skips_non_executables() {
        let path_dir = tempfile::tempdir().unwrap();
        let fallback_dir = tempfile::tempdir().unwrap();
        // A non-executable file on PATH must be ignored.
        std::fs::write(path_dir.path().join("aws"), "not executable").unwrap();
        let in_fallback = write_script(fallback_dir.path(), "aws", "true");

        let path_var = std::env::join_paths([path_dir.path()]).unwrap();
        let found = find_executable(Some(path_var), &[fallback_dir.path().to_owned()], "aws");
        assert_eq!(found, Some(in_fallback));
    }

    #[test]
    fn missing_executable_is_none() {
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            find_executable(None, &[empty.path().to_owned()], "aws"),
            None
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn streams_output_and_succeeds() {
        let dir = tempfile::tempdir().unwrap();
        let aws = write_script(
            dir.path(),
            "aws",
            r#"echo "args: $*"
echo "https://device.sso.eu-central-1.amazonaws.com/"
echo "a warning" >&2
exit 0"#,
        );
        let recorder = Recorder::default();

        sso_login(&aws, "dev", &|p| recorder.push(p)).await.unwrap();

        let mut lines = recorder.lines();
        lines.sort(); // stdout and stderr interleave nondeterministically
        assert_eq!(
            lines,
            [
                "a warning",
                "args: sso login --profile dev",
                "https://device.sso.eu-central-1.amazonaws.com/",
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn non_zero_exit_is_login_failed() {
        let dir = tempfile::tempdir().unwrap();
        let aws = write_script(
            dir.path(),
            "aws",
            "echo 'Error when retrieving token' >&2\nexit 255",
        );
        let recorder = Recorder::default();

        let result = sso_login(&aws, "dev", &|p| recorder.push(p)).await;

        assert_eq!(
            result,
            Err(AuthError::LoginFailed {
                exit_code: Some(255)
            })
        );
        assert_eq!(recorder.lines(), ["Error when retrieving token"]);
    }

    #[tokio::test]
    async fn missing_cli_is_cli_missing() {
        let result = sso_login(Path::new("/definitely/not/here/aws"), "dev", &|_| {}).await;
        assert_eq!(result, Err(AuthError::CliMissing));
    }
}
