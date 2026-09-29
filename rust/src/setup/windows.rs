//! Windows layout (per user, no administrator rights):
//!   %LOCALAPPDATA%\Anon\NetworkGuard\<channel>\installation.json
//!   %LOCALAPPDATA%\Anon\NetworkGuard\<channel>\versions\<version>-<sha256>\anon-network-helper.exe
//!   %LOCALAPPDATA%\Anon\NetworkGuard\<channel>\hosts\<host>.json
//!   HKCU\<browser key>\NativeMessagingHosts\<host> (default) = the manifest path,
//!   for each browser that has a profile.
use super::*;
use crate::manifest;
use crate::platform::windows::{lock, trust};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteKeyW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
    REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
};

/// Profiles relative to `%LOCALAPPDATA%`; registry keys under HKCU. Edge reads
/// its own key, then Chromium's, then Chrome's; Chrome reads only its own.
pub const BROWSERS: [Browser; 4] = [
    Browser {
        id: "chrome",
        name: "Google Chrome",
        profile: "Google\\Chrome\\User Data",
        registry: "Software\\Google\\Chrome\\NativeMessagingHosts",
    },
    Browser { id: "chromium", name: "Chromium", profile: "Chromium\\User Data", registry: "Software\\Chromium\\NativeMessagingHosts" },
    // Brave has no key of its own on Windows: it reads Chromium's, then Chrome's.
    Browser {
        id: "brave",
        name: "Brave",
        profile: "BraveSoftware\\Brave-Browser\\User Data",
        registry: "Software\\Google\\Chrome\\NativeMessagingHosts",
    },
    Browser {
        id: "edge",
        name: "Microsoft Edge",
        profile: "Microsoft\\Edge\\User Data",
        registry: "Software\\Microsoft\\Edge\\NativeMessagingHosts",
    },
];

fn wide(value: &str) -> Vec<u16> {
    trust::wide(value)
}

pub struct Installer {
    local: PathBuf,
    /// Prepended to every registry key; empty in real use, a scratch key in tests.
    registry_prefix: String,
    pub root: PathBuf,
}

impl Installer {
    pub fn for_current_user() -> Result<Self> {
        let local = trust::local_app_data().map_err(|_| SetupError::UnsafePath)?;
        Ok(Self::new(PathBuf::from(local), String::new()))
    }

