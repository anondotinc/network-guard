//! Anon Network Guard for Linux and Windows. The wire protocol and security
//! rules match the Swift helper exactly; `conformance/` is the shared contract.
pub mod build_info;
pub mod error;
pub mod frames;
pub mod manifest;
pub mod origin;
pub mod provider;
pub mod router;
pub mod status;
pub mod wire;

#[cfg(unix)]
pub mod process;

pub mod platform;

#[cfg(target_os = "linux")]
pub mod setup;
