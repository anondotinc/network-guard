//! Windows provider adapters. Every path, publisher, version and argument is a
//! constant below; a request can only choose a provider.
use super::{lock, trust};
use crate::error::{HelperError, Result};
use crate::process::{self, Limits};
use crate::provider::{ensure_connected, Adapter, Adapters, LegacyControl, Provider, Snapshot};
use crate::status;
use std::time::Duration;
use trust::Signed;

/// One vendor installation under Program Files. The first file is the one the
/// helper runs. Facts were checked against each vendor's official installer
/// (September 2026) unless noted.
pub struct Installation {
    pub files: &'static [Signed],
    /// Index of the file whose fixed file version is pinned, and the pins
    /// (file version → version reported to the extension). `None` for
    /// launch-only providers, which are not version-pinned.
    pub versions: Option<(usize, &'static [(&'static str, &'static str)])>,
}

impl Installation {
    fn verify_pinned(&self) -> Result<(String, &'static str)> {
        let (path, version) = trust::verify(self.files, self.versions)?;
        Ok((path, version.ok_or(HelperError::UnsupportedProviderVersion)?))
    }
    fn verify(&self) -> Result<String> {
        trust::verify(self.files, self.versions).map(|(path, _)| path)
    }
}

const MULLVAD_PUBLISHER: (&str, &str) = ("Mullvad VPN AB", "Mullvad VPN AB");
const IVPN_PUBLISHER: (&str, &str) = ("IVPN Limited", "IVPN Limited");

/// `mullvad.exe` carries an all-zero version resource; `Mullvad VPN.exe` is stamped.
pub const MULLVAD: Installation = Installation {
    files: &[
        Signed { path: "Mullvad VPN\\resources\\mullvad.exe", organization: MULLVAD_PUBLISHER.0, common_name: MULLVAD_PUBLISHER.1 },
        Signed { path: "Mullvad VPN\\Mullvad VPN.exe", organization: MULLVAD_PUBLISHER.0, common_name: MULLVAD_PUBLISHER.1 },
    ],
    versions: Some((1, &[("2026.5.0.0", "2026.5")])),
};

/// `cli\ivpn.exe` has no version resource; the app executable is stamped.
pub const IVPN: Installation = Installation {
    files: &[
        Signed { path: "IVPN Client\\cli\\ivpn.exe", organization: IVPN_PUBLISHER.0, common_name: IVPN_PUBLISHER.1 },
        Signed { path: "IVPN Client\\ui\\IVPN Client.exe", organization: IVPN_PUBLISHER.0, common_name: IVPN_PUBLISHER.1 },
    ],
    versions: Some((1, &[("3.15.15.0", "3.15.15")])),
};

/// Installed by a downloader that could not be unpacked offline; the path is
/// from NordVPN's documentation and the publisher from the downloader's signature.
pub const NORDVPN: Installation = Installation {
    files: &[Signed { path: "NordVPN\\NordVPN.exe", organization: "nordvpn s.a.", common_name: "nordvpn s.a." }],
    versions: None,
};

/// The Start-menu target; the app itself lives in a versioned subfolder.
pub const PROTONVPN: Installation = Installation {
    files: &[Signed { path: "Proton\\VPN\\ProtonVPN.Launcher.exe", organization: "Proton AG", common_name: "Proton AG" }],
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
        let (path, version) = MULLVAD.verify_pinned()?;
        let output = process::run(&path, &["status", "--json"], process::DEFAULT)?;
        Ok(snapshot(Provider::Mullvad, version, status::mullvad(&output)?))
    }
    // The router already holds the connection lock.
    fn connect(&self) -> Result<Snapshot> {
        ensure_connected(
            || self.status(),
            || {
                let (path, _) = MULLVAD.verify_pinned()?;
                process::run(&path, &["connect"], process::DEFAULT).map(drop)
            },
        )
    }
    fn open_app(&self) -> Result<()> {
        Err(HelperError::UnsupportedMethod)
    }
}

pub struct Ivpn;

/// Reuses the last parameters and enables IVPN's firewall for the connection.
const IVPN_CONNECT: Limits = Limits { timeout: Duration::from_secs(18), output: 65536 };

impl Adapter for Ivpn {
    fn validate(&self) -> Result<()> {
        IVPN.verify_pinned().map(drop)
    }
    fn status(&self) -> Result<Snapshot> {
        let (path, version) = IVPN.verify_pinned()?;
        let output = process::run(&path, &["status"], process::DEFAULT)?;
        Ok(snapshot(Provider::Ivpn, version, status::ivpn(&output)?))
    }
    fn connect(&self) -> Result<Snapshot> {
        ensure_connected(
            || self.status(),
            || {
                let (path, _) = IVPN.verify_pinned()?;
                process::run(&path, &["connect", "-last"], IVPN_CONNECT).map(drop)
            },
        )
    }
    fn open_app(&self) -> Result<()> {
        Err(HelperError::UnsupportedMethod)
    }
}

/// Launch-only: opening the app is not a connection claim.
pub struct LaunchOnly(pub &'static Installation);

impl Adapter for LaunchOnly {
    fn validate(&self) -> Result<()> {
        self.0.verify().map(drop)
    }
    fn status(&self) -> Result<Snapshot> {
        Err(HelperError::UnsupportedMethod)
    }
    fn connect(&self) -> Result<Snapshot> {
        Err(HelperError::UnsupportedMethod)
    }
    fn open_app(&self) -> Result<()> {
        let path = self.0.verify()?;
        process::launch_detached(&path, &[])
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
    /// v2 predates provider-aware consent: never start Mullvad while IVPN is installed.
    fn connect_selected(&self) -> Result<Snapshot> {
        let _guard = lock::connection()?;
        ensure_connected(
            || self.mullvad.status(),
            || {
                match trust::admin_owned(IVPN.files[0].path) {
                    Err(HelperError::NotInstalled) => {}
                    _ => return Err(HelperError::ProviderConflict),
                }
                let (path, _) = MULLVAD.verify_pinned()?;
                process::run(&path, &["connect"], process::DEFAULT).map(drop)
            },
        )
    }
}
