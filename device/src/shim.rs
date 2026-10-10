//! The host shim's decisions, separated from its I/O so the conformance
//! fixtures can drive it with a fake app.
//!
//! - v9 `appStatus`: answered here, even when the app is down.
//! - v9 `openApp`: starts the app (only ever after a user's click), waits up
//!   to 10 s, then reports it or `appStartFailed`.
//! - Malformed requests: answered here with the router's envelope.
//! - Everything else: relayed to the app byte for byte. When it can't be,
//!   `appStarting` while a launch is in progress, else `appNotRunning`. A
//!   background request never starts the app.
//! - An app that is alive but does not answer its hello within
//!   `ipc::HELLO_TIMEOUT` counts as not running: `appStatus` says so in about
//!   that long, and requests get `appNotRunning` rather than waiting on it.
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::ipc::ConnectError;
use crate::launch::Opened;
use crate::route::{self, AppInfo, Route, V9Method, APP_NOT_RUNNING, APP_STARTING, APP_START_FAILED};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppState {
    Running(String),
    Starting,
    Stopped,
    /// Alive (it took the connection) but it did not answer the hello in time.
    Unresponsive,
}

/// What the shim needs from the world.
pub trait Host {
    /// A fresh check: the app answers a hello now, a launch is in progress, or neither.
    fn app_state(&mut self) -> AppState;
    /// The app's reply to one request frame, or `None` when it can't be reached.
    fn forward(&mut self, frame: &[u8]) -> Option<Vec<u8>>;
    /// Whether an `openApp` launch is in progress (no connection attempt).
    fn launch_in_progress(&mut self) -> bool;
    fn start_at_login(&mut self) -> &'static str;
    /// Starts the app and waits for it (see `launch::open_app`).
    fn open_app(&mut self) -> Opened;
}

pub fn respond(host: &mut impl Host, frame: &[u8], shim_version: &str) -> Vec<u8> {
    match route::route(frame) {
        // Bytes this parser and the installed helper's may read differently
        // (`route::ambiguous`): only the helper can answer them as it does today.
        Route::Reply(bytes) if route::ambiguous(frame) => host.forward(frame).unwrap_or(bytes),
        Route::Reply(bytes) => bytes,
        Route::V9 { id, method: V9Method::AppStatus } => {
            let state = host.app_state();
            route::app_status_reply(&id, &info(host, state), shim_version)
        }
        Route::V9 { id, method: V9Method::OpenApp } => match host.app_state() {
            AppState::Running(version) => route::open_app_reply(&id, &info(host, AppState::Running(version))),
            AppState::Starting => route::v9_failure(&id, APP_STARTING),
            AppState::Stopped | AppState::Unresponsive => match host.open_app() {
                Opened::Running(version) => route::open_app_reply(&id, &info(host, AppState::Running(version))),
                Opened::Starting => route::v9_failure(&id, APP_STARTING),
                Opened::Failed => route::v9_failure(&id, APP_START_FAILED),
            },
        },
        Route::Forward(request) => {
            if let Some(reply) = host.forward(frame) {
                return reply;
            }
            request.failure(if host.launch_in_progress() { APP_STARTING } else { APP_NOT_RUNNING })
        }
    }
}

fn info(host: &mut impl Host, state: AppState) -> AppInfo {
    let (running, version) = match state {
        AppState::Running(version) => (true, Some(version).filter(|v| !v.is_empty())),
        AppState::Starting | AppState::Stopped | AppState::Unresponsive => (false, None),
    };
    AppInfo { running, version, start_at_login: host.start_at_login() }
}

/// `openApp` requests this process has handed to a launch thread that hasn't
/// finished. Set before the thread starts, so a request queued right behind
/// `openApp` on the same port sees `appStarting` even if it is handled before
/// the thread takes the cross-process starting lock.
static LAUNCHES: AtomicUsize = AtomicUsize::new(0);

/// Marks one launch as dispatched until dropped.
pub struct LaunchDispatched(());

impl LaunchDispatched {
    pub fn new() -> Self {
        LAUNCHES.fetch_add(1, Ordering::SeqCst);
        LaunchDispatched(())
    }
}

impl Default for LaunchDispatched {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LaunchDispatched {
    fn drop(&mut self) {
        LAUNCHES.fetch_sub(1, Ordering::SeqCst);
    }
}

/// The real host: the per-user socket, the starting lock and the platform's
/// start-at-login state. Keeps one app connection for a long-lived port.
pub struct LiveHost {
    origin: String,
    conn: Option<interprocess::local_socket::Stream>,
    /// The launch thread's own host: its launch is not "another" one.
    launcher: bool,
}

impl LiveHost {
    pub fn new(origin: &str) -> Self {
        LiveHost { origin: origin.to_string(), conn: None, launcher: false }
    }

    /// For the thread that runs one `openApp`.
    pub fn launcher(origin: &str) -> Self {
        LiveHost { launcher: true, ..Self::new(origin) }
    }
}

impl Host for LiveHost {
    fn app_state(&mut self) -> AppState {
        match crate::ipc::connect("shim", &self.origin) {
            Ok((_, version)) => AppState::Running(version),
            Err(_) if self.launch_in_progress() => AppState::Starting,
            Err(ConnectError::Unresponsive) => AppState::Unresponsive,
            Err(ConnectError::Unreachable(_)) => AppState::Stopped,
        }
    }

    /// A kept connection may lead to an app that has since quit or restarted:
    /// when it turns out closed, one fresh connection is tried. A deadline that
    /// passed means the app is hung, and asking again would only wait again.
    fn forward(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        if let Some(mut stream) = self.conn.take() {
            match crate::ipc::exchange(&mut stream, frame) {
                Ok(reply) => {
                    self.conn = Some(stream);
                    return Some(reply);
                }
                Err(e) if crate::ipc::timed_out(&e) => return None,
                Err(_) => {}
            }
        }
        let (mut stream, _) = crate::ipc::connect("shim", &self.origin).ok()?;
        let reply = crate::ipc::exchange(&mut stream, frame).ok()?;
        self.conn = Some(stream);
        Some(reply)
    }

    fn launch_in_progress(&mut self) -> bool {
        (!self.launcher && LAUNCHES.load(Ordering::SeqCst) > 0) || crate::launch::StartingLock::held_elsewhere()
    }

    fn start_at_login(&mut self) -> &'static str {
        crate::login::status()
    }

    fn open_app(&mut self) -> Opened {
        crate::launch::open_app(&self.origin)
    }
}
