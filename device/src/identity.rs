//! Per-channel names and per-user paths. Channels never share a bundle, host,
//! socket, login item or support directory. Every path derives from `HOME`
//! (`LOCALAPPDATA` on Windows), so tests run against a temporary home.
use std::path::PathBuf;

pub use network_guard::build_info::CHANNEL;

#[cfg(feature = "development")]
mod names {
    pub const BUNDLE_ID: &str = "inc.anon.network-guard.dev";
    pub const APP_NAME: &str = "Anon Network Guard Dev";
    pub const AGENT_LABEL: &str = "inc.anon.network-guard.dev.agent";
    pub const AGENT_PLIST: &str = "inc.anon.network-guard.dev.agent.plist";
    pub const RUN_VALUE: &str = "AnonNetworkGuardDev";
}
#[cfg(not(feature = "development"))]
mod names {
    pub const BUNDLE_ID: &str = "inc.anon.network-guard";
    pub const APP_NAME: &str = "Anon Network Guard";
    pub const AGENT_LABEL: &str = "inc.anon.network-guard.agent";
    pub const AGENT_PLIST: &str = "inc.anon.network-guard.agent.plist";
    pub const RUN_VALUE: &str = "AnonNetworkGuard";
}
/// `BUNDLE_ID` is also the Linux autostart file stem; `RUN_VALUE` the Windows
/// `HKCU\…\Run` value name.
pub use names::{AGENT_LABEL, AGENT_PLIST, APP_NAME, BUNDLE_ID, RUN_VALUE};

#[cfg(windows)]
pub const APP_EXE: &str = "anon-guard.exe";
#[cfg(not(windows))]
pub const APP_EXE: &str = "anon-guard";

#[cfg(windows)]
pub const HELPER_EXE: &str = "anon-network-helper.exe";
#[cfg(not(windows))]
pub const HELPER_EXE: &str = "anon-network-helper";

/// The receipt owner each platform's helper installer writes.
#[cfg(target_os = "macos")]
pub const HELPER_RECEIPT_OWNER: &str = "inc.anon.network-helper.setup.v1";
#[cfg(target_os = "linux")]
pub const HELPER_RECEIPT_OWNER: &str = "inc.anon.network-guard.setup.linux.v1";
#[cfg(windows)]
pub const HELPER_RECEIPT_OWNER: &str = "inc.anon.network-guard.setup.windows.v1";

pub fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).filter(|home| home.is_absolute())
}

#[cfg(windows)]
fn local_app_data() -> PathBuf {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(std::env::temp_dir)
}

#[cfg(unix)]
fn home_or_root() -> PathBuf {
    home().unwrap_or_else(|| PathBuf::from("/"))
}

/// The app's own per-user directory: `bridge.json` and (on macOS) `run/`.
/// Separate from the helper installer's root, whose ownership checks refuse
/// files they don't recognize.
pub fn support_dir() -> PathBuf {
    #[cfg(target_os = "macos")]
    return home_or_root().join("Library/Application Support/Anon/DeviceGuard").join(CHANNEL);
    #[cfg(target_os = "linux")]
    return std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| home_or_root().join(".local/state"))
        .join("anon/device-guard")
        .join(CHANNEL);
    #[cfg(windows)]
    return local_app_data().join("Anon").join("DeviceGuard").join(CHANNEL);
}

/// The installed helper's root, as its installer lays it out.
pub fn helper_root() -> PathBuf {
    #[cfg(target_os = "macos")]
    return home_or_root().join("Library/Application Support/Anon/NetworkHelper").join(CHANNEL);
    #[cfg(target_os = "linux")]
    return home_or_root().join(".local/share/anon/network-guard").join(CHANNEL);
    #[cfg(windows)]
    return local_app_data().join("Anon").join("NetworkGuard").join(CHANNEL);
}

/// Which installed helper version the bridge uses, written by development tooling.
pub fn bridge_file() -> PathBuf {
    support_dir().join("bridge.json")
}

