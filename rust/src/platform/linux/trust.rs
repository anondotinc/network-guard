//! Linux has no code signatures for installed apps. A provider file is trusted
//! when it sits at a fixed path that only root can change, and the system
//! package database says the vendor's package installed it at a pinned version.
use crate::error::{HelperError, Result};
use crate::process::{self, Limits};
use std::ffi::CString;
use std::time::Duration;

/// `Snapshot.installation` for a file verified this way.
pub const INSTALLATION: &str = "verified-system-package";

const QUERY: Limits = Limits { timeout: Duration::from_secs(5), output: 16384 };
const DPKG_QUERY: &str = "/usr/bin/dpkg-query";
const DPKG_STATUS: &str = "/var/lib/dpkg/status";
const RPM: &str = "/usr/bin/rpm";

fn lstat(path: &str) -> Option<libc::stat> {
    let path = CString::new(path).ok()?;
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: valid C string and a zeroed stat buffer owned by this frame.
    (unsafe { libc::lstat(path.as_ptr(), &mut info) } == 0).then_some(info)
}

/// The path and every ancestor are real (no symlinks), owned by root and not
/// group- or world-writable. Missing is `NotInstalled`; anything else untrusted.
pub fn root_owned(path: &str, executable: bool) -> Result<()> {
    if !path.starts_with('/') || path.contains("/../") || path.contains("/./") || path.ends_with('/') {
        return Err(HelperError::UntrustedInstallation);
    }
    let mut prefix = String::new();
    let components: Vec<&str> = path.split('/').skip(1).collect();
    for (index, component) in std::iter::once("").chain(components.iter().copied()).enumerate() {
        if index > 0 {
            prefix.push('/');
            prefix.push_str(component);
        }
        let current = if prefix.is_empty() { "/" } else { prefix.as_str() };
        let Some(info) = lstat(current) else {
            return Err(match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOENT) | Some(libc::ENOTDIR) => HelperError::NotInstalled,
                _ => HelperError::UntrustedInstallation,
            });
        };
        let kind = info.st_mode & libc::S_IFMT;
        let last = index == components.len();
        let expected = if last { libc::S_IFREG } else { libc::S_IFDIR };
        if kind != expected || info.st_uid != 0 || info.st_mode & 0o022 != 0 {
            return Err(HelperError::UntrustedInstallation);
        }
        if last && executable && info.st_mode & 0o111 == 0 {
            return Err(HelperError::UntrustedInstallation);
        }
    }
    Ok(())
}

enum Database {
    Dpkg,
    Rpm,
}

fn database() -> Result<Database> {
    if root_owned(DPKG_QUERY, true).is_ok() && root_owned(DPKG_STATUS, false).is_ok() {
        return Ok(Database::Dpkg);
    }
    if root_owned(RPM, true).is_ok() {
        return Ok(Database::Rpm);
    }
    Err(HelperError::UntrustedInstallation)
}

fn query(program: &str, args: &[&str]) -> Result<String> {
    let output = process::run(program, args, QUERY).map_err(|error| match error {
        HelperError::ProviderTimeout => HelperError::ProviderTimeout,
        _ => HelperError::UntrustedInstallation,
    })?;
    String::from_utf8(output).map_err(|_| HelperError::UntrustedInstallation)
}

/// Exactly one owner, and it is `package`. Diversions and shared files fail.
fn owner_matches(database: &Database, path: &str, package: &str) -> Result<bool> {
    Ok(match database {
        Database::Dpkg => query(DPKG_QUERY, &["-S", path])?.lines().collect::<Vec<_>>() == [format!("{package}: {path}")],
        Database::Rpm => query(RPM, &["-qf", "--queryformat", "%{NAME}\\n", path])?.lines().collect::<Vec<_>>() == [package],
    })
}

