//! Linux layout:
//!   ~/.local/share/anon/network-guard/<channel>/installation.json
//!   ~/.local/share/anon/network-guard/<channel>/versions/<version>-<sha256>/anon-network-helper
//!   <config>/<browser>/NativeMessagingHosts/<host>.json, for each browser that has a profile
use super::*;
use crate::manifest;
use crate::platform::linux::lock;
use std::ffi::CString;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::PathBuf;

/// Profiles relative to `$XDG_CONFIG_HOME` (default `~/.config`).
pub const BROWSERS: [Browser; 4] = [
    Browser { id: "chrome", name: "Google Chrome", profile: "google-chrome", registry: "" },
    Browser { id: "chromium", name: "Chromium", profile: "chromium", registry: "" },
    Browser { id: "brave", name: "Brave", profile: "BraveSoftware/Brave-Browser", registry: "" },
    Browser { id: "edge", name: "Microsoft Edge", profile: "microsoft-edge", registry: "" },
];

fn lstat(path: &Path) -> std::io::Result<libc::stat> {
    let path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid C string and stat buffer owned by this frame.
    if unsafe { libc::lstat(path.as_ptr(), &mut info) } == 0 {
        Ok(info)
    } else {
        Err(std::io::Error::last_os_error())
    }
}

pub struct Installer {
    home: PathBuf,
    config: PathBuf,
    lock_directory: String,
    pub root: PathBuf,
}

