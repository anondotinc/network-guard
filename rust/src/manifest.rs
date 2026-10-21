use crate::build_info;
use crate::error::{HelperError, Result};
use serde_json::{json, Value};

/// An absolute executable path in this platform's form: `/…` on Linux and
/// macOS, a drive path such as `C:\Users\…` on Windows. Relative, drive-relative
/// (`C:foo`), UNC and device (`\\?\…`) paths are refused.
fn is_absolute(executable: &str) -> bool {
    if cfg!(windows) {
        let bytes = executable.as_bytes();
        bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
    } else {
        executable.starts_with('/')
    }
}

/// The native-messaging host manifest for this build. Chrome requires an
/// absolute executable path on Linux and macOS; Windows uses one too.
pub fn host(executable: &str) -> Result<Value> {
    if !is_absolute(executable) || executable.contains('\0') || executable.contains('\n') {
        return Err(HelperError::InvalidRequest);
    }
    Ok(json!({
        "name": build_info::HOST_NAME,
        "description": "Anon Network Guard",
        "path": executable,
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{}/", build_info::EXTENSION_ID)],
    }))
}

/// Whether a registered manifest is this build's, pointing at `executable`.
/// The description is display copy, not identity.
pub fn matches(value: &Value, executable: &str) -> bool {
    let Some(object) = value.as_object() else { return false };
    let keys = ["name", "description", "path", "type", "allowed_origins"];
    object.len() == keys.len()
        && keys.iter().all(|key| object.contains_key(*key))
        && host(executable)
            .is_ok_and(|expected| ["name", "path", "type", "allowed_origins"].iter().all(|key| object.get(*key) == expected.get(*key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_paths_are_drive_absolute() {
        let path = r"C:\Users\someone\AppData\Local\Anon\NetworkGuard\production\versions\0.1.4-x\anon-network-helper.exe";
        assert_eq!(host(path).unwrap()["path"], json!(path));
        assert!(matches(&host(path).unwrap(), path));
        for refused in [r"relative\helper.exe", r"C:helper.exe", r"\\server\share\helper.exe", r"\\?\C:\helper.exe", "/usr/bin/helper"] {
            assert_eq!(host(refused), Err(HelperError::InvalidRequest), "{refused}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn unix_paths_are_absolute() {
        assert!(host("/opt/anon/network-guard/versions/x/anon-network-helper").is_ok());
        for refused in ["relative/helper", r"C:\helper.exe", "/bin/helper\nx", "/bin/helper\0"] {
            assert_eq!(host(refused), Err(HelperError::InvalidRequest), "{refused:?}");
        }
    }
}
