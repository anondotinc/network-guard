//! Same-user advisory lock for connection attempts. It serializes Chrome
//! surfaces and worker restarts; it is never used as authorization.
use crate::error::{HelperError, Result};
use std::ffi::CString;
use std::fs::File;
use std::os::fd::{AsRawFd, FromRawFd};

/// `$XDG_RUNTIME_DIR`, else `/run/user/<uid>`: a real directory owned by this
/// user with no group or world access. Shared `/tmp` is never used.
pub fn runtime_dir() -> Result<String> {
    // SAFETY: getuid has no failure mode.
    let uid = unsafe { libc::getuid() };
    let candidates = [std::env::var("XDG_RUNTIME_DIR").ok(), Some(format!("/run/user/{uid}"))];
    for candidate in candidates.into_iter().flatten() {
        if !candidate.starts_with('/') {
            continue;
        }
        let Ok(path) = CString::new(candidate.as_str()) else { continue };
        let mut info: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: valid C string and stat buffer.
        if unsafe { libc::lstat(path.as_ptr(), &mut info) } == 0
            && info.st_mode & libc::S_IFMT == libc::S_IFDIR
            && info.st_uid == uid
            && info.st_mode & 0o077 == 0
        {
            return Ok(candidate.trim_end_matches('/').to_string());
        }
    }
    Err(HelperError::ProviderUnavailable)
}

/// Opens `<directory>/<name>` without following links and takes an exclusive
/// non-blocking lock. A held lock is `busy`.
pub fn exclusive<E: Copy>(directory: &str, name: &str, busy: E, unavailable: E) -> std::result::Result<File, E> {
    let path = CString::new(format!("{directory}/{name}")).map_err(|_| unavailable)?;
    // SAFETY: valid C string; the descriptor is owned by the File below.
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_CREAT | libc::O_RDWR | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600 as libc::c_uint) };
    if fd < 0 {
        return Err(unavailable);
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: fstat/flock on the descriptor owned by `file`.
    let ok = unsafe {
        libc::fstat(file.as_raw_fd(), &mut info) == 0
            && info.st_uid == libc::getuid()
            && info.st_mode & libc::S_IFMT == libc::S_IFREG
            && info.st_mode & 0o077 == 0
            && libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0
    };
    if ok {
        Ok(file)
    } else {
        Err(busy)
    }
}

/// The router's connection lock. Released when the file closes.
pub fn connection() -> Result<Option<crate::router::LockGuard>> {
    let directory = runtime_dir()?;
    exclusive(&directory, "inc.anon.network_helper.connect.lock", HelperError::ControlBusy, HelperError::ProviderUnavailable)
        .map(|file| Some(Box::new(file) as crate::router::LockGuard))
}
