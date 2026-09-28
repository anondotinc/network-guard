/// The only error codes that cross the native-messaging boundary. Mirrors
/// `HelperError` in `Sources/NetworkHelperCore/Protocol.swift`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HelperError {
    InvalidRequest,
    UnsupportedVersion,
    UnsupportedMethod,
    InvalidFrame,
    NotInstalled,
    UntrustedInstallation,
    UnsupportedProviderVersion,
    ProviderUnavailable,
    ProviderTimeout,
    OversizedOutput,
    UnrecognizedStatus,
    ControlBusy,
    ProviderConflict,
}

impl HelperError {
    pub const ALL: [HelperError; 13] = [
        Self::InvalidRequest,
        Self::UnsupportedVersion,
        Self::UnsupportedMethod,
        Self::InvalidFrame,
        Self::NotInstalled,
        Self::UntrustedInstallation,
        Self::UnsupportedProviderVersion,
        Self::ProviderUnavailable,
        Self::ProviderTimeout,
        Self::OversizedOutput,
        Self::UnrecognizedStatus,
        Self::ControlBusy,
        Self::ProviderConflict,
    ];

    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalidRequest",
            Self::UnsupportedVersion => "unsupportedVersion",
            Self::UnsupportedMethod => "unsupportedMethod",
            Self::InvalidFrame => "invalidFrame",
            Self::NotInstalled => "notInstalled",
            Self::UntrustedInstallation => "untrustedInstallation",
            Self::UnsupportedProviderVersion => "unsupportedProviderVersion",
            Self::ProviderUnavailable => "providerUnavailable",
            Self::ProviderTimeout => "providerTimeout",
            Self::OversizedOutput => "oversizedOutput",
            Self::UnrecognizedStatus => "unrecognizedStatus",
            Self::ControlBusy => "controlBusy",
            Self::ProviderConflict => "providerConflict",
        }
    }

    pub fn from_code(code: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|error| error.code() == code)
    }
}

pub type Result<T> = std::result::Result<T, HelperError>;
