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
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::launch::Opened;
use crate::route::{self, AppInfo, Route, V9Method, APP_NOT_RUNNING, APP_STARTING, APP_START_FAILED};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppState {
    Running(String),
    Starting,
    Stopped,
}

/// What the shim needs from the world.
pub trait Host {
    /// A fresh check: the app answers a hello now, a launch is in progress, or neither.
    fn app_state(&mut self) -> AppState;
    /// The app's reply to one request frame, or `None` when it can't be reached.
    fn forward(&mut self, frame: &[u8]) -> Option<Vec<u8>>;
    fn start_at_login(&mut self) -> &'static str;
    /// Starts the app and waits for it (see `launch::open_app`).
    fn open_app(&mut self) -> Opened;
}

pub fn respond(host: &mut impl Host, frame: &[u8], shim_version: &str) -> Vec<u8> {
    match route::route(frame) {
        Route::Reply(bytes) => bytes,
        Route::V9 { id, method: V9Method::AppStatus } => {
            let state = host.app_state();
            route::app_status_reply(&id, &info(host, state), shim_version)
        }
        Route::V9 { id, method: V9Method::OpenApp } => match host.app_state() {
            AppState::Running(version) => route::open_app_reply(&id, &info(host, AppState::Running(version))),
            AppState::Starting => route::v9_failure(&id, APP_STARTING),
            AppState::Stopped => match host.open_app() {
                Opened::Running(version) => route::open_app_reply(&id, &info(host, AppState::Running(version))),
                Opened::Starting => route::v9_failure(&id, APP_STARTING),
                Opened::Failed => route::v9_failure(&id, APP_START_FAILED),
            },
        },
        Route::Forward(request) => {
            if let Some(reply) = host.forward(frame) {
                return reply;
            }
            match host.app_state() {
                AppState::Starting => request.failure(APP_STARTING),
                _ => request.failure(APP_NOT_RUNNING),
            }
        }
    }
}

fn info(host: &mut impl Host, state: AppState) -> AppInfo {
    let (running, version) = match state {
        AppState::Running(version) => (true, Some(version).filter(|v| !v.is_empty())),
        AppState::Starting | AppState::Stopped => (false, None),
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

    fn launch_in_progress(&self) -> bool {
        (!self.launcher && LAUNCHES.load(Ordering::SeqCst) > 0) || crate::launch::StartingLock::held_elsewhere()
    }
}

impl Host for LiveHost {
    fn app_state(&mut self) -> AppState {
        match crate::ipc::connect("shim", &self.origin) {
            Ok((_, version)) => AppState::Running(version),
            Err(_) if self.launch_in_progress() => AppState::Starting,
            Err(_) => AppState::Stopped,
        }
    }

    /// One retry covers an app that restarted between two messages on a long-lived port.
    fn forward(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        for _ in 0..2 {
            if self.conn.is_none() {
                self.conn = crate::ipc::connect("shim", &self.origin).ok().map(|(stream, _)| stream);
            }
            let stream = self.conn.as_mut()?;
            match crate::ipc::exchange(stream, frame) {
                Ok(reply) => return Some(reply),
                Err(_) => self.conn = None,
            }
        }
        None
    }

    fn start_at_login(&mut self) -> &'static str {
        crate::login::status()
    }

    fn open_app(&mut self) -> Opened {
        crate::launch::open_app(&self.origin)
    }
}
