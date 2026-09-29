//! Windows runner: no shell, no console window, a minimal system environment,
//! and a kill-on-close Job Object so a timeout ends the whole process tree.
use super::Limits;
use crate::error::{HelperError, Result};
use std::ffi::OsString;
use std::io::Read;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::SystemInformation::GetSystemWindowsDirectoryW;
use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS};

/// `C:\Windows` from the system, not from the (caller-influenced) environment.
pub fn windows_directory() -> Result<String> {
    let mut buffer = [0u16; 260];
    // SAFETY: the buffer and its length describe valid writable memory.
    let length = unsafe { GetSystemWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err(HelperError::ProviderUnavailable);
    }
    OsString::from_wide(&buffer[..length]).into_string().map_err(|_| HelperError::ProviderUnavailable)
}

fn system_environment() -> Result<Vec<(&'static str, String)>> {
    let windows = windows_directory()?;
    let drive = windows.get(..2).unwrap_or("C:").to_string();
    Ok(vec![
        ("SystemRoot", windows.clone()),
        ("windir", windows.clone()),
        ("SystemDrive", drive),
        ("PATH", format!("{windows}\\System32;{windows}")),
    ])
}

struct Job(HANDLE);

impl Job {
    fn new() -> Result<Job> {
        // SAFETY: plain object creation; the handle is owned by `Job` and closed on drop.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(HelperError::ProviderUnavailable);
        }
        let job = Job(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: the struct matches the information class and outlives the call.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(HelperError::ProviderUnavailable);
        }
        Ok(job)
    }
    fn terminate(&self) {
        // SAFETY: the job handle is valid for the lifetime of `self`.
        unsafe { TerminateJobObject(self.0, 1) };
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last handle kills anything still in the job.
        unsafe { CloseHandle(self.0) };
    }
}

/// Runs a program with no shell and no console, stdin from NUL and stderr
/// discarded. Returns stdout only when it exits 0 within the deadline and the
/// output fits. A timeout kills the job and is an uncertain result.
pub fn run(path: &str, args: &[&str], limits: Limits) -> Result<Vec<u8>> {
    let deadline = Instant::now() + limits.timeout;
    let job = Job::new()?;
    let mut child = Command::new(path)
        .args(args)
        .env_clear()
        .envs(system_environment()?)
        .current_dir(windows_directory()?)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|_| HelperError::ProviderUnavailable)?;
    // SAFETY: both handles are valid; the child handle is owned by `child`.
    if unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) } == 0 {
        let _ = child.kill();
        let _ = child.wait();
        return Err(HelperError::ProviderUnavailable);
    }
    let mut stdout = child.stdout.take().ok_or(HelperError::ProviderUnavailable)?;
    let cap = limits.output;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 4096];
        let result = loop {
            match stdout.read(&mut buffer) {
                Ok(0) => break Ok(output),
                Ok(count) if output.len() + count > cap => break Err(HelperError::OversizedOutput),
                Ok(count) => output.extend_from_slice(&buffer[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break Err(HelperError::ProviderUnavailable),
            }
        };
        let _ = sender.send(result);
    });
    let remaining = deadline.saturating_duration_since(Instant::now());
    let output = match receiver.recv_timeout(remaining) {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => {
            job.terminate();
            let _ = child.wait();
            return Err(error);
        }
        Err(_) => {
            job.terminate();
            let _ = child.wait();
            return Err(HelperError::ProviderTimeout);
        }
    };
    // A process can close stdout and still hang. Keep to the same deadline.
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(output),
            Ok(Some(_)) | Err(_) => return Err(HelperError::ProviderUnavailable),
            Ok(None) if Instant::now() >= deadline => {
                job.terminate();
                let _ = child.wait();
                return Err(HelperError::ProviderTimeout);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// Variables a desktop app needs to find the user's profile. Only used to open
/// a provider's own app, never for status or connect commands.
const SESSION_ENVIRONMENT: [&str; 12] = [
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERNAME",
    "USERDOMAIN",
    "PROGRAMDATA",
    "ProgramFiles",
    "ProgramW6432",
];

/// Starts a provider's desktop app detached from the helper, and outside
/// Chrome's job where the job allows it, so it outlives the host. Success means
/// the program started, not that a tunnel connected.
pub fn launch_detached(path: &str, args: &[&str]) -> Result<()> {
    let mut environment: Vec<(String, OsString)> = system_environment()?.into_iter().map(|(k, v)| (k.to_string(), v.into())).collect();
    environment.extend(SESSION_ENVIRONMENT.iter().filter_map(|key| std::env::var_os(key).map(|value| (key.to_string(), value))));
    let launch = |flags: u32| {
        Command::new(path)
            .args(args)
            .env_clear()
            .envs(environment.iter().map(|(k, v)| (k, v)))
            .current_dir(Path::new(path).parent().unwrap_or(Path::new("C:\\")))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    launch(base | CREATE_BREAKAWAY_FROM_JOB).or_else(|_| launch(base)).map(drop).map_err(|_| HelperError::ProviderUnavailable)
}

use std::path::Path;
