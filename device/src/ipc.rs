//! The per-user socket between the shim (or the `anon-guard` CLI) and the app.
//!
//! Frames: u32 length in native byte order, then the bytes (the same machine
//! on both ends). The first frame each way is a versioned hello, so either side
//! can refuse the other: `{"ipc":1,"role":"shim"|"cli","origin":…,"peer":…}`
//! and `{"ipc":1,"app":"<version>"}`. After that a shim sends wallet request
//! frames and reads one reply frame each; a CLI sends `{"op":"status"|"quit"}`.
#[cfg(unix)]
use std::fs;
use std::io::{self, Read, Write};
#[cfg(unix)]
use std::path::PathBuf;
use std::time::Duration;

use interprocess::local_socket::{prelude::*, ListenerOptions, Name, Stream};
use serde_json::{json, Value};

use crate::VERSION;

pub const IPC_VERSION: u64 = 1;
/// Wallet frames are at most 4 KiB; the CLI's status reply is small too.
pub const MAX_FRAME: usize = 64 * 1024;
/// The exchange of one wallet request: longer than the bridge's helper deadline.
/// A hung app must not hang the shim (and with it a wallet request) forever.
pub const IO_TIMEOUT: Duration = Duration::from_secs(45);
/// A running app answers the hello at once. This only bounds an app that is
/// alive but not answering (stopped, deadlocked, in a debugger), so liveness
/// checks and `appStatus` answer in about this long instead of `IO_TIMEOUT`.
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(2);

pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_ne_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut buf = vec![0; n];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_frame(w: &mut impl Write, bytes: &[u8]) -> io::Result<()> {
    if bytes.len() > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}

pub fn write_json(w: &mut impl Write, value: &Value) -> io::Result<()> {
    write_frame(w, value.to_string().as_bytes())
}

pub fn read_json(r: &mut impl Read) -> io::Result<Option<Value>> {
    match read_frame(r)? {
        None => Ok(None),
        Some(bytes) => {
            serde_json::from_slice(&bytes).map(Some).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame is not JSON"))
        }
    }
}

#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    crate::identity::run_dir().join("guard.sock")
}

#[cfg(unix)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::GenericFilePath;
    socket_path().to_fs_name::<GenericFilePath>()
}

#[cfg(windows)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::GenericNamespaced;
    crate::identity::pipe_name().to_ns_name::<GenericNamespaced>()
}

/// The app's end of the socket, plus the lock that makes it the only instance.
pub struct Bound {
    pub listener: interprocess::local_socket::Listener,
    #[cfg(unix)]
    _lock: fs::File,
}

#[derive(Debug)]
pub enum BindError {
    AlreadyRunning,
    Io(io::Error),
}

impl From<io::Error> for BindError {
    fn from(e: io::Error) -> Self {
        BindError::Io(e)
    }
}

/// Owner-only run directory. Refuses a symlink or a directory another user owns.
#[cfg(unix)]
pub fn prepare_run_dir() -> io::Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = crate::identity::run_dir();
    fs::create_dir_all(&dir)?;
    let meta = fs::symlink_metadata(&dir)?;
    // SAFETY: geteuid has no failure mode.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(not_ours());
    }
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

/// The run directory as the app leaves it: a real directory (not a symlink),
/// owned by this user, closed to everyone else. Clients check this before
/// trusting anything in it; they never create or repair it.
#[cfg(unix)]
pub fn check_run_dir() -> io::Result<PathBuf> {
    use std::os::unix::fs::MetadataExt;
    let dir = crate::identity::run_dir();
    let meta = fs::symlink_metadata(&dir)?;
    // SAFETY: geteuid has no failure mode.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(not_ours());
    }
    Ok(dir)
}

#[cfg(unix)]
fn not_ours() -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, "run directory is not ours")
}

/// Single instance on Unix is a flock on a lock file, held for the app's lifetime.
/// The socket alone can't be the lock: clearing a stale socket after a crash means
/// unlinking it, and two copies starting together could each unlink the other's.
#[cfg(unix)]
pub fn bind() -> Result<Bound, BindError> {
    #[cfg(target_os = "linux")]
    use interprocess::os::unix::local_socket::ListenerOptionsExt;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;

    let dir = prepare_run_dir()?;
    let lock = fs::OpenOptions::new().create(true).truncate(false).write(true).mode(0o600).open(dir.join("guard.lock"))?;
    // SAFETY: a valid descriptor owned by `lock`.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(BindError::AlreadyRunning);
    }
    // We hold the lock, so any socket file left behind belongs to a dead instance.
    match fs::remove_file(socket_path()) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let options = ListenerOptions::new().name(socket_name()?);
    // macOS can't fchmod a socket before bind (interprocess reports Unsupported), so there
    // the 0700 directory and the peer check carry it; Linux also gets a 0600 socket.
    #[cfg(target_os = "linux")]
    let options = options.mode(0o600);
    let listener = options.create_sync()?;
    Ok(Bound { listener, _lock: lock })
}

