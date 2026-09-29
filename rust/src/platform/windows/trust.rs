//! A provider program is trusted when it sits at a fixed path under Program
//! Files that only administrators can change, carries a valid Authenticode
//! signature from a pinned publisher, and has a pinned file version.
use crate::error::{HelperError, Result};
use std::ffi::{c_void, OsString};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::ptr::null_mut;
use windows_sys::core::{GUID, PWSTR};
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE};
use windows_sys::Win32::Security::Authorization::{ConvertSidToStringSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT};
use windows_sys::Win32::Security::Cryptography::{
    CertGetCertificateContextProperty, CertGetNameStringW, CERT_CONTEXT, CERT_NAME_ATTR_TYPE, CERT_SHA256_HASH_PROP_ID,
};
use windows_sys::Win32::Security::WinTrust::{
    WTHelperGetProvSignerFromChain, WTHelperProvDataFromStateData, WinVerifyTrust, WINTRUST_ACTION_GENERIC_VERIFY_V2, WINTRUST_DATA,
    WINTRUST_FILE_INFO, WTD_CACHE_ONLY_URL_RETRIEVAL, WTD_CHOICE_FILE, WTD_REVOCATION_CHECK_NONE, WTD_REVOKE_NONE, WTD_STATEACTION_CLOSE,
    WTD_STATEACTION_VERIFY, WTD_UI_NONE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetAce, GetTokenInformation, IsWellKnownSid, TokenUser, WinAuthenticatedUserSid, WinBuiltinAdministratorsSid,
    WinBuiltinUsersSid, WinInteractiveSid, WinLocalSystemSid, WinWorldSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileAttributesW, GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, INVALID_FILE_ATTRIBUTES, VS_FIXEDFILEINFO,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, FOLDERID_ProgramFiles, SHGetKnownFolderPath};

/// `Snapshot.installation` for a file verified this way.
pub const INSTALLATION: &str = "verified-authenticode";

const TRUSTED_INSTALLER: &str = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
// FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_DELETE_CHILD | DELETE | WRITE_DAC | WRITE_OWNER | GENERIC_ALL | GENERIC_WRITE
const WRITE_ACCESS: u32 = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x1000_0000 | 0x4000_0000;
const INHERIT_ONLY_ACE: u8 = 0x08;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

pub(crate) fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

fn known_folder(id: &GUID) -> Result<String> {
    let mut path: PWSTR = null_mut();
    // SAFETY: on success the shell allocates `path`, which is freed below.
    let status = unsafe { SHGetKnownFolderPath(id, 0, null_mut(), &mut path) };
    let result = if status == 0 && !path.is_null() {
        let length = (0..).take_while(|&i| unsafe { *path.add(i) } != 0).count();
        OsString::from_wide(unsafe { std::slice::from_raw_parts(path, length) }).into_string().map_err(|_| HelperError::ProviderUnavailable)
    } else {
        Err(HelperError::ProviderUnavailable)
    };
    unsafe { CoTaskMemFree(path as *const c_void) };
    result
}

/// `C:\Program Files` for this (64-bit) process, from the shell, not the environment.
pub fn program_files() -> Result<String> {
    known_folder(&FOLDERID_ProgramFiles)
}

/// The user's `%LOCALAPPDATA%`, from the shell.
pub fn local_app_data() -> Result<String> {
    known_folder(&FOLDERID_LocalAppData)
}

fn attributes(path: &str) -> Option<u32> {
    // SAFETY: NUL-terminated wide string.
    let value = unsafe { GetFileAttributesW(wide(path).as_ptr()) };
    (value != INVALID_FILE_ATTRIBUTES).then_some(value)
}

struct Descriptor(PSECURITY_DESCRIPTOR);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0 as _) };
    }
}

fn sid_string(sid: PSID) -> Option<String> {
    let mut text: PWSTR = null_mut();
    // SAFETY: on success the system allocates `text`, freed below.
    if unsafe { ConvertSidToStringSidW(sid, &mut text) } == 0 {
        return None;
    }
    let length = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let value = OsString::from_wide(unsafe { std::slice::from_raw_parts(text, length) }).into_string().ok();
    unsafe { LocalFree(text as _) };
    value
}

/// The SID of the user running the helper, as a byte copy.
fn current_user_sid() -> Option<Vec<u8>> {
    let mut token: HANDLE = null_mut();
    // SAFETY: token handle closed below; buffers sized by the first call.
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return None;
        }
        let mut size = 0u32;
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
        let mut buffer = vec![0u8; size as usize];
        let ok = GetTokenInformation(token, TokenUser, buffer.as_mut_ptr() as *mut c_void, size, &mut size) != 0;
        CloseHandle(token);
        ok.then_some(buffer)
    }
}

