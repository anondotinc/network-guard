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
        let mut reply = json!({ "ok": true, "shim": VERSION, "ipc": IPC_VERSION, "appRunning": running });
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

/// Chrome runs native hosts in a job object; the app must break away from it or it dies
/// with the shim. The spike records which path worked.
#[cfg(windows)]
fn launch() -> io::Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = own_dir()?.join("anon-guard.exe");
    let spawn = |flags: u32, how: &str| {
        Command::new(&exe)
            .arg(format!("--launched-by=shim-{how}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB, "breakaway")
        .or_else(|_| spawn(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP, "in-job"))?;
    Ok(())
}