/// On Windows the first pipe instance is the lock: a second create fails while it lives.
#[cfg(windows)]
pub fn bind() -> Result<Bound, BindError> {
    match ListenerOptions::new().name(socket_name()?).create_sync() {
        Ok(listener) => Ok(Bound { listener }),
        Err(e) if e.kind() == io::ErrorKind::AddrInUse || e.kind() == io::ErrorKind::PermissionDenied => Err(BindError::AlreadyRunning),
        Err(e) => Err(e.into()),
    }
}

/// Same user only, on both ends: the app checks each client and each client
/// checks the app. The 0700 directory already stops others; this is the second lock.
#[cfg(unix)]
pub fn check_peer(conn: &Stream) -> io::Result<()> {
    let euid = conn.peer_creds()?.euid();
    // SAFETY: geteuid has no failure mode.
    if euid != Some(unsafe { libc::geteuid() }) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "peer is another user"));
    }
    Ok(())
}

#[cfg(windows)]
pub fn check_peer(_: &Stream) -> io::Result<()> {
    Ok(())
}

/// Why `connect` found no app to talk to.
#[derive(Debug)]
pub enum ConnectError {
    /// Nothing answers: no socket, nothing listening on it, not this user's
    /// directory or process, or a refused hello.
    Unreachable(io::Error),
    /// Something took the connection but did not answer the hello in time: the
    /// app is alive but hung. Another copy would only find it running.
    Unresponsive,
}

/// Connects to the running app and exchanges the hello within `HELLO_TIMEOUT`.
/// Returns the stream, with `IO_TIMEOUT` for what follows, and the app's
/// version. `role` is "shim" or "cli". On Unix the socket counts only in this
/// user's private run directory, with this user's process behind it.
pub fn connect(role: &str, origin: &str) -> Result<(Stream, String), ConnectError> {
    connect_within(role, origin, HELLO_TIMEOUT)
}

/// `connect` with another bound on the hello (at least 100 ms).
pub fn connect_within(role: &str, origin: &str, hello: Duration) -> Result<(Stream, String), ConnectError> {
    use ConnectError::Unreachable;
    #[cfg(unix)]
    check_run_dir().map_err(Unreachable)?;
    let mut stream = Stream::connect(socket_name().map_err(Unreachable)?).map_err(Unreachable)?;
    check_peer(&stream).map_err(Unreachable)?;
    set_timeouts(&stream, hello.max(Duration::from_millis(100)));
    let reply = write_json(&mut stream, &json!({ "ipc": IPC_VERSION, "role": role, "origin": origin, "peer": VERSION }))
        .and_then(|_| read_json(&mut stream));
    let hello = match reply {
        Ok(Some(hello)) => hello,
        Ok(None) => return Err(Unreachable(io::Error::new(io::ErrorKind::UnexpectedEof, "app closed during hello"))),
        Err(e) if timed_out(&e) => return Err(ConnectError::Unresponsive),
        Err(e) => return Err(Unreachable(e)),
    };
    if hello.get("ipc").and_then(Value::as_u64) != Some(IPC_VERSION) {
        return Err(Unreachable(io::Error::new(io::ErrorKind::InvalidData, "ipcVersion")));
    }
    let version = hello.get("app").and_then(Value::as_str).unwrap_or_default().to_string();
    set_timeouts(&stream, IO_TIMEOUT);
    Ok((stream, version))
}

/// A read or write deadline passed (Unix reports `EAGAIN` for a socket timeout).
pub fn timed_out(error: &io::Error) -> bool {
    matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut)
}

/// One request frame out, one reply frame back.
pub fn exchange(stream: &mut Stream, frame: &[u8]) -> io::Result<Vec<u8>> {
    write_frame(stream, frame)?;
    read_frame(stream)?.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "app closed"))
}

/// Unix sockets get read/write deadlines; named pipes have none (interprocess
/// reports Unsupported), so on Windows a hung app can still hold a request.
fn set_timeouts(stream: &Stream, timeout: Duration) {
    let _ = stream.set_recv_timeout(Some(timeout));
    let _ = stream.set_send_timeout(Some(timeout));
}