/// `sun_path` holds 104 bytes on macOS and 108 on Linux.
#[cfg(unix)]
const MAX_SOCKET_PATH: usize = 100;

/// Per-user directory for the socket, the instance lock and the launch lock.
/// Linux: `$XDG_RUNTIME_DIR/anon-device-guard-<channel>`. Otherwise
/// `<support>/run`, or, when that path is too long for a socket (a long `HOME`,
/// as in tests), `anon-guard-<uid>-<c>-<hash of HOME>` in the temporary folder:
/// the per-user one on macOS, the shared `/tmp` on Linux. The app only binds
/// in a directory it owns and has made 0700, and clients only connect through
/// such a directory to a server running as the same user
/// (`ipc::prepare_run_dir`, `ipc::check_run_dir`, `ipc::check_peer`). Another
/// user can at worst take the `/tmp` name first, which stops the app; it can
/// never answer for it.
#[cfg(unix)]
pub fn run_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_absolute()) {
        return runtime.join(format!("anon-device-guard-{CHANNEL}"));
    }
    let preferred = support_dir().join("run");
    if preferred.join("guard.sock").as_os_str().len() <= MAX_SOCKET_PATH {
        return preferred;
    }
    // SAFETY: geteuid has no failure mode.
    short_run_dir(&short_temp(), unsafe { libc::geteuid() }, &home_or_root())
}

/// Short: macOS's per-user temp directory alone is about 49 bytes.
#[cfg(unix)]
fn short_run_dir(temp: &std::path::Path, uid: u32, home: &std::path::Path) -> PathBuf {
    let tag = fnv1a(home.as_os_str().as_encoded_bytes()) & 0xffff_ffff_ffff;
    temp.join(format!("anon-guard-{uid}-{}-{tag:012x}", &CHANNEL[..1]))
}

/// The per-user temporary directory (`/var/folders/…/T` on macOS), independent of `TMPDIR`.
#[cfg(target_os = "macos")]
fn short_temp() -> PathBuf {
    let mut buffer = vec![0u8; 1024];
    // SAFETY: the buffer is writable for its length; confstr NUL-terminates.
    let length = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, buffer.as_mut_ptr().cast(), buffer.len()) };
    if length > 1 && length <= buffer.len() {
        buffer.truncate(length - 1);
        if let Ok(text) = String::from_utf8(buffer) {
            return PathBuf::from(text);
        }
    }
    PathBuf::from("/tmp")
}

#[cfg(target_os = "linux")]
fn short_temp() -> PathBuf {
    PathBuf::from("/tmp")
}

#[cfg(unix)]
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3))
}

/// The named pipe on Windows, per channel and user.
#[cfg(windows)]
pub fn pipe_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    format!("anon-device-guard-{CHANNEL}-{user}")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn hash_is_stable_and_distinguishes_homes() {
        assert_eq!(fnv1a(b""), 0xcbf2_9ce4_8422_2325);
        assert_ne!(fnv1a(b"/Users/a"), fnv1a(b"/Users/b"));
    }

    #[test]
    fn the_short_run_dir_is_per_user_and_per_home() {
        let tmp = std::path::Path::new("/tmp");
        let home = std::path::Path::new("/home/a");
        let dir = short_run_dir(tmp, 1000, home);
        let name = dir.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with(&format!("anon-guard-1000-{}-", &CHANNEL[..1])), "{name}");
        assert_ne!(dir, short_run_dir(tmp, 1001, home));
        assert_ne!(dir, short_run_dir(tmp, 1000, std::path::Path::new("/home/b")));
        // Still a socket path even with a 10-digit uid in a 49-byte temp folder.
        let deep = std::path::Path::new("/var/folders/ab/cdefghijklmnopqrstuvwxyz0123/T");
        assert!(short_run_dir(deep, u32::MAX, home).join("guard.sock").as_os_str().len() <= MAX_SOCKET_PATH);
    }
}
