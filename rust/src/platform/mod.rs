//! OS-specific halves: trust, locks, adapters and installation paths.
#[cfg(target_os = "linux")]
pub mod linux;
