//! Starting the app for v9 `openApp`, which the wallet sends only after a
//! user's click. A background poll never reaches this module.
//!
//! - macOS: `launchctl kickstart` of the registered LaunchAgent when it exists
//!   and is this bundle's, so launchd keeps owning the process; otherwise
//!   `open -n -g` of the bundle. A shim outside a bundle (development builds,
//!   tests) starts its sibling binary directly, like Linux.
//! - Linux: the sibling binary in a new session (`setsid`), so it outlives
//!   the host when Chrome closes the port.
//! - Windows: `CreateProcessW` with handle inheritance off. An inherited
//!   handle ties the app to Chrome's pipes and a browser close then hangs
//!   until the app exits (the spike measured 20 s on both runners).
//!
//! While one shim is starting the app, it holds the *starting lock* (a flock
//! on `<run dir>/starting.lock`, or a named mutex on Windows). Any other shim,
//! or another request on the same port, sees it and answers `appStarting`.
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::identity::APP_EXE;
use crate::ipc;

/// How long `openApp` waits for the started app to answer on its socket.
pub const LAUNCH_WAIT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The app answers; its version from the socket hello.
    Running(String),
    /// Another launch is in progress.
    Starting,
    /// It could not be started, or did not answer within `LAUNCH_WAIT`.
    Failed,
}

/// Starts the app unless it already answers or another launch is in progress,
/// then waits for it to answer.
pub fn open_app(origin: &str) -> Opened {
    let Some(_lock) = StartingLock::acquire() else { return Opened::Starting };
    // It may have come up while another shim held the lock.
    if let Ok((_, version)) = ipc::connect("shim", origin) {
        return Opened::Running(version);
    }
    if start().is_err() {
        return Opened::Failed;
    }
    let deadline = Instant::now() + LAUNCH_WAIT;
    loop {
        if let Ok((_, version)) = ipc::connect("shim", origin) {
            return Opened::Running(version);
        }
        if Instant::now() >= deadline {
            return Opened::Failed;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn own_dir() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?.canonicalize()?;
    exe.parent().map(Path::to_path_buf).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no parent"))
}

/// `…/Name.app` when `dir` is its `Contents/MacOS`.
#[cfg(target_os = "macos")]
fn enclosing_bundle(dir: &Path) -> Option<PathBuf> {
    let contents = dir.parent().filter(|_| dir.file_name() == Some("MacOS".as_ref()))?;
    let bundle = contents.parent().filter(|_| contents.file_name() == Some("Contents".as_ref()))?;
    (bundle.extension() == Some("app".as_ref())).then(|| bundle.to_path_buf())
}

#[cfg(target_os = "macos")]
fn start() -> io::Result<()> {
    use std::process::{Command, Stdio};
    let dir = own_dir()?;
    let Some(bundle) = enclosing_bundle(&dir) else { return spawn_detached(&dir.join(APP_EXE)) };
    if kickstart(&bundle) {
        return Ok(());
    }
    let mut open = Command::new("/usr/bin/open");
    open.args(["-n", "-g"]);
    // LaunchServices starts apps with launchd's environment. Pass HOME so the
    // app serves the same per-user socket this shim looks for.
    if let Some(home) = crate::identity::home() {
        open.arg("--env").arg(format!("HOME={}", home.display()));
    }
    let status = open
        .arg(&bundle)
        .args(["--args", "--launched-by=shim"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other("open failed"))
    }
}

/// Starts the registered agent when it is enabled, is this bundle's app, and
/// this shim runs in the account's own home (launchd's environment).
#[cfg(target_os = "macos")]
fn kickstart(bundle: &Path) -> bool {
    use std::process::{Command, Stdio};
    if crate::login::status() != "enabled" || !home_is_account_home() {
        return false;
    }
    // SAFETY: getuid has no failure mode.
    let target = format!("gui/{}/{}", unsafe { libc::getuid() }, crate::identity::AGENT_LABEL);
    let Ok(printed) = Command::new("/bin/launchctl").args(["print", &target]).stderr(Stdio::null()).output() else { return false };
    let text = String::from_utf8_lossy(&printed.stdout);
    let program = text.lines().find_map(|line| line.trim().strip_prefix("program = ")).map(PathBuf::from);
    let ours = bundle.join("Contents/MacOS").join(APP_EXE).canonicalize().ok();
    if !printed.status.success() || program.and_then(|p| p.canonicalize().ok()) != ours || ours.is_none() {
        return false;
    }
    Command::new("/bin/launchctl")
        .args(["kickstart", &target])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// `HOME` is the account's home directory from the user database.
#[cfg(target_os = "macos")]
fn home_is_account_home() -> bool {
    let Some(home) = crate::identity::home() else { return false };
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: buffers owned by this frame; getpwuid_r writes only within them.
    let found = unsafe { libc::getpwuid_r(libc::getuid(), &mut entry, buffer.as_mut_ptr(), buffer.len(), &mut result) };
    if found != 0 || result.is_null() || entry.pw_dir.is_null() {
        return false;
    }
    // SAFETY: getpwuid_r succeeded, so pw_dir is a NUL-terminated string in `buffer`.
    let account = unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }.to_string_lossy().into_owned();
    let canonical = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    canonical(&home) == canonical(Path::new(&account))
}

#[cfg(target_os = "linux")]
fn start() -> io::Result<()> {
    spawn_detached(&own_dir()?.join(APP_EXE))
}

/// The app in a new session with no stdio, so it outlives the host.
#[cfg(unix)]
fn spawn_detached(exe: &Path) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut command = Command::new(exe);
    command.arg("--launched-by=shim").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches only the child.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    // Reap it if it exits while this shim is still alive (an "already running" copy).
    std::thread::spawn(move || child.wait());
    Ok(())
}

/// Detached, in a new process group, with no inherited handles. Breaking away
/// from the job is tried first; a job that refuses it (a CI runner's) still
/// lets the app outlive the browser.
#[cfg(windows)]
fn start() -> io::Result<()> {
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};
    let exe = own_dir()?.join(APP_EXE);
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    create_process_no_inherit(&exe, base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| create_process_no_inherit(&exe, base))
}