/// Owned by Administrators, SYSTEM or TrustedInstaller, and no allow entry
/// grants write, delete or permission changes to everyone, users, or the
/// current user.
fn admin_only(path: &str, user: &[u8]) -> Result<()> {
    let mut owner: PSID = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: out-pointers point into `descriptor`, which is freed by `Descriptor`.
    let status = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS || descriptor.is_null() {
        return Err(HelperError::UntrustedInstallation);
    }
    let _descriptor = Descriptor(descriptor);
    // A null DACL grants everyone full access.
    if owner.is_null() || dacl.is_null() {
        return Err(HelperError::UntrustedInstallation);
    }
    let trusted_owner = unsafe { IsWellKnownSid(owner, WinBuiltinAdministratorsSid) != 0 || IsWellKnownSid(owner, WinLocalSystemSid) != 0 }
        || sid_string(owner).as_deref() == Some(TRUSTED_INSTALLER);
    if !trusted_owner {
        return Err(HelperError::UntrustedInstallation);
    }
    let count = unsafe { (*dacl).AceCount };
    for index in 0..count as u32 {
        let mut ace: *mut c_void = null_mut();
        // SAFETY: index is below AceCount; the ACE lives inside the descriptor.
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
            return Err(HelperError::UntrustedInstallation);
        }
        let header = unsafe { &*(ace as *const ACE_HEADER) };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE || header.AceFlags & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        let allowed = unsafe { &*(ace as *const ACCESS_ALLOWED_ACE) };
        if allowed.Mask & WRITE_ACCESS == 0 {
            continue;
        }
        let sid = &allowed.SidStart as *const u32 as PSID;
        let low_privilege = unsafe {
            IsWellKnownSid(sid, WinWorldSid) != 0
                || IsWellKnownSid(sid, WinAuthenticatedUserSid) != 0
                || IsWellKnownSid(sid, WinBuiltinUsersSid) != 0
                || IsWellKnownSid(sid, WinInteractiveSid) != 0
                || EqualSid(sid, (*(user.as_ptr() as *const TOKEN_USER)).User.Sid) != 0
        };
        if low_privilege {
            return Err(HelperError::UntrustedInstallation);
        }
    }
    Ok(())
}

/// `relative` under Program Files: every component exists, none is a reparse
/// point, the last is a file, and each is admin-only. Missing is `NotInstalled`.
pub fn admin_owned(relative: &str) -> Result<String> {
    let root = program_files()?;
    if relative.is_empty() || relative.contains('/') || relative.split('\\').any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(HelperError::UntrustedInstallation);
    }
    let user = current_user_sid().ok_or(HelperError::UntrustedInstallation)?;
    let components: Vec<&str> = relative.split('\\').collect();
    let mut path = root.clone();
    for (index, component) in std::iter::once("").chain(components.iter().copied()).enumerate() {
        if index > 0 {
            path.push('\\');
            path.push_str(component);
        }
        let Some(value) = attributes(&path) else { return Err(HelperError::NotInstalled) };
        let last = index == components.len();
        if value & FILE_ATTRIBUTE_REPARSE_POINT != 0 || (value & FILE_ATTRIBUTE_DIRECTORY != 0) == last {
            return Err(HelperError::UntrustedInstallation);
        }
        admin_only(&path, &user)?;
    }
    Ok(path)
}

/// The leaf signer of a valid Authenticode signature.
#[derive(Debug, PartialEq, Eq)]
pub struct Signer {
    pub organization: String,
    pub common_name: String,
    pub sha256: String,
}

fn name(cert: *const CERT_CONTEXT, oid: &[u8]) -> String {
    let mut buffer = [0u16; 512];
    // SAFETY: `oid` is NUL-terminated ASCII; buffer length matches.
    let length = unsafe {
        CertGetNameStringW(cert, CERT_NAME_ATTR_TYPE, 0, oid.as_ptr() as *const c_void, buffer.as_mut_ptr(), buffer.len() as u32)
    };
    OsString::from_wide(&buffer[..(length as usize).saturating_sub(1)]).to_string_lossy().into_owned()
}

