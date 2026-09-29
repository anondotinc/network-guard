//! One request frame in, one response body out. Mirrors `NativeRouter.swift`
//! and the services it dispatches to; `conformance/router.json` pins the
//! behaviour, including the order of checks that decides each error.
use crate::build_info;
use crate::error::{HelperError, Result};
use crate::provider::{Adapters, LegacyControl, Provider};
use crate::wire::{self, envelope, failure, response, strings};
use serde_json::{Map, Value};

/// Held for the duration of a connection attempt; released on drop.
pub type LockGuard = Box<dyn std::any::Any>;

/// Serializes connection attempts across Chrome surfaces and worker restarts.
/// `None` in tests.
pub type Lock = fn() -> Result<Option<LockGuard>>;

pub struct Router<'a> {
    pub adapters: &'a dyn Adapters,
    pub legacy_control: &'a dyn LegacyControl,
    pub control_enabled: bool,
    pub lock: Lock,
}

impl Router<'_> {
    pub fn respond(&self, payload: &[u8]) -> Vec<u8> {
        let version = wire::object(payload).and_then(|object| wire::int(object.get("v")));
        let value = match version {
            Some(8) => describe_v8(payload),
            Some(6) => self.registry(payload, 6),
            Some(5) => self.registry(payload, 5),
            Some(4) => describe_v4(payload),
            Some(3) => self.registry(payload, 3),
            Some(2) => self.control(payload),
            _ => self.legacy(payload),
        };
        serde_json::to_vec(&value).expect("response encodes")
    }

    /// v1: Mullvad status and read-only capabilities. Parse failures carry no id.
    fn legacy(&self, payload: &[u8]) -> Value {
        let parsed = (|| {
            let request = envelope(payload, &["v", "id", "method"])?;
            if !wire::is_version(request.object.get("v"), 1) {
                return Err(HelperError::UnsupportedVersion);
            }
            if request.method != "capabilities" && request.method != "status" {
                return Err(HelperError::UnsupportedMethod);
            }
            Ok(request)
        })();
        let request = match parsed {
            Ok(request) => request,
            Err(error) => return failure(1, None, error),
        };
        let id = Some(request.id.as_str());
        if request.method == "capabilities" {
            return response(1, id, vec![("ok", true.into()), ("capabilities", strings(&["read-status", "read-only-prototype"]))]);
        }
        match self.adapters.get(Provider::Mullvad).status() {
            Ok(snapshot) => response(1, id, vec![("ok", true.into()), ("snapshot", snapshot.to_json())]),
            Err(error) => failure(1, id, error),
        }
    }

    /// v2: the legacy Mullvad control handshake.
    fn control(&self, payload: &[u8]) -> Value {
        let request = match envelope(payload, &["v", "id", "method"]) {
            Ok(request) => request,
            Err(error) => return failure(2, None, error),
        };
        let id = Some(request.id.as_str());
        let result = (|| {
            if wire::int(request.object.get("v")) != Some(2) {
                return Err(HelperError::UnsupportedVersion);
            }
            if !self.control_enabled {
                return Err(HelperError::UnsupportedMethod);
            }
            match request.method.as_str() {
                "capabilities" => Ok(("capabilities", strings(&["connect-selected", "development-control-pilot"]))),
                "connectSelected" => Ok(("snapshot", self.legacy_control.connect_selected()?.to_json())),
                _ => Err(HelperError::UnsupportedMethod),
            }
        })();
        match result {
            Ok((key, value)) => response(2, id, vec![("ok", true.into()), (key, value)]),
            Err(error) => failure(2, id, error),
        }
    }

    /// v3/v5/v6: provider-scoped requests.
    fn registry(&self, payload: &[u8], wire_version: i64) -> Value {
        let parsed = envelope(payload, &["v", "id", "method", "provider"]).and_then(|request| {
            match request.object.get("provider").and_then(Value::as_str).and_then(Provider::from_name) {
                Some(provider) => Ok((request, provider)),
                None => Err(HelperError::InvalidRequest),
            }
        });
        let (request, provider) = match parsed {
            Ok(parsed) => parsed,
            Err(error) => return failure(wire_version, None, error),
        };
        let id = Some(request.id.as_str());
        match self.provider_request(&request, provider, wire_version) {
            Ok(fields) => response(wire_version, id, [vec![("ok", Value::Bool(true))], fields].concat()),
            Err(error) => failure(wire_version, id, error),
        }
    }

    fn provider_request(&self, request: &wire::Envelope, provider: Provider, wire_version: i64) -> Result<Vec<(&'static str, Value)>> {
        if provider.protocol_version() != wire_version && !(provider == Provider::ProtonVpn && wire_version == 6) {
            return Err(HelperError::InvalidRequest);
        }
        if !wire::is_version(request.object.get("v"), wire_version) {
            return Err(HelperError::UnsupportedVersion);
        }
        if !self.control_enabled {
            return Err(HelperError::UnsupportedMethod);
        }
        let selected = self.adapters.get(provider);
        let legacy = provider.legacy_capabilities();
        if wire_version == 6 {
            // v6 is read-only Proton status, offered only where the platform has it.
            if request.method != "status" || !build_info::capabilities(provider).contains(&"read-status") {
                return Err(HelperError::UnsupportedMethod);
            }
            return Ok(vec![("snapshot", selected.status()?.to_json())]);
        }
        match request.method.as_str() {
            "probe" => {
                let mut availability = Map::new();
                availability.insert("provider".into(), provider.name().into());
                availability.insert("capabilities".into(), strings(legacy));
                match selected.validate() {
                    Ok(()) => {
                        availability.insert("available".into(), true.into());
                    }
                    Err(error) => {
                        availability.insert("available".into(), false.into());
                        availability.insert("error".into(), error.code().into());
                    }
                }
                Ok(vec![("availability", Value::Object(availability))])
            }
            "status" if legacy.contains(&"read-status") => Ok(vec![("snapshot", selected.status()?.to_json())]),
            "connectSelected" if legacy.contains(&"connect-selected") => {
                let _guard = (self.lock)()?;
                let before = selected.status()?;
                if before.tunnel == "connected" || before.tunnel == "connecting" {
                    return Ok(vec![("snapshot", before.to_json())]);
                }
                if before.tunnel != "disconnected" {
                    return Err(HelperError::ProviderUnavailable);
                }
                // Check known alternate adapters inside the lock. No generic
                // interface or IP inference: unknown VPNs are not claimed detected.
                for other in [Provider::Mullvad, Provider::Ivpn] {
                    if other == provider {
                        continue;
                    }
                    let adapter = self.adapters.get(other);
                    match adapter.validate() {
                        Err(HelperError::NotInstalled) => continue,
                        Err(_) => return Err(HelperError::ProviderConflict),
                        Ok(()) => {}
                    }
                    match adapter.status() {
                        Ok(state) if state.tunnel == "disconnected" => {}
                        _ => return Err(HelperError::ProviderConflict),
                    }
                }
                Ok(vec![("snapshot", selected.connect()?.to_json())])
            }
            "openApp" if legacy.contains(&"open-app") => {
                selected.open_app()?;
                Ok(vec![("opened", provider.name().into())])
            }
            _ => Err(HelperError::UnsupportedMethod),
        }
    }
}

