//! Per-user installation. Shared rules mirror `UserInstaller` in
//! `Sources/NetworkHelperSetupCore/Installer.swift`: no admin rights, no
//! service, no network, no VPN access. Callers cannot choose a host name,
//! origin or path. Each OS module owns its paths and registration mechanism.
use crate::build_info;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupError {
    InvalidPayload,
    WrongChannel,
    UnsafePath,
    RegistrationConflict,
    OwnershipConflict,
    InstallBusy,
    NoBrowser,
    IoFailure,
}

impl SetupError {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidPayload => "The bundled Network Guard could not be verified. Download the release again.",
            Self::WrongChannel => "This setup program and Network Guard target different extension channels.",
            Self::UnsafePath => "An installation path is a symlink, not owned by you, or writable by others. No change was made.",
            Self::RegistrationConflict => {
                "A browser already has a different Network Guard registration for this channel. It was not replaced."
            }
            Self::OwnershipConflict => "Existing files are not recognized as this installer's files. They were not removed.",
            Self::InstallBusy => "Another setup operation is running. Try again when it finishes.",
            Self::NoBrowser => "No Chrome, Chromium, Brave or Edge profile was found. Open the browser once, then run install again.",
            Self::IoFailure => "Setup could not finish. Check your home folder permissions, then retry.",
        }
    }
}

pub type Result<T> = std::result::Result<T, SetupError>;

pub(super) fn io<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| SetupError::IoFailure)
}

/// A browser that can hold a host registration. `profile` is relative to the
/// OS's per-user browser data root; `registry` is the Windows key under HKCU.
pub struct Browser {
    pub id: &'static str,
    pub name: &'static str,
    pub profile: &'static str,
    pub registry: &'static str,
}

pub(super) fn browser(id: &str) -> Option<&'static Browser> {
    BROWSERS.iter().find(|browser| browser.id == id)
}

/// `payload.json` beside the bundled helper: what the release says it ships.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Payload {
    pub version: String,
    pub channel: String,
    pub sha256: String,
}

fn is_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    value.len() <= 32 && parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl Payload {
    pub fn from_json(value: &Value) -> Result<Self> {
        let object = value.as_object().ok_or(SetupError::InvalidPayload)?;
        let keys = ["schemaVersion", "version", "channel", "sha256"];
        if object.len() != keys.len() || !keys.iter().all(|key| object.contains_key(*key)) || object["schemaVersion"] != json!(1) {
            return Err(SetupError::InvalidPayload);
        }
        let text = |key: &str| object[key].as_str().map(str::to_string).ok_or(SetupError::InvalidPayload);
        let payload = Payload { version: text("version")?, channel: text("channel")?, sha256: text("sha256")? };
        payload.validate()?;
        Ok(payload)
    }

    pub fn load(directory: &Path) -> Result<Self> {
        let path = directory.join("payload.json");
        let bytes = read_regular(&path, 4096).map_err(|_| SetupError::InvalidPayload)?;
        Self::from_json(&serde_json::from_slice(&bytes).map_err(|_| SetupError::InvalidPayload)?)
    }

    pub(super) fn validate(&self) -> Result<()> {
        if !is_version(&self.version) || !is_digest(&self.sha256) {
            return Err(SetupError::InvalidPayload);
        }
        if self.channel != build_info::CHANNEL {
            return Err(SetupError::WrongChannel);
        }
        Ok(())
    }

    pub(super) fn to_json(&self) -> Value {
        json!({ "schemaVersion": 1, "version": self.version, "channel": self.channel, "sha256": self.sha256 })
    }

    pub(super) fn directory_name(&self) -> String {
        format!("{}-{}", self.version, self.sha256)
    }
}

#[cfg(target_os = "linux")]
const RECEIPT_OWNER: &str = "inc.anon.network-guard.setup.linux.v1";
#[cfg(windows)]
const RECEIPT_OWNER: &str = "inc.anon.network-guard.setup.windows.v1";
#[cfg(target_os = "linux")]
pub const HELPER: &str = "anon-network-helper";
#[cfg(windows)]
pub const HELPER: &str = "anon-network-helper.exe";
pub(super) const MAX_VERSIONS: usize = 128;

#[derive(Debug, Clone)]
pub(super) struct Receipt {
    pub(super) versions: Vec<Payload>,
    pub(super) browsers: Vec<&'static str>,
}

impl Receipt {
    pub(super) fn to_json(&self) -> Value {
        json!({
            "schemaVersion": 1,
            "owner": RECEIPT_OWNER,
            "channel": build_info::CHANNEL,
            "versions": self.versions.iter().map(Payload::to_json).collect::<Vec<_>>(),
            "browsers": self.browsers,
        })
    }

    pub(super) fn from_json(value: &Value) -> Result<Self> {
        let conflict = SetupError::OwnershipConflict;
        let object = value.as_object().ok_or(conflict)?;
        let keys = ["schemaVersion", "owner", "channel", "versions", "browsers"];
        if object.len() != keys.len()
            || !keys.iter().all(|key| object.contains_key(*key))
            || object["schemaVersion"] != json!(1)
            || object["owner"] != json!(RECEIPT_OWNER)
            || object["channel"] != json!(build_info::CHANNEL)
        {
            return Err(conflict);
        }
        let versions = object["versions"]
            .as_array()
            .ok_or(conflict)?
            .iter()
            .map(Payload::from_json)
            .collect::<Result<Vec<_>>>()
            .map_err(|_| conflict)?;
        let mut names: Vec<String> = versions.iter().map(Payload::directory_name).collect();
        names.sort();
        names.dedup();
        if versions.len() > MAX_VERSIONS || names.len() != versions.len() {
            return Err(conflict);
        }
        let mut browsers = Vec::new();
        for id in object["browsers"].as_array().ok_or(conflict)? {
            let found = id.as_str().and_then(browser).ok_or(conflict)?;
            if browsers.contains(&found.id) {
                return Err(conflict);
            }
            browsers.push(found.id);
        }
        Ok(Receipt { versions, browsers })
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum State {
    NotInstalled,
    Installed { version: String, browsers: Vec<&'static str> },
    NeedsRepair,
}

pub(super) fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// A regular file (not a symlink) of 1..=limit bytes.
pub(super) fn read_regular(path: &Path, limit: u64) -> std::io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    fs::read(path)
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::{Installer, BROWSERS};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{Installer, BROWSERS};