#[cfg(windows)]
fn create_process_no_inherit(exe: &Path, flags: u32) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW};
    let text = exe.to_str().ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path"))?;
    let text = text.strip_prefix(r"\\?\").unwrap_or(text);
    let application: Vec<u16> = std::ffi::OsStr::new(text).encode_wide().chain(Some(0)).collect();
    let mut command_line: Vec<u16> = format!("\"{text}\" --launched-by=shim").encode_utf16().chain(Some(0)).collect();
    // SAFETY: zeroed POD structures; cb is set before use.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: NUL-terminated strings and valid out-structures; bInheritHandles = 0.
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            flags,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut info,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: handles returned by CreateProcessW, closed once.
    unsafe {
        CloseHandle(info.hProcess);
        CloseHandle(info.hThread);
    }
    Ok(())
}

/// Held for the duration of one launch.
pub struct StartingLock {
    #[cfg(unix)]
    _file: std::fs::File,
    #[cfg(windows)]
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(unix)]
fn lock_path() -> PathBuf {
    crate::identity::run_dir().join("starting.lock")
}

#[cfg(windows)]
fn mutex_name() -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let name = format!("Local\\{}.starting", crate::identity::pipe_name());
    std::ffi::OsStr::new(&name).encode_wide().chain(Some(0)).collect()
}

impl StartingLock {
    /// `None` while another launch holds it. A brief retry covers a checker
    /// that holds the shared lock for an instant.
    #[cfg(unix)]
    pub fn acquire() -> Option<StartingLock> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        ipc::prepare_run_dir().ok()?;
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(lock_path()).ok()?;
        for _ in 0..10 {
            // SAFETY: a valid descriptor owned by `file`.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                return Some(StartingLock { _file: file });
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    #[cfg(windows)]
    pub fn acquire() -> Option<StartingLock> {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
        // SAFETY: a NUL-terminated name; the handle is closed on every path.
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, mutex_name().as_ptr()) };
        if handle.is_null() {
            return None;
        }
        for _ in 0..10 {
            match unsafe { WaitForSingleObject(handle, 0) } {
                WAIT_OBJECT_0 | WAIT_ABANDONED => return Some(StartingLock { handle }),
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        }
        unsafe { CloseHandle(handle) };
        None
    }

    /// Whether some other launch holds the lock right now.
    #[cfg(unix)]
    pub fn held_elsewhere() -> bool {
        use std::os::fd::AsRawFd;
        let Ok(file) = std::fs::File::open(lock_path()) else { return false };
        // SAFETY: a valid descriptor owned by `file`.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) } == 0 {
            // SAFETY: as above; released before `file` closes anyway.
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
            return false;
        }
        true
    }

    #[cfg(windows)]
    pub fn held_elsewhere() -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenMutexW, ReleaseMutex, WaitForSingleObject, MUTEX_ALL_ACCESS};
        // SAFETY: a NUL-terminated name; the handle is closed below.
        let handle = unsafe { OpenMutexW(MUTEX_ALL_ACCESS, 0, mutex_name().as_ptr()) };
        if handle.is_null() {
            return false;
        }
        let held = match unsafe { WaitForSingleObject(handle, 0) } {
            WAIT_OBJECT_0 | WAIT_ABANDONED => {
                unsafe { ReleaseMutex(handle) };
                false
            }
            _ => true,
        };
        unsafe { CloseHandle(handle) };
        held
    }
}

#[cfg(windows)]
impl Drop for StartingLock {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        // SAFETY: this thread owns the mutex; the handle is ours.
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}