fn describe(payload: &[u8], wire_version: i64, helper: impl FnOnce() -> Value) -> Value {
    let request = match envelope(payload, &["v", "id", "method"]) {
        Ok(request) => request,
        Err(error) => return failure(wire_version, None, error),
    };
    let id = Some(request.id.as_str());
    if !wire::is_version(request.object.get("v"), wire_version) {
        return failure(wire_version, id, HelperError::UnsupportedVersion);
    }
    if request.method != "describe" {
        return failure(wire_version, id, HelperError::UnsupportedMethod);
    }
    response(wire_version, id, vec![("ok", true.into()), ("helper", helper())])
}

/// Frozen v4 inventory. Existing extensions validate these arrays exactly.
fn describe_v4(payload: &[u8]) -> Value {
    describe(payload, 4, || {
        let mut helper = Map::new();
        helper.insert("version".into(), build_info::VERSION.into());
        helper.insert("channel".into(), build_info::CHANNEL.into());
        helper.insert("protocols".into(), Value::from(vec![1, 2, 3, 4]));
        helper.insert("providers".into(), strings(&["mullvad", "ivpn", "nordvpn"]));
        helper.insert("capabilities".into(), strings(&["describe", "read-status", "connect-selected", "open-provider-app"]));
        Value::Object(helper)
    })
}

fn describe_v8(payload: &[u8]) -> Value {
    describe(payload, 8, || {
        let mut providers = Map::new();
        for provider in Provider::ALL {
            providers.insert(provider.name().into(), strings(build_info::capabilities(provider)));
        }
        let mut helper = Map::new();
        helper.insert("version".into(), build_info::VERSION.into());
        helper.insert("build".into(), build_info::build().into());
        helper.insert("channel".into(), build_info::CHANNEL.into());
        helper.insert("platform".into(), build_info::PLATFORM.into());
        helper.insert("arch".into(), build_info::ARCH.into());
        helper.insert("protocols".into(), Value::from(build_info::protocols().to_vec()));
        helper.insert("providers".into(), Value::Object(providers));
        Value::Object(helper)
    })
}
