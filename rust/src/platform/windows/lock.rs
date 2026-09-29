//! Same-user advisory lock for connection attempts, as a named mutex in the
//! session's `Local\` namespace. It serializes Chrome surfaces and worker
//! restarts; it is never used as authorization.
use super::trust::wide;
use crate::error::{HelperError, Result};
use crate::router::LockGuard;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0};
use windows_sys::Win32::System::Threading::{CreateMutexW, ReleaseMutex, WaitForSingleObject};

pub struct Mutex(HANDLE);

impl Drop for Mutex {
    fn drop(&mut self) {
        // SAFETY: this thread owns the mutex; the handle is ours.
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

/// Takes `Local\<name>` without waiting. A held mutex is `busy`.
pub fn exclusive<E: Copy>(name: &str, busy: E, unavailable: E) -> std::result::Result<Mutex, E> {
    // SAFETY: NUL-terminated name; the handle is closed by `Mutex` or below.
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide(&format!("Local\\{name}")).as_ptr()) };
    if handle.is_null() {
        return Err(unavailable);
    }
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_OBJECT_0 | WAIT_ABANDONED => Ok(Mutex(handle)),
        _ => {
            unsafe { CloseHandle(handle) };
            Err(busy)
        }
    }
}

/// The router's connection lock.
pub fn connection() -> Result<Option<LockGuard>> {
    exclusive("inc.anon.network_helper.connect", HelperError::ControlBusy, HelperError::ProviderUnavailable)
        .map(|mutex| Some(Box::new(mutex) as LockGuard))
}
