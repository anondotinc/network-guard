use crate::error::Result;
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Provider {
    Mullvad,
    Ivpn,
    NordVpn,
    ProtonVpn,
}

impl Provider {
    pub const ALL: [Provider; 4] = [Self::Mullvad, Self::Ivpn, Self::NordVpn, Self::ProtonVpn];

    pub fn name(self) -> &'static str {
        match self {
            Self::Mullvad => "mullvad",
            Self::Ivpn => "ivpn",
            Self::NordVpn => "nordvpn",
            Self::ProtonVpn => "protonvpn",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.name() == name)
    }

    /// Wire version for probe/openApp/status/connectSelected (v6 adds Proton status).
    pub fn protocol_version(self) -> i64 {
        if self == Self::ProtonVpn {
            5
        } else {
            3
        }
    }

    /// Frozen legacy list returned by `probe` and used as the v3/v5 method gate.
    /// Platform differences live in `build_info::capabilities`.
    pub fn legacy_capabilities(self) -> &'static [&'static str] {
        match self {
            Self::NordVpn | Self::ProtonVpn => &["open-app"],
            Self::Mullvad | Self::Ivpn => &["read-status", "connect-selected"],
        }
    }
}

/// Only the tunnel discriminant leaves the helper; `protection` is never claimed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub provider: Provider,
    pub installation: &'static str,
    pub provider_version: Option<String>,
    pub tunnel: &'static str,
}

pub const TUNNEL_STATES: [&str; 5] = ["connected", "connecting", "disconnected", "disconnecting", "error"];

impl Snapshot {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("provider".into(), Value::from(self.provider.name()));
        object.insert("installation".into(), Value::from(self.installation));
        if let Some(version) = &self.provider_version {
            object.insert("providerVersion".into(), Value::from(version.as_str()));
        }
        object.insert("tunnel".into(), Value::from(self.tunnel));
        object.insert("protection".into(), Value::from("unknown"));
        object.insert("reason".into(), Value::from("route-not-verified"));
        Value::Object(object)
    }
}

/// One installed VPN app. Callers select a provider, never a path or argument.
pub trait Adapter {
    fn validate(&self) -> Result<()>;
    fn status(&self) -> Result<Snapshot>;
    fn connect(&self) -> Result<Snapshot>;
    fn open_app(&self) -> Result<()>;
}

/// The legacy v2 control path (Mullvad only), which carries its own lock and
/// conflict rule in each platform implementation.
pub trait LegacyControl {
    fn connect_selected(&self) -> Result<Snapshot>;
}

pub trait Adapters {
    fn get(&self, provider: Provider) -> &dyn Adapter;
}

/// Never interrupt an existing connection or fight a user who is disconnecting.
/// A command timeout is an uncertain result, not a rollback.
pub fn ensure_connected(status: impl Fn() -> Result<Snapshot>, connect: impl FnOnce() -> Result<()>) -> Result<Snapshot> {
    let before = status()?;
    if before.tunnel == "connected" || before.tunnel == "connecting" {
        return Ok(before);
    }
    if before.tunnel != "disconnected" {
        return Err(crate::error::HelperError::ProviderUnavailable);
    }
    connect()?;
    status()
}
