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

#[cfg(any(unix, windows))]
pub mod process;

pub mod platform;

#[cfg(any(target_os = "linux", windows))]
pub mod setup;
