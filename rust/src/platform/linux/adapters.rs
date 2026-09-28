//! Linux provider adapters. Every path, package, version and argument is a
//! constant below; a request can only choose a provider.
use super::{lock, trust};
use crate::error::{HelperError, Result};
use crate::process::{self, Limits};
use crate::provider::{ensure_connected, Adapter, Adapters, LegacyControl, Provider, Snapshot};
use crate::status;
use std::path::Path;
use std::time::Duration;
use trust::Packaged;

/// One vendor installation, verified from the system package database.
/// Facts below were checked against the vendors' official repositories on
/// Debian 12, Ubuntu 24.04 and Fedora 41 (amd64 and arm64), September 2026.
pub struct Installation {
    pub package: &'static str,
    pub files: &'static [Packaged],
    /// Exact package versions whose CLI output was checked against the parsers.
    /// `None` for launch-only providers, which are not version-pinned.
    pub versions: Option<&'static [&'static str]>,
}

impl Installation {
    /// The matching pinned version, for providers that report status.
    fn verify_pinned(&self) -> Result<&'static str> {
        trust::verify(self.files, self.package, self.versions)?.ok_or(HelperError::UnsupportedProviderVersion)
    }
    fn verify(&self) -> Result<()> {
        trust::verify(self.files, self.package, self.versions).map(drop)
    }
    fn file(&self, index: usize) -> &'static str {
        self.files[index].path
    }
}

/// `mullvad-vpn` ships the CLI, daemon and GUI in one package. `/usr/bin/mullvad`
/// is a real ELF file. The daemon's socket is usable by any local user.
pub const MULLVAD: Installation = Installation {
    package: "mullvad-vpn",
    files: &[Packaged { path: "/usr/bin/mullvad", package: "mullvad-vpn", executable: true }],
    versions: Some(&["2026.5"]),
};

/// `ivpn` holds the CLI and daemon; the GUI is the separate `ivpn-ui`.
/// `ivpn status` exits 1 while logged out, which reads as providerUnavailable.
pub const IVPN: Installation = Installation {
    package: "ivpn",
    files: &[Packaged { path: "/usr/bin/ivpn", package: "ivpn", executable: true }],
    versions: Some(&["3.15.15"]),
};

/// The Flutter GUI. `/usr/bin/nordvpn-gui` is a symlink made by the package's
/// install script, so it is not package-owned; the real file is under /opt.
pub const NORDVPN: Installation = Installation {
    package: "nordvpn-gui",
    files: &[Packaged { path: "/opt/nordvpn-gui/nordvpn-gui", package: "nordvpn-gui", executable: true }],
    versions: None,
};

/// A Python entry point (`#!/usr/bin/python3`) whose code lives in root-owned
/// dist-packages. Proton's connections are NetworkManager connections.
pub const PROTONVPN: Installation = Installation {
    package: "proton-vpn-gtk-app",
    files: &[Packaged { path: "/usr/bin/protonvpn-app", package: "proton-vpn-gtk-app", executable: true }],
    versions: None,
};

fn snapshot(provider: Provider, version: &'static str, tunnel: &'static str) -> Snapshot {
    Snapshot { provider, installation: trust::INSTALLATION, provider_version: Some(version.into()), tunnel }
}

pub struct Mullvad;

impl Adapter for Mullvad {
    fn validate(&self) -> Result<()> {
        MULLVAD.verify_pinned().map(drop)
    }
    fn status(&self) -> Result<Snapshot> {
        let version = MULLVAD.verify_pinned()?;
        let output = process::run(MULLVAD.file(0), &["status", "--json"], process::DEFAULT)?;
        Ok(snapshot(Provider::Mullvad, version, status::mullvad(&output)?))
    }
    // The router already holds the connection lock.
    fn connect(&self) -> Result<Snapshot> {
        ensure_connected(
            || self.status(),
            || {
                // Revalidate the pinned provider immediately before the only mutation.
                self.validate()?;
                process::run(MULLVAD.file(0), &["connect"], process::DEFAULT).map(drop)
            },
        )
    }
    fn open_app(&self) -> Result<()> {
        Err(HelperError::UnsupportedMethod)
    }
}

pub struct Ivpn;

/// Reuses the last parameters and enables IVPN's firewall for the connection;
/// the extension's consent copy says so. Never picks a server or logs in.
const IVPN_CONNECT: Limits = Limits { timeout: Duration::from_secs(18), output: 65536 };

impl Adapter for Ivpn {
    fn validate(&self) -> Result<()> {
        IVPN.verify_pinned().map(drop)
    }
    fn status(&self) -> Result<Snapshot> {
        let version = IVPN.verify_pinned()?;
        let output = process::run(IVPN.file(0), &["status"], process::DEFAULT)?;
        Ok(snapshot(Provider::Ivpn, version, status::ivpn(&output)?))
    }
    fn connect(&self) -> Result<Snapshot> {
        ensure_connected(
            || self.status(),
            || {
                self.validate()?;
                process::run(IVPN.file(0), &["connect", "-last"], IVPN_CONNECT).map(drop)
            },
        )
    }
    fn open_app(&self) -> Result<()> {
        Err(HelperError::UnsupportedMethod)
    }
}

/// Launch-only: opening the app is not a connection claim. The vendor's own
/// startup settings may connect it.
pub struct LaunchOnly(pub &'static Installation);

impl Adapter for LaunchOnly {
    fn validate(&self) -> Result<()> {
        self.0.verify()
    }
    fn status(&self) -> Result<Snapshot> {
        Err(HelperError::UnsupportedMethod)
    }
    fn connect(&self) -> Result<Snapshot> {
        Err(HelperError::UnsupportedMethod)
    }
    fn open_app(&self) -> Result<()> {
        self.validate()?;
        process::launch_detached(self.0.file(0), &[])
    }
}

pub struct Live {
    mullvad: Mullvad,
    ivpn: Ivpn,
    nordvpn: LaunchOnly,
    protonvpn: LaunchOnly,
}

impl Live {
    pub fn new() -> Self {
        Live { mullvad: Mullvad, ivpn: Ivpn, nordvpn: LaunchOnly(&NORDVPN), protonvpn: LaunchOnly(&PROTONVPN) }
    }
}

impl Default for Live {
    fn default() -> Self {
        Self::new()
    }
}

impl Adapters for Live {
    fn get(&self, provider: Provider) -> &dyn Adapter {
        match provider {
            Provider::Mullvad => &self.mullvad,
            Provider::Ivpn => &self.ivpn,
            Provider::NordVpn => &self.nordvpn,
            Provider::ProtonVpn => &self.protonvpn,
        }
    }
}

impl LegacyControl for Live {
    /// v2 predates provider-aware consent: it never starts Mullvad while IVPN
    /// is installed, because that consent did not cover querying IVPN.
    fn connect_selected(&self) -> Result<Snapshot> {
        let _guard = lock::connection()?;
        ensure_connected(
            || self.mullvad.status(),
            || {
                if Path::new(IVPN.file(0)).exists() {
                    return Err(HelperError::ProviderConflict);
                }
                self.mullvad.validate()?;
                process::run(MULLVAD.file(0), &["connect"], process::DEFAULT).map(drop)
            },
        )
    }
}
