//! The only way the helper runs another program. Paths and arguments are
//! compile-time constants chosen by an adapter, never taken from a request.
use crate::error::{HelperError, Result};
use std::ffi::OsString;
use std::io::{ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct Limits {
    pub timeout: Duration,
    pub output: usize,
}

pub const DEFAULT: Limits = Limits { timeout: Duration::from_secs(3), output: 65536 };

/// Runs a program with no shell, a fixed environment, stdin from /dev/null and
/// stderr discarded. Returns stdout only when it exits 0 within the deadline and
/// the output fits. A timeout kills the whole process group and is an uncertain
/// result, not proof that nothing happened.
pub fn run(path: &str, args: &[&str], limits: Limits) -> Result<Vec<u8>> {
    let mut child = Command::new(path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .map_err(|_| HelperError::ProviderUnavailable)?;
    let result = collect(&mut child, limits);
    if result.is_err() {
        kill_group(&child);
    }
    let _ = child.wait();
    result
}

fn kill_group(child: &Child) {
    // SAFETY: plain signal to the group this function created; no memory involved.
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
    }
}

fn collect(child: &mut Child, limits: Limits) -> Result<Vec<u8>> {
    let deadline = Instant::now() + limits.timeout;
    let mut stdout = child.stdout.take().ok_or(HelperError::ProviderUnavailable)?;
    let fd = stdout.as_raw_fd();
    // SAFETY: fcntl on a descriptor this function owns.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(HelperError::ProviderUnavailable);
        }
    }
    let mut output = Vec::new();
    let mut buffer = [0u8; 4096];
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(HelperError::ProviderTimeout);
        }
        let wait = (deadline - now).min(Duration::from_millis(50)).as_millis() as libc::c_int;
        let mut descriptor = libc::pollfd { fd, events: libc::POLLIN | libc::POLLHUP, revents: 0 };
        // SAFETY: one valid pollfd for the duration of the call.
        let ready = unsafe { libc::poll(&mut descriptor, 1, wait.max(1)) };
        if ready < 0 {
            if std::io::Error::last_os_error().kind() == ErrorKind::Interrupted {
                continue;
            }
            return Err(HelperError::ProviderUnavailable);
        }
        if ready == 0 {
            continue;
        }
        if descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            return Err(HelperError::ProviderUnavailable);
        }
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(count) => {
                if output.len() + count > limits.output {
                    return Err(HelperError::OversizedOutput);
                }
                output.extend_from_slice(&buffer[..count]);
            }
            Err(error) if matches!(error.kind(), ErrorKind::Interrupted | ErrorKind::WouldBlock) => continue,
            Err(_) => return Err(HelperError::ProviderUnavailable),
        }
    }
    // A process can close stdout and still hang. Keep to the same deadline.
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(output),
            Ok(Some(_)) | Err(_) => return Err(HelperError::ProviderUnavailable),
            Ok(None) if Instant::now() >= deadline => return Err(HelperError::ProviderTimeout),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// Variables a desktop app needs to find the user's session. Only used to open
/// a provider's own app, never for status or connect commands.
const SESSION_ENVIRONMENT: [&str; 10] = [
    "HOME",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_DIRS",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
];

/// Starts a provider's desktop app in its own session so it outlives the
/// helper. Success means the program started, not that a tunnel connected.
pub fn launch_detached(path: &str, args: &[&str]) -> Result<()> {
    let environment: Vec<(&str, OsString)> =
        SESSION_ENVIRONMENT.iter().filter_map(|key| std::env::var_os(key).map(|value| (*key, value))).collect();
    let mut command = Command::new(path);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .envs(environment)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // SAFETY: setsid is async-signal-safe and touches no Rust state.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    command.spawn().map(drop).map_err(|_| HelperError::ProviderUnavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits(timeout_ms: u64, output: usize) -> Limits {
        Limits { timeout: Duration::from_millis(timeout_ms), output }
    }

    #[test]
    fn returns_stdout_on_success_only() {
        assert_eq!(run("/usr/bin/printf", &["synthetic-output"], DEFAULT).unwrap(), b"synthetic-output");
        assert_eq!(run("/usr/bin/false", &[], DEFAULT), Err(HelperError::ProviderUnavailable));
        assert_eq!(run("/nonexistent/provider", &[], DEFAULT), Err(HelperError::ProviderUnavailable));
    }

    #[test]
    fn child_gets_a_fixed_environment() {
        std::env::set_var("NETWORK_GUARD_SECRET", "must-not-leak");
        let output = String::from_utf8(run("/usr/bin/env", &[], DEFAULT).unwrap()).unwrap();
        let mut lines: Vec<&str> = output.lines().collect();
        lines.sort();
        assert_eq!(lines, ["LANG=C.UTF-8", "PATH=/usr/bin:/bin"]);
    }

    #[test]
    fn deadline_and_output_cap() {
        let start = Instant::now();
        assert_eq!(run("/bin/sleep", &["5"], limits(100, 65536)), Err(HelperError::ProviderTimeout));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(run("/usr/bin/yes", &["synthetic"], limits(3000, 1024)), Err(HelperError::OversizedOutput));
    }

    #[test]
    fn timeout_kills_the_whole_group() {
        // The shell's background child keeps stdout open; both must die.
        let marker = std::env::temp_dir().join(format!("network-guard-group-{}", std::process::id()));
        let script = format!("(sleep 1; echo alive > {}) & sleep 5", marker.display());
        assert_eq!(run("/bin/sh", &["-c", &script], limits(200, 65536)), Err(HelperError::ProviderTimeout));
        std::thread::sleep(Duration::from_millis(1500));
        assert!(!marker.exists(), "a grandchild outlived the timeout");
    }
}