/// The installed package version, only when the package is fully installed.
/// Both tools exit non-zero for a package that isn't installed.
fn installed_version(database: &Database, package: &str) -> Result<String> {
    let text = match database {
        Database::Dpkg => query(DPKG_QUERY, &["-W", "-f=${db:Status-Status} ${Version}\\n", package]),
        Database::Rpm => query(RPM, &["-q", "--queryformat", "installed %{VERSION}\\n", package]),
    }
    .map_err(|error| if error == HelperError::ProviderTimeout { error } else { HelperError::NotInstalled })?;
    let mut lines = text.lines();
    match (lines.next().and_then(|line| line.strip_prefix("installed ")), lines.next()) {
        (Some(version), None) if !version.is_empty() && version.len() <= 64 => Ok(version.to_string()),
        _ => Err(HelperError::NotInstalled),
    }
}

/// A file shipped by a vendor package.
pub struct Packaged {
    pub path: &'static str,
    pub package: &'static str,
    pub executable: bool,
}

/// Verifies the files and their package ownership. With `versions`, the
/// installed package must be one of them, and the matching pin is returned.
/// Launch-only providers pass `None`: as on macOS, opening an app is not
/// pinned to a vendor version.
pub fn verify(files: &[Packaged], package: &str, versions: Option<&[&'static str]>) -> Result<Option<&'static str>> {
    for file in files {
        root_owned(file.path, file.executable)?;
    }
    let database = database()?;
    for file in files {
        if !owner_matches(&database, file.path, file.package)? {
            return Err(HelperError::UntrustedInstallation);
        }
    }
    let installed = installed_version(&database, package)?;
    match versions {
        None => Ok(None),
        Some(pins) => pins.iter().copied().find(|pinned| *pinned == installed).map(Some).ok_or(HelperError::UnsupportedProviderVersion),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_owned_paths() {
        assert_eq!(root_owned("/usr/bin/env", true), Ok(()));
        assert_eq!(root_owned("/usr/bin/definitely-not-installed", true), Err(HelperError::NotInstalled));
        assert_eq!(root_owned("relative/path", true), Err(HelperError::UntrustedInstallation));
        assert_eq!(root_owned("/usr/bin/../bin/env", true), Err(HelperError::UntrustedInstallation));
        assert_eq!(root_owned("/usr/bin", true), Err(HelperError::UntrustedInstallation), "a directory is not a file");
        let home = std::env::temp_dir().join(format!("network-guard-trust-{}", std::process::id()));
        std::fs::write(&home, b"#!/bin/sh\n").unwrap();
        // Non-root test users own this file; root-run tests skip the assertion.
        if unsafe { libc::getuid() } != 0 {
            assert_eq!(root_owned(home.to_str().unwrap(), false), Err(HelperError::UntrustedInstallation));
        }
        std::fs::remove_file(home).unwrap();
    }

    #[test]
    fn symlinked_paths_are_untrusted() {
        // Debian and Ubuntu link /usr/bin/sh to dash.
        if std::fs::symlink_metadata("/usr/bin/sh").is_ok_and(|m| m.file_type().is_symlink()) {
            assert_eq!(root_owned("/usr/bin/sh", true), Err(HelperError::UntrustedInstallation));
        }
    }

    #[test]
    fn package_database_ownership_and_version() {
        if database().is_err() {
            return;
        }
        let env = [Packaged { path: "/usr/bin/env", package: "coreutils", executable: true }];
        assert_eq!(verify(&env, "coreutils", Some(&["0.0-not-a-version"])), Err(HelperError::UnsupportedProviderVersion));
        let wrong_owner = [Packaged { path: "/usr/bin/env", package: "bash", executable: true }];
        assert_eq!(verify(&wrong_owner, "bash", Some(&["0"])), Err(HelperError::UntrustedInstallation));
        let installed = installed_version(&database().unwrap(), "coreutils").unwrap();
        let pinned: &'static str = Box::leak(installed.into_boxed_str());
        assert_eq!(verify(&env, "coreutils", Some(&[pinned])), Ok(Some(pinned)));
        assert_eq!(verify(&env, "coreutils", None), Ok(None), "launch-only checks skip the pin");
        assert_eq!(installed_version(&database().unwrap(), "not-a-real-package-name"), Err(HelperError::NotInstalled));
    }
}
