//! Files the user saves from the UI that aren't log exports (an image of the route map).

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

use crate::error::{ApiError, ApiResult, ErrorCode};

/// The kinds of image the UI saves.
const IMAGE_EXTENSIONS: &[&str] = &["png", "svg"];

/// Writes an image to `path`, which the user chose in a save dialog. `base64` is the file's
/// content, base64-encoded (a PNG's bytes or an SVG's text). Only `.png` and `.svg` files are
/// written, so this can't be used to write anything else.
#[tauri::command]
#[specta::specta]
pub async fn save_image(path: String, base64: String) -> ApiResult<()> {
    let bytes = image_bytes(&path, &base64)?;
    tokio::fs::write(&path, bytes).await?;
    Ok(())
}

/// The decoded image, if `path` names an image file and `base64` is valid.
fn image_bytes(path: &str, base64: &str) -> ApiResult<Vec<u8>> {
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    if !extension.is_some_and(|e| IMAGE_EXTENSIONS.contains(&e.as_str())) {
        return Err(ApiError::new(
            ErrorCode::InvalidInput,
            "only .png and .svg files can be saved here",
        ));
    }
    STANDARD
        .decode(base64)
        .map_err(|err| ApiError::new(ErrorCode::InvalidInput, format!("not base64: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_images_are_written() {
        assert_eq!(image_bytes("/tmp/map.PNG", "aGk=").unwrap(), b"hi");
        assert_eq!(image_bytes("map.svg", "PHN2Zy8+").unwrap(), b"<svg/>");
        for path in ["/tmp/.bashrc", "/tmp/map.png.sh", "/tmp/map"] {
            let err = image_bytes(path, "aGk=").unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidInput, "{path}");
        }
        assert!(image_bytes("map.png", "not base64!").is_err());
    }

    #[tokio::test]
    async fn saves_the_decoded_image() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("map.svg");
        save_image(path.to_string_lossy().into_owned(), "PHN2Zy8+".into())
            .await
            .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"<svg/>");
    }
}
