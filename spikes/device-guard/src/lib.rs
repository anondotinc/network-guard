//! Device Guard M0 spike: the pieces the tray app and the Chrome host shim share.
//!
//! Wire: Chrome native messaging frames (u32 length in native byte order, then UTF-8 JSON)
//! on stdio, and the same framing on the per-user local socket between the shim and the app.
//! The first frame on the socket is a versioned hello so either side can refuse the other.

#[cfg(unix)]
use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;

use interprocess::local_socket::{prelude::*, ListenerOptions, Name, Stream};
use serde_json::{json, Value};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const IPC_VERSION: u64 = 1;
pub const BUNDLE_ID: &str = "inc.anon.network-guard.spike";
pub const HOST_NAME: &str = "inc.anon.guard_spike";
pub const AGENT_PLIST: &str = "inc.anon.network-guard.spike.agent.plist";
/// Chrome caps host-to-browser messages at 1 MiB; nothing on this wire comes close.
pub const MAX_FRAME: usize = 1024 * 1024;

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
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame is not JSON")),
    }
}

/// A fixed-code failure the wallet can map without seeing raw OS errors.
pub fn error_reply(id: Option<&Value>, code: &str) -> Value {
    let mut reply = json!({ "v": 1, "ok": false, "error": code });
    if let Some(id) = id {
        reply["id"] = id.clone();
    }
    reply
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/"))
}

/// Per-user directory that holds the socket and the instance lock.
#[cfg(target_os = "macos")]
pub fn run_dir() -> PathBuf {
    home().join("Library/Application Support/Anon/NetworkGuardSpike/run")
}

#[cfg(target_os = "linux")]
pub fn run_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) => PathBuf::from(dir).join("anon-network-guard-spike"),
        None => home().join(".local/state/anon-network-guard-spike/run"),
    }
}

#[cfg(windows)]
pub fn run_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(home);
    base.join("Anon").join("NetworkGuardSpike")
}

#[cfg(unix)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::GenericFilePath;
    run_dir().join("guard.sock").to_fs_name::<GenericFilePath>()
}

#[cfg(windows)]
pub fn socket_name() -> io::Result<Name<'static>> {
    use interprocess::local_socket::GenericNamespaced;
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "user".into());
    format!("anon-network-guard-spike-{user}").to_ns_name::<GenericNamespaced>()
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
fn prepare_run_dir() -> io::Result<PathBuf> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = run_dir();
    fs::create_dir_all(&dir)?;
    let meta = fs::symlink_metadata(&dir)?;
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "run directory is not ours"));
    }
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    Ok(dir)
}

/// Single instance on Unix is a flock on a lock file, held for the app's lifetime.
/// The socket alone can't be the lock: clearing a stale socket after a crash means
/// unlinking it, and two copies starting together could each unlink the other's.
#[cfg(unix)]
pub fn bind() -> Result<Bound, BindError> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    #[cfg(target_os = "linux")]
    use interprocess::os::unix::local_socket::ListenerOptionsExt;

    let dir = prepare_run_dir()?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(dir.join("guard.lock"))?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(BindError::AlreadyRunning);
    }
    // We hold the lock, so any socket file left behind belongs to a dead instance.
    let path = dir.join("guard.sock");
    match fs::remove_file(&path) {
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
        Err(e) if e.kind() == io::ErrorKind::AddrInUse || e.kind() == io::ErrorKind::PermissionDenied => {
            Err(BindError::AlreadyRunning)
        }
        Err(e) => Err(e.into()),
    }
}

/// Connects to the running app and exchanges the hello. `role` is "shim" or "cli".
pub fn connect(role: &str, origin: &str) -> io::Result<(Stream, Value)> {
    let mut stream = Stream::connect(socket_name()?)?;
    write_json(&mut stream, &json!({ "ipc": IPC_VERSION, "role": role, "origin": origin, "peer": VERSION }))?;
    let hello = read_json(&mut stream)?
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "app closed during hello"))?;
    if hello.get("ipc").and_then(Value::as_u64) != Some(IPC_VERSION) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "ipcVersion"));
    }
    Ok((stream, hello))
}

/// A 36 px monochrome mark (ring and dot) as RGBA. macOS draws it as a template image.
pub fn icon_rgba() -> (Vec<u8>, u32) {
    const S: u32 = 36;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let c = (S as f32 - 1.0) / 2.0;
    for y in 0..S {
        for x in 0..S {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let on = (d >= 12.0 && d <= 16.0) || d <= 6.0;
            if on {
                let i = ((y * S + x) * 4) as usize;
                rgba[i + 3] = 255;
            }
        }
    }
    (rgba, S)
}