    pub fn new(local: PathBuf, registry_prefix: String) -> Self {
        let root = local.join("Anon").join("NetworkGuard").join(build_info::CHANNEL);
        Installer { local, registry_prefix, root }
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
    pub fn manifest_path(&self) -> PathBuf {
        self.root.join("hosts").join(format!("{}.json", build_info::HOST_NAME))
    }
    fn key(&self, browser: &Browser) -> String {
        format!("{}{}\\{}", self.registry_prefix, browser.registry, build_info::HOST_NAME)
    }

    /// Below `%LOCALAPPDATA%`, and no existing component is a reparse point
    /// (symlink or junction).
    fn safe(&self, path: &Path) -> Result<()> {
        let relative = path.strip_prefix(&self.local).map_err(|_| SetupError::UnsafePath)?;
        if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
            return Err(SetupError::UnsafePath);
        }
        let mut cursor = self.local.clone();
        for component in relative.components() {
            cursor.push(component);
            let text = cursor.to_str().ok_or(SetupError::UnsafePath)?;
            // SAFETY: NUL-terminated wide string.
            let attributes = unsafe { GetFileAttributesW(wide(text).as_ptr()) };
            if attributes != INVALID_FILE_ATTRIBUTES && attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(SetupError::UnsafePath);
            }
        }
        Ok(())
    }

    fn make_directory(&self, path: &Path) -> Result<()> {
        self.safe(path)?;
        io(fs::create_dir_all(path))?;
        self.safe(path)
    }

    fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        self.safe(path)?;
        let name = path.file_name().ok_or(SetupError::UnsafePath)?.to_string_lossy();
        let temporary = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
        self.safe(&temporary)?;
        let _ = fs::remove_file(&temporary);
        let result = (|| {
            use std::io::Write;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
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
        self.write_atomic(path, &bytes)
    }

    fn read_key(&self, browser: &Browser) -> Result<Option<String>> {
        let key = wide(&self.key(browser));
        let mut buffer = vec![0u16; 1024];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: buffer and size describe writable memory; the default value is read.
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                std::ptr::null(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr() as _,
                &mut size,
            )
        };
        if status == 2 {
            return Ok(None); // ERROR_FILE_NOT_FOUND: no key or no default value
        }
        if status != ERROR_SUCCESS {
            return Err(SetupError::RegistrationConflict);
        }
        let length = (size as usize / 2).saturating_sub(1);
        Ok(Some(OsString::from_wide(&buffer[..length]).to_string_lossy().into_owned()))
    }

    fn write_key(&self, browser: &Browser, value: &str) -> Result<()> {
        let key = wide(&self.key(browser));
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: out-handle closed below; the value is a NUL-terminated wide string.
        unsafe {
            if RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            ) != ERROR_SUCCESS
            {
                return Err(SetupError::IoFailure);
            }
            let data = wide(value);
            let status = RegSetValueExW(handle, std::ptr::null(), 0, REG_SZ, data.as_ptr() as *const u8, (data.len() * 2) as u32);
            RegCloseKey(handle);
            if status != ERROR_SUCCESS {
                return Err(SetupError::IoFailure);
            }
        }
        Ok(())
    }

    fn delete_key(&self, browser: &Browser) -> Result<()> {
        let key = wide(&self.key(browser));
        // SAFETY: deletes only this host's leaf key, which has no subkeys.
        let status = unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, key.as_ptr()) };
        if status == ERROR_SUCCESS || status == 2 {
            Ok(())
        } else {
            Err(SetupError::IoFailure)
        }
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

    /// The version a browser's registration points at, or `None` without one.
    /// A registration that isn't this installer's manifest is a conflict.
    fn registered(&self, browser: &Browser, receipt: Option<&Receipt>) -> Result<Option<Payload>> {
        let Some(value) = self.read_key(browser)? else { return Ok(None) };
        let manifest_path = self.manifest_path();
        if Some(value.as_str()) != manifest_path.to_str() {
            return Err(SetupError::RegistrationConflict);
        }
        self.safe(&manifest_path)?;
        let Ok(bytes) = read_regular(&manifest_path, 16384) else { return Err(SetupError::RegistrationConflict) };
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| SetupError::RegistrationConflict)?;
        receipt
            .and_then(|receipt| {
                receipt.versions.iter().find(|payload| manifest::matches(&manifest, &self.executable(payload).to_string_lossy()))
            })
            .cloned()
            .map(Some)
            .ok_or(SetupError::RegistrationConflict)
    }

    fn present(&self) -> Result<Vec<&'static Browser>> {
        let mut found = Vec::new();
        for browser in &BROWSERS {
            let profile = self.local.join(browser.profile);
            if fs::metadata(&profile).is_ok_and(|m| m.is_dir()) {
                self.safe(&profile)?;
                found.push(browser);
            }
        }
        Ok(found)
    }

    fn with_lock<T>(&self, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        let name = format!("inc.anon.network-guard.setup.{}", build_info::CHANNEL);
        let _lock = lock::exclusive(&name, SetupError::InstallBusy, SetupError::InstallBusy)?;
        operation()
    }

    pub fn check(&self) -> Result<State> {
        let receipt = self.receipt()?;
        let mut active: Option<Payload> = None;
        let mut repair = false;
        for browser in &BROWSERS {
            match self.registered(browser, receipt.as_ref())? {
                Some(payload) => active = Some(payload),
                None if receipt.as_ref().is_some_and(|r| r.browsers.contains(&browser.id)) => repair = true,
                None => {}
            }
        }
        let Some(receipt) = receipt else { return Ok(State::NotInstalled) };
        let Some(active) = active else { return Ok(State::NeedsRepair) };
        let binary = self.executable(&active);
        self.safe(&binary)?;
        let intact = read_regular(&binary, 64 << 20).is_ok_and(|bytes| digest(&bytes) == active.sha256);
        let present = self.present()?;
        if repair || !intact || present.iter().any(|browser| !receipt.browsers.contains(&browser.id)) {
            return Ok(State::NeedsRepair);
        }
        Ok(State::Installed { version: active.version, browsers: receipt.browsers })
    }

    pub fn install(&self, payload: &Payload, bundled: &Path) -> Result<Vec<&'static str>> {
        payload.validate()?;
        let bytes = read_regular(bundled, 64 << 20).map_err(|_| SetupError::InvalidPayload)?;
        if digest(&bytes) != payload.sha256 {
            return Err(SetupError::InvalidPayload);
        }
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
            // Journal ownership before materializing a version.
            self.write_json(&self.receipt_path(), &receipt.to_json())?;
            self.make_directory(&directory)?;
            self.write_atomic(&binary, &bytes)?;
            if read_regular(&binary, 64 << 20).map(|written| digest(&written)).ok().as_deref() != Some(payload.sha256.as_str()) {
                return Err(SetupError::InvalidPayload);
            }
            let executable = binary.to_str().ok_or(SetupError::UnsafePath)?;
            let manifest_path = self.manifest_path();
            self.make_directory(manifest_path.parent().ok_or(SetupError::UnsafePath)?)?;
            self.write_json(&manifest_path, &manifest::host(executable).map_err(|_| SetupError::UnsafePath)?)?;
            let manifest_text = manifest_path.to_str().ok_or(SetupError::UnsafePath)?;
            let mut registered = Vec::new();
            for browser in self.present()? {
                self.write_key(browser, manifest_text)?;
                registered.push(browser.id);
            }
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
                    registrations.push(browser);
                }
            }
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
            for browser in registrations {
                self.delete_key(browser)?;
            }
            let manifest_path = self.manifest_path();
            if fs::symlink_metadata(&manifest_path).is_ok() {
                io(fs::remove_file(&manifest_path))?;
            }
            self.remove_empty(manifest_path.parent().unwrap())?;
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
#[path = "windows_tests.rs"]
mod tests;
