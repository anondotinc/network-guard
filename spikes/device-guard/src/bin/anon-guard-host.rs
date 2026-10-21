//! Chrome native-messaging host shim. Chrome starts it; it forwards each frame to the
//! running app over the per-user socket and relays the reply. It never answers wallet
//! requests itself, and it only starts the app for an explicit `openGuard` (a user's click).

use std::env;
use std::io;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use guard_spike::{connect, error_reply, read_frame, write_frame, IPC_VERSION, VERSION};
use interprocess::local_socket::Stream;
use serde_json::{json, Value};

const LAUNCH_WAIT: Duration = Duration::from_secs(10);

fn main() {
    // Chrome passes the caller's origin first (and --parent-window=… on Windows).
    let origin = env::args().nth(1).unwrap_or_default();
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    let mut app: Option<Stream> = None;
    while let Ok(Some(frame)) = read_frame(&mut input) {
        let reply = handle(&frame, &mut app, &origin);
        if write_frame(&mut output, &reply).is_err() {
            break;
        }
    }
}

/// Returns the reply frame. The app's replies pass through byte for byte.
fn handle(frame: &[u8], app: &mut Option<Stream>, origin: &str) -> Vec<u8> {
    let Ok(request) = serde_json::from_slice::<Value>(frame) else {
        return error_reply(None, "badRequest").to_string().into_bytes();
    };
    let id = request.get("id");
    let op = request.get("op").and_then(Value::as_str);

    if op == Some("shimDescribe") {
        // Answered by the shim, so a wallet can tell "app stopped" from "host missing".
        let running = app.is_some() || connect("shim", origin).is_ok();
        let mut reply = json!({ "ok": true, "shim": VERSION, "ipc": IPC_VERSION, "appRunning": running, "job": guard_spike::job_info() });
        if let Some(id) = id {
            reply["id"] = id.clone();
        }
        return reply.to_string().into_bytes();
    }

    if app.is_none() {
        *app = connect("shim", origin).ok().map(|(stream, _)| stream);
    }
    if app.is_none() && op == Some("openGuard") {
        *app = launch_and_wait(origin);
    }
    // One retry covers an app that restarted between two messages on a long-lived port.
    for _ in 0..2 {
        let Some(stream) = app.as_mut() else { break };
        match forward(stream, frame) {
            Ok(reply) => return reply,
            Err(_) => *app = connect("shim", origin).ok().map(|(stream, _)| stream),
        }
    }
    error_reply(id, "appNotRunning").to_string().into_bytes()
}

fn forward(stream: &mut Stream, frame: &[u8]) -> io::Result<Vec<u8>> {
    write_frame(stream, frame)?;
    read_frame(stream)?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "app closed"))
}

fn launch_and_wait(origin: &str) -> Option<Stream> {
    if launch().is_err() {
        return None;
    }
    let deadline = Instant::now() + LAUNCH_WAIT;
    while Instant::now() < deadline {
        if let Ok((stream, _)) = connect("shim", origin) {
            return Some(stream);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

fn own_dir() -> io::Result<PathBuf> {
    let exe = env::current_exe()?;
    exe.parent().map(PathBuf::from).ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no parent"))
}

/// The shim lives in the app bundle's Contents/MacOS; LaunchServices opens the bundle
/// in the background so the app is not a child of Chrome's host process.
#[cfg(target_os = "macos")]
fn launch() -> io::Result<()> {
    let bundle = own_dir()?.join("../..").canonicalize()?;
    Command::new("/usr/bin/open").arg("-g").arg(bundle).args(["--args", "--launched-by=shim"]).status()?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn launch() -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    let mut cmd = Command::new(own_dir()?.join("anon-guard"));
    cmd.arg("--launched-by=shim").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // A new session, so the app outlives the host when Chrome closes the port.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd.spawn()?;
    Ok(())
}

/// Starts the app detached. How it is started is the spike's variable
/// (ANON_GUARD_SPIKE_LAUNCH):
/// - `clean` (default): CreateProcessW with handle inheritance off. The app needs
///   nothing from the shim, and an inherited handle ties it to Chrome's pipes (a
///   browser close hung until it exited).
/// - `std-noinherit`: std::process::Command after clearing the inherit flag on the
///   shim's three std handles.
/// - `std-inherit`: std::process::Command as is.
///
/// Each mode tries to break away from the job first and records whether it could.
#[cfg(windows)]
fn launch() -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = own_dir()?.join("anon-guard.exe");
    let mode = env::var("ANON_GUARD_SPIKE_LAUNCH").unwrap_or_else(|_| "clean".into());
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    if mode == "clean" {
        return create_process_no_inherit(&exe, "breakaway-clean", base | CREATE_BREAKAWAY_FROM_JOB)
            .or_else(|_| create_process_no_inherit(&exe, "in-job-clean", base));
    }
    if mode == "std-noinherit" {
        stdio_not_inheritable();
    }
    let spawn = |flags: u32, how: &str| {
        Command::new(&exe)
            .arg(format!("--launched-by=shim-{how}-{mode}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    spawn(base | CREATE_BREAKAWAY_FROM_JOB, "breakaway").or_else(|_| spawn(base, "in-job"))?;
    Ok(())
}

#[cfg(windows)]
fn create_process_no_inherit(exe: &std::path::Path, how: &str, flags: u32) -> io::Result<()> {
    use core::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        std_input: *mut c_void,
        std_output: *mut c_void,
        std_error: *mut c_void,
    }
    #[repr(C)]
    struct ProcessInformation {
        process: *mut c_void,
        thread: *mut c_void,
        pid: u32,
        tid: u32,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *mut c_void,
            thread_attributes: *mut c_void,
            inherit_handles: i32,
            flags: u32,
            environment: *mut c_void,
            current_directory: *const u16,
            startup: *mut StartupInfoW,
            info: *mut ProcessInformation,
        ) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    let application: Vec<u16> = exe.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut command_line: Vec<u16> = format!("\"{}\" --launched-by=shim-{how}", exe.display())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut startup: StartupInfoW = unsafe { core::mem::zeroed() };
    startup.cb = core::mem::size_of::<StartupInfoW>() as u32;
    let mut info: ProcessInformation = unsafe { core::mem::zeroed() };
    let ok = unsafe {
        CreateProcessW(
            application.as_ptr(),
            command_line.as_mut_ptr(),
            core::ptr::null_mut(),
            core::ptr::null_mut(),
            0, // no handle inheritance at all
            flags,
            core::ptr::null_mut(),
            core::ptr::null(),
            &mut startup,
            &mut info,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    unsafe {
        CloseHandle(info.process);
        CloseHandle(info.thread);
    }
    Ok(())
}

#[cfg(windows)]
fn stdio_not_inheritable() {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(which: u32) -> *mut core::ffi::c_void;
        fn SetHandleInformation(handle: *mut core::ffi::c_void, mask: u32, flags: u32) -> i32;
    }
    const HANDLE_FLAG_INHERIT: u32 = 0x1;
    // STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
    for which in [-10i32 as u32, -11i32 as u32, -12i32 as u32] {
        unsafe {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle as isize != -1 {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}