/// Verifies the embedded signature without any network access (no revocation
/// fetch, cached URLs only) and returns the leaf signer.
pub fn authenticode(path: &str) -> Result<Signer> {
    let file = wide(path);
    let mut info = WINTRUST_FILE_INFO {
        cbStruct: std::mem::size_of::<WINTRUST_FILE_INFO>() as u32,
        pcwszFilePath: file.as_ptr(),
        hFile: null_mut(),
        pgKnownSubject: null_mut(),
    };
    let mut data: WINTRUST_DATA = unsafe { std::mem::zeroed() };
    data.cbStruct = std::mem::size_of::<WINTRUST_DATA>() as u32;
    data.dwUIChoice = WTD_UI_NONE;
    data.fdwRevocationChecks = WTD_REVOKE_NONE;
    data.dwUnionChoice = WTD_CHOICE_FILE;
    data.Anonymous.pFile = &mut info;
    data.dwStateAction = WTD_STATEACTION_VERIFY;
    data.dwProvFlags = WTD_CACHE_ONLY_URL_RETRIEVAL | WTD_REVOCATION_CHECK_NONE;
    let mut action = WINTRUST_ACTION_GENERIC_VERIFY_V2;
    // SAFETY: all structures outlive both calls; state is closed below.
    let status = unsafe { WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void) };
    let signer = (|| {
        if status != 0 {
            return Err(HelperError::UntrustedInstallation);
        }
        unsafe {
            let provider = WTHelperProvDataFromStateData(data.hWVTStateData);
            let signer = if provider.is_null() { null_mut() } else { WTHelperGetProvSignerFromChain(provider, 0, 0, 0) };
            if signer.is_null() || (*signer).csCertChain == 0 || (*signer).pasCertChain.is_null() {
                return Err(HelperError::UntrustedInstallation);
            }
            let cert = (*(*signer).pasCertChain).pCert;
            let mut hash = [0u8; 32];
            let mut size = hash.len() as u32;
            if CertGetCertificateContextProperty(cert, CERT_SHA256_HASH_PROP_ID, hash.as_mut_ptr() as *mut c_void, &mut size) == 0
                || size != 32
            {
                return Err(HelperError::UntrustedInstallation);
            }
            Ok(Signer {
                organization: name(cert, b"2.5.4.10\0"),
                common_name: name(cert, b"2.5.4.3\0"),
                sha256: hash.iter().map(|byte| format!("{byte:02x}")).collect(),
            })
        }
    })();
    data.dwStateAction = WTD_STATEACTION_CLOSE;
    unsafe { WinVerifyTrust(null_mut(), &mut action, &mut data as *mut _ as *mut c_void) };
    signer
}

/// `major.minor.build.revision` from the fixed file version resource.
pub fn file_version(path: &str) -> Result<String> {
    let file = wide(path);
    let mut ignored = 0u32;
    // SAFETY: buffer sized by the first call; VerQueryValueW points into it.
    unsafe {
        let size = GetFileVersionInfoSizeW(file.as_ptr(), &mut ignored);
        if size == 0 {
            return Err(HelperError::UnsupportedProviderVersion);
        }
        let mut buffer = vec![0u8; size as usize];
        if GetFileVersionInfoW(file.as_ptr(), 0, size, buffer.as_mut_ptr() as *mut c_void) == 0 {
            return Err(HelperError::UnsupportedProviderVersion);
        }
        let mut fixed: *mut c_void = null_mut();
        let mut length = 0u32;
        let root = wide("\\");
        if VerQueryValueW(buffer.as_ptr() as *const c_void, root.as_ptr(), &mut fixed, &mut length) == 0
            || fixed.is_null()
            || (length as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
        {
            return Err(HelperError::UnsupportedProviderVersion);
        }
        let info = &*(fixed as *const VS_FIXEDFILEINFO);
        if info.dwSignature != 0xFEEF04BD {
            return Err(HelperError::UnsupportedProviderVersion);
        }
        Ok(format!(
            "{}.{}.{}.{}",
            info.dwFileVersionMS >> 16,
            info.dwFileVersionMS & 0xffff,
            info.dwFileVersionLS >> 16,
            info.dwFileVersionLS & 0xffff
        ))
    }
}

/// A vendor file under Program Files and the publisher that must have signed it.
pub struct Signed {
    /// Relative to Program Files, backslash-separated.
    pub path: &'static str,
    pub organization: &'static str,
    pub common_name: &'static str,
}

/// Verifies location, permissions and signature for every file. With
/// `version = (index, pins)`, file `index`'s fixed file version must be one of
/// the pins (file version → reported version). Vendors don't always stamp the
/// CLI: Mullvad's reads 0.0.0.0 and IVPN's has no version resource, so pins
/// come from the app executable signed alongside it.
/// Returns the first file's full path and the matched reported version.
pub fn verify(files: &[Signed], version: Option<(usize, &[(&str, &'static str)])>) -> Result<(String, Option<&'static str>)> {
    let mut paths = Vec::with_capacity(files.len());
    for file in files {
        let path = admin_owned(file.path)?;
        let signer = authenticode(&path)?;
        if signer.organization != file.organization || signer.common_name != file.common_name {
            return Err(HelperError::UntrustedInstallation);
        }
        paths.push(path);
    }
    let first = paths.first().cloned().ok_or(HelperError::NotInstalled)?;
    let reported = match version {
        None => None,
        Some((index, pins)) => {
            let installed = file_version(paths.get(index).ok_or(HelperError::UnsupportedProviderVersion)?)?;
            Some(
                pins.iter()
                    .find(|(file, _)| *file == installed)
                    .map(|(_, reported)| *reported)
                    .ok_or(HelperError::UnsupportedProviderVersion)?,
            )
        }
    };
    Ok((first, reported))
}
