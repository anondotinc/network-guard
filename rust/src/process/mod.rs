//! The only way the helper runs another program. Paths and arguments are
//! compile-time constants chosen by an adapter, never taken from a request.
use std::time::Duration;

#[derive(Clone, Copy)]
pub struct Limits {
    pub timeout: Duration,
    pub output: usize,
}

pub const DEFAULT: Limits = Limits { timeout: Duration::from_secs(3), output: 65536 };

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub use unix::{launch_detached, run};

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{launch_detached, run};
