//! Anon Network Guard device app: one per user, with a tray icon, a start-at-login
//! item and a per-user socket, plus the Chrome host shim that Chrome starts.
//!
//! - `anon-guard` (the app) answers wallet requests v1–v8. In bridge mode it
//!   delegates each one to the installed helper exactly as Chrome would and
//!   relays the reply bytes unchanged ([`bridge`]).
//! - `anon-guard-host` (the shim) is the native-messaging host. It answers v9
//!   (`appStatus`, `openApp`) itself, relays everything else to the app, and
//!   answers `appNotRunning` / `appStarting` when it can't ([`shim`]).
//!
//! The wire contract is CONTRACTS.md "Device Guard v9"; the shim's replies are
//! pinned by `conformance/shim.json`.
pub mod bridge;
pub mod identity;
pub mod ipc;
pub mod launch;
pub mod login;
pub mod route;
pub mod shim;

pub use network_guard::build_info::{CHANNEL, EXTENSION_ID, HOST_NAME, VERSION};
