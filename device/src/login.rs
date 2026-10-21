//! Start at login, per platform. `status()` is what v9 `appStatus` reports:
//! `enabled`, `off`, `requiresApproval` (macOS only) or `unknown`.
//!
//! - macOS: the LaunchAgent login item inside the bundle
//!   (`Contents/Library/LaunchAgents/<label>.plist`, `SMAppService`). launchd
//!   starts the app as soon as it is turned on and restarts it after a crash;
//!   a clean Quit stays down. Before the first registration SMAppService says
//!   `notFound`, which counts as off, like `notRegistered`.
//! - Linux: an XDG autostart entry, `~/.config/autostart/<bundle id>.desktop`.
//! - Windows: a value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//!   A fresh profile may have no Run key at all, so registering creates it.
pub use imp::{register, status, unregister};

/// Opens the system's login-items settings (macOS); elsewhere a no-op.
pub fn open_settings() {
    #[cfg(target_os = "macos")]
    imp::open_settings();
}

#[cfg(target_os = "macos")]
mod imp {
    use crate::identity::AGENT_PLIST;
    use objc2::rc::Retained;
    use objc2_foundation::NSString;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    fn agent() -> Retained<SMAppService> {
        // SAFETY: a plain constructor; the plist name is a fixed constant.
        unsafe { SMAppService::agentServiceWithPlistName(&NSString::from_str(AGENT_PLIST)) }
    }

    pub fn status() -> &'static str {
        // SAFETY: a read of the service's registration state.
        match unsafe { agent().status() } {
            SMAppServiceStatus::Enabled => "enabled",
            SMAppServiceStatus::NotRegistered | SMAppServiceStatus::NotFound => "off",
            SMAppServiceStatus::RequiresApproval => "requiresApproval",
            _ => "unknown",
        }
    }

    pub fn register() -> Result<(), String> {
        // SAFETY: registers this bundle's own agent plist.
        unsafe { agent().registerAndReturnError() }.map_err(|e| format!("{} (code {})", e.localizedDescription(), e.code()))
    }

    pub fn unregister() -> Result<(), String> {
        // SAFETY: unregisters this bundle's own agent plist.
        unsafe { agent().unregisterAndReturnError() }.map_err(|e| format!("{} (code {})", e.localizedDescription(), e.code()))
    }

    pub fn open_settings() {
        // SAFETY: opens System Settings; no arguments.
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use crate::identity::{home, BUNDLE_ID};
    use std::path::PathBuf;

    fn entry() -> Option<PathBuf> {
        let config =
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| Some(home()?.join(".config")))?;
        Some(config.join("autostart").join(format!("{BUNDLE_ID}.desktop")))
    }

    pub fn status() -> &'static str {
        let Some(path) = entry() else { return "unknown" };
        match std::fs::read_to_string(path) {
            Ok(text) if text.lines().any(|l| l.trim() == "X-GNOME-Autostart-enabled=false" || l.trim() == "Hidden=true") => "off",
            Ok(_) => "enabled",
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "off",
            Err(_) => "unknown",
        }
    }

    pub fn register() -> Result<(), String> {
        let path = entry().ok_or("no home directory")?;
        let exe = std::env::current_exe().and_then(|p| p.canonicalize()).map_err(|e| e.to_string())?;
        let exe = exe.to_str().filter(|p| !p.contains(['"', '\n', '\\', '`', '$'])).ok_or("unsupported executable path")?;
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let text = format!(
            "[Desktop Entry]\nType=Application\nName={}\nExec=\"{exe}\" --launched-by=login\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n",
            crate::identity::APP_NAME
        );
        std::fs::write(path, text).map_err(|e| e.to_string())
    }

    pub fn unregister() -> Result<(), String> {
        let path = entry().ok_or("no home directory")?;
        match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

#[cfg(windows)]
mod imp {
    use crate::identity::RUN_VALUE;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteKeyValueW, RegGetValueW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ, RRF_RT_REG_SZ,
    };

    const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value).encode_wide().chain(Some(0)).collect()
    }

    pub fn status() -> &'static str {
        let (key, name) = (wide(RUN_KEY), wide(RUN_VALUE));
        let mut size = 0u32;
        // SAFETY: a size query (no buffer) of one value under HKCU.
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        match result {
            ERROR_SUCCESS => "enabled",
            // No value, or no Run key at all on a fresh profile.
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "off",
            _ => "unknown",
        }
    }

    pub fn register() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.to_str().ok_or("unsupported executable path")?;
        let exe = exe.strip_prefix(r"\\?\").unwrap_or(exe);
        let value = wide(&format!("\"{exe}\" --launched-by=login"));
        let (key, name) = (wide(RUN_KEY), wide(RUN_VALUE));
        let mut handle: HKEY = std::ptr::null_mut();
        // SAFETY: creates (or opens) the Run key; the handle is closed below.
        let created = unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                0,
                std::ptr::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE,
                std::ptr::null(),
                &mut handle,
                std::ptr::null_mut(),
            )
        };
        if created != ERROR_SUCCESS {
            return Err(format!("cannot open the Run key ({created})"));
        }
        // SAFETY: a NUL-terminated wide string value, its size in bytes.
        let set = unsafe { RegSetValueExW(handle, name.as_ptr(), 0, REG_SZ, value.as_ptr().cast(), (value.len() * 2) as u32) };
        // SAFETY: the handle from RegCreateKeyExW above.
        unsafe { RegCloseKey(handle) };
        if set == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(format!("cannot write the Run value ({set})"))
        }
    }

    pub fn unregister() -> Result<(), String> {
        let (key, name) = (wide(RUN_KEY), wide(RUN_VALUE));
        // SAFETY: deletes only this app's value under the Run key.
        match unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), name.as_ptr()) } {
            ERROR_SUCCESS | ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Ok(()),
            error => Err(format!("cannot delete the Run value ({error})")),
        }
    }
}