impl Installer {
    /// `$HOME`, `$XDG_CONFIG_HOME` (as Chrome reads it) and the runtime dir for the lock.
    pub fn for_current_user() -> Result<Self> {
        let home = std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute()).ok_or(SetupError::UnsafePath)?;
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        let lock_directory = lock::runtime_dir().map_err(|_| SetupError::InstallBusy)?;
        Ok(Self::new(home, config, lock_directory))
    }

    pub fn new(home: PathBuf, config: PathBuf, lock_directory: String) -> Self {
        let root = home.join(".local/share/anon/network-guard").join(build_info::CHANNEL);
        Installer { home, config, lock_directory, root }
    }

    fn receipt_path(&self) -> PathBuf {
        self.root.join("installation.json")
    }
    fn versions_path(&self) -> PathBuf {
        self.root.join("versions")
    }
    fn executable(&self, payload: &Payload) -> PathBuf {
        self.versions_path().join(payload.directory_name()).join(HELPER)
    }
    fn profile(&self, browser: &Browser) -> PathBuf {
        self.config.join(browser.profile)
    }
    pub fn registration(&self, browser: &Browser) -> PathBuf {
        self.profile(browser).join("NativeMessagingHosts").join(format!("{}.json", build_info::HOST_NAME))
    }

    /// Every component below `$HOME` is ours: not a symlink, owned by this
    /// user, not group- or world-writable. Missing components are fine.
    fn safe(&self, path: &Path) -> Result<()> {
        let relative = path.strip_prefix(&self.home).map_err(|_| SetupError::UnsafePath)?;
        if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(SetupError::UnsafePath);
        }
        // SAFETY: getuid has no failure mode.
        let uid = unsafe { libc::getuid() };
        let mut cursor = self.home.clone();
        for component in relative.components() {
            cursor.push(component);
            match lstat(&cursor) {
                Ok(info) => {
                    if info.st_uid != uid || info.st_mode & libc::S_IFMT == libc::S_IFLNK || info.st_mode & 0o022 != 0 {
                        return Err(SetupError::UnsafePath);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(SetupError::UnsafePath),
            }
        }
        Ok(())
    }

    fn make_directory(&self, path: &Path) -> Result<()> {
        self.safe(path)?;
        let relative = path.strip_prefix(&self.home).map_err(|_| SetupError::UnsafePath)?;
        let mut cursor = self.home.clone();
        for component in relative.components() {
            cursor.push(component);
            if fs::symlink_metadata(&cursor).is_err() {
                io(fs::DirBuilder::new().mode(0o700).create(&cursor))?;
            }
        }
        self.safe(path)
    }

    /// Writes beside the target, then renames over it.
    fn write_atomic(&self, path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
        self.safe(path)?;
        let name = path.file_name().ok_or(SetupError::UnsafePath)?.to_string_lossy();
        let temporary = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
        self.safe(&temporary)?;
        let _ = fs::remove_file(&temporary);
        let result = (|| {
            let mut file = OpenOptions::new().write(true).create_new(true).mode(mode).custom_flags(libc::O_NOFOLLOW).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
            fs::rename(&temporary, path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        io(result)
    }

    fn write_json(&self, path: &Path, value: &Value) -> Result<()> {
        let mut bytes = serde_json::to_vec_pretty(value).map_err(|_| SetupError::IoFailure)?;
        bytes.push(b'\n');
        self.write_atomic(path, &bytes, 0o600)
    }

    fn receipt(&self) -> Result<Option<Receipt>> {
        self.safe(&self.root)?;
        let path = self.receipt_path();
        self.safe(&path)?;
        if fs::symlink_metadata(&path).is_err() {
            if fs::read_dir(&self.root).is_ok_and(|mut entries| entries.next().is_some()) {
                return Err(SetupError::OwnershipConflict);
            }
            return Ok(None);
        }
        let bytes = read_regular(&path, 65536).map_err(|_| SetupError::OwnershipConflict)?;
        Receipt::from_json(&serde_json::from_slice(&bytes).map_err(|_| SetupError::OwnershipConflict)?).map(Some)
    }

    /// The version a browser's registration points at, or `None` when it has
    /// none. A registration this installer doesn't own is a conflict.
    fn registered(&self, browser: &Browser, receipt: Option<&Receipt>) -> Result<Option<Payload>> {
        let path = self.registration(browser);
        self.safe(&path)?;
        if fs::symlink_metadata(&path).is_err() {
            return Ok(None);
        }
        let bytes = read_regular(&path, 16384).map_err(|_| SetupError::RegistrationConflict)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| SetupError::RegistrationConflict)?;
        receipt
            .and_then(|receipt| {
                receipt.versions.iter().find(|payload| manifest::matches(&value, &self.executable(payload).to_string_lossy()))
            })
            .cloned()
            .map(Some)
            .ok_or(SetupError::RegistrationConflict)
    }

    /// Browsers with a profile directory. Setup never creates a profile.
    fn present(&self) -> Result<Vec<&'static Browser>> {
        let mut found = Vec::new();
        for browser in &BROWSERS {
            let profile = self.profile(browser);
            if fs::symlink_metadata(&profile).is_ok_and(|m| m.is_dir()) {
                self.safe(&profile)?;
                found.push(browser);
            }
        }
        Ok(found)
    }

    fn with_lock<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let name = format!("inc.anon.network-guard.setup.{}.lock", build_info::CHANNEL);
        let _lock = lock::exclusive(&self.lock_directory, &name, SetupError::InstallBusy, SetupError::InstallBusy)?;
        operation()
    }

    pub fn check(&self) -> Result<State> {
        let receipt = self.receipt()?;
        let mut active: Option<Payload> = None;
        let mut repair = false;
        for browser in &BROWSERS {
            match self.registered(browser, receipt.as_ref())? {
                Some(payload) => {
                    if active.as_ref().is_some_and(|current| *current != payload) {
                        repair = true;
                    }
                    active = Some(payload);
                }
                None if receipt.as_ref().is_some_and(|r| r.browsers.contains(&browser.id)) => repair = true,
                None => {}
            }
        }
        let Some(receipt) = receipt else { return Ok(State::NotInstalled) };
        let Some(active) = active else { return Ok(State::NeedsRepair) };
        let binary = self.executable(&active);
        self.safe(&binary)?;
        let intact = read_regular(&binary, 64 << 20).is_ok_and(|bytes| digest(&bytes) == active.sha256)
            && fs::symlink_metadata(&binary).is_ok_and(|m| m.permissions().mode() & 0o100 != 0);
        let present = self.present()?;
        if repair || !intact || present.iter().any(|browser| !receipt.browsers.contains(&browser.id)) {
            return Ok(State::NeedsRepair);
        }
        Ok(State::Installed { version: active.version, browsers: receipt.browsers })
    }

    /// Installs the bundled helper and registers it with every browser that has
    /// a profile. Returns the browsers now registered.
    pub fn install(&self, payload: &Payload, bundled: &Path) -> Result<Vec<&'static str>> {
        payload.validate()?;
        let bytes = read_regular(bundled, 64 << 20).map_err(|_| SetupError::InvalidPayload)?;
        if digest(&bytes) != payload.sha256 {
            return Err(SetupError::InvalidPayload);
        }
        // Conflict checks precede even directory creation.
        let initial = self.receipt()?;
        for browser in &BROWSERS {
            self.registered(browser, initial.as_ref())?;
        }
        if self.present()?.is_empty() {
            return Err(SetupError::NoBrowser);
        }
        self.with_lock(|| {
            let mut receipt = self.receipt()?.unwrap_or(Receipt { versions: Vec::new(), browsers: Vec::new() });
            for browser in &BROWSERS {
                self.registered(browser, Some(&receipt))?;
            }
            let binary = self.executable(payload);
            let directory = binary.parent().ok_or(SetupError::UnsafePath)?.to_path_buf();
            self.safe(&binary)?;
            if fs::symlink_metadata(&directory).is_ok() {
                let contents: Vec<String> =
                    io(fs::read_dir(&directory))?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
                if !receipt.versions.contains(payload) || contents.iter().any(|name| name != HELPER) {
                    return Err(SetupError::OwnershipConflict);
                }
            }
            self.make_directory(&self.root)?;
            if !receipt.versions.contains(payload) {
                if receipt.versions.len() >= MAX_VERSIONS {
                    return Err(SetupError::OwnershipConflict);
                }
                receipt.versions.push(payload.clone());
            }
            // Journal ownership before materializing a version. An interrupted copy
            // is repairable; existing registrations still point at the old version.
            self.write_json(&self.receipt_path(), &receipt.to_json())?;
            self.make_directory(&directory)?;
            self.write_atomic(&binary, &bytes, 0o700)?;
            if read_regular(&binary, 64 << 20).map(|written| digest(&written)).ok().as_deref() != Some(payload.sha256.as_str()) {
                return Err(SetupError::InvalidPayload);
            }
            let executable = binary.to_str().ok_or(SetupError::UnsafePath)?;
            let host = manifest::host(executable).map_err(|_| SetupError::UnsafePath)?;
            let mut registered = Vec::new();
            for browser in self.present()? {
                let path = self.registration(browser);
                self.make_directory(path.parent().ok_or(SetupError::UnsafePath)?)?;
                self.registered(browser, Some(&receipt))?;
                self.write_json(&path, &host)?;
                registered.push(browser.id);
            }
            // A registration lives inside its profile, so every earlier one was rewritten above.
            receipt.browsers = registered.clone();
            self.write_json(&self.receipt_path(), &receipt.to_json())?;
            Ok(registered)
        })
    }

    pub fn uninstall(&self) -> Result<()> {
        let Some(initial) = self.receipt()? else {
            for browser in &BROWSERS {
                self.registered(browser, None)?;
            }
            return Ok(());
        };
        for browser in &BROWSERS {
            self.registered(browser, Some(&initial))?;
        }
        self.with_lock(|| {
            let Some(receipt) = self.receipt()? else { return Ok(()) };
            let mut registrations = Vec::new();
            for browser in &BROWSERS {
                if self.registered(browser, Some(&receipt))?.is_some() {
                    registrations.push(self.registration(browser));
                }
            }
            // Validate every target before deleting anything. Never delete recursively.
            for payload in &receipt.versions {
                let binary = self.executable(payload);
                self.safe(&binary)?;
                if let Ok(metadata) = fs::symlink_metadata(&binary) {
                    if !metadata.file_type().is_file() {
                        return Err(SetupError::OwnershipConflict);
                    }
                }
                if let Ok(entries) = fs::read_dir(binary.parent().unwrap()) {
                    if entries.filter_map(|e| e.ok()).any(|e| e.file_name() != HELPER) {
                        return Err(SetupError::OwnershipConflict);
                    }
                }
            }
            for path in registrations {
                io(fs::remove_file(path))?;
            }
            for payload in &receipt.versions {
                let binary = self.executable(payload);
                if fs::symlink_metadata(&binary).is_ok() {
                    io(fs::remove_file(&binary))?;
                }
                self.remove_empty(binary.parent().unwrap())?;
            }
            io(fs::remove_file(self.receipt_path()))?;
            self.remove_empty(&self.versions_path())?;
            self.remove_empty(&self.root)?;
            self.remove_empty(self.root.parent().unwrap())?;
            self.remove_empty(self.root.parent().unwrap().parent().unwrap())
        })
    }

    fn remove_empty(&self, path: &Path) -> Result<()> {
        self.safe(path)?;
        if fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none()) {
            io(fs::remove_dir(path))?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
