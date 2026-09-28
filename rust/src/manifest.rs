use crate::build_info;
use crate::error::{HelperError, Result};
use serde_json::{json, Value};

/// The native-messaging host manifest for this build. Linux requires an
/// absolute executable path.
pub fn host(executable: &str) -> Result<Value> {
    if !executable.starts_with('/') || executable.contains('\0') || executable.contains('\n') {
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
