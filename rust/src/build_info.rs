//! Build identity: version, channel, enrolled extension, platform capabilities.
//! Channels never share a host name, extension id or install root.
use crate::provider::Provider;

pub const VERSION: &str = env!("NETWORK_GUARD_VERSION");
pub const DEVELOPMENT_EXTENSION_ID: &str = "foghepoakbdbpbjknofnhbhpiehpmdac";
pub const PRODUCTION_EXTENSION_ID: &str = "gnkbgepgknkbhnnbaihklcfkjhbclajk";

pub fn build() -> i64 {
    env!("NETWORK_GUARD_BUILD").parse().expect("build number")
}

#[cfg(feature = "development")]
mod channel {
    pub const NAME: &str = "development";
    pub const HOST: &str = "inc.anon.network_helper.dev";
    pub const EXTENSION_ID: &str = super::DEVELOPMENT_EXTENSION_ID;
}
#[cfg(not(feature = "development"))]
mod channel {
    pub const NAME: &str = "production";
    pub const HOST: &str = "inc.anon.network_helper";
    pub const EXTENSION_ID: &str = super::PRODUCTION_EXTENSION_ID;
}
pub use channel::{EXTENSION_ID, HOST as HOST_NAME, NAME as CHANNEL};

/// Both enrolled channels support the provider-scoped control protocol.
pub const SUPPORTS_CONNECTION_CONTROL: bool = true;

pub const PLATFORM: &str = if cfg!(target_os = "linux") {
    "linux"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "macos"
};

pub const ARCH: &str = if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" };

/// Per-platform capabilities reported by describe v8 and used as the v6 gate.
/// Keep in step with `conformance/README.md` and `PlatformCapabilities` in Swift.
/// The macOS row exists so the shared fixtures also run on a developer's Mac.
pub fn capabilities(provider: Provider) -> &'static [&'static str] {
    match (PLATFORM, provider) {
        (_, Provider::Mullvad | Provider::Ivpn) => &["read-status", "connect-selected"],
        (_, Provider::NordVpn) => &["open-app"],
        ("macos", Provider::ProtonVpn) => &["open-app", "read-status"],
        (_, Provider::ProtonVpn) => &["open-app"],
    }
}

pub fn protocols() -> &'static [i64] {
    if capabilities(Provider::ProtonVpn).contains(&"read-status") {
        &[1, 2, 3, 4, 5, 6, 8]
    } else {
        &[1, 2, 3, 4, 5, 8]
    }
}
