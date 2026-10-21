//! What a request frame needs, decided from its bytes alone.
//!
//! v9 belongs to the shim. Everything else is classified by running the
//! helper's own version router (`network_guard::router`) over adapters that
//! only record whether they were reached. A request the router rejects
//! without reaching a provider or answering successfully is *malformed*: its
//! reply is fully determined by the request, so the shim and the app can give
//! it without the helper, byte for byte as `conformance/router.json` pins it.
//! Any other request is *well-formed* and needs the helper.
//!
//! Some bytes the two helper parsers read differently ([`ambiguous`]). The
//! shim and the bridge leave those to the installed helper: they are never v9,
//! never reused from the cache, and relayed whenever the app can be reached.
use std::cell::Cell;
use std::collections::HashSet;
use std::fmt;

use network_guard::build_info;
use network_guard::error::{HelperError, Result};
use network_guard::provider::{Adapter, Adapters, LegacyControl, Provider, Snapshot};
use network_guard::router::{LockGuard, Router};
use network_guard::wire::{self, response};
use serde::de::{Deserialize, Deserializer, IgnoredAny, MapAccess, Visitor};
use serde_json::{json, Map, Value};

pub const V9: i64 = 9;
/// v9 error codes. The wallet maps them; no other text crosses the boundary.
pub const APP_NOT_RUNNING: &str = "appNotRunning";
pub const APP_STARTING: &str = "appStarting";
pub const APP_START_FAILED: &str = "appStartFailed";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V9Method {
    AppStatus,
    OpenApp,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// A well-formed v9 request, with its lowercased id.
    V9 { id: String, method: V9Method },
    /// Answered from the request alone (malformed v1–v9, unknown versions).
    Reply(Vec<u8>),
    /// A well-formed v1–v8 request: the helper answers it.
    Forward(Forward),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Forward {
    /// The router's version for this request (`1` for `1.0`).
    pub v: i64,
    /// The lowercased request id, as every reply carries it.
    pub id: String,
    pub method: String,
    pub provider: Option<String>,
}

impl Forward {
    /// Reads with no side effect, whose replies the app may reuse briefly.
    pub fn is_read(&self) -> bool {
        matches!(
            (self.v, self.method.as_str()),
            (1, "status" | "capabilities")
                | (2, "capabilities")
                | (3, "status" | "probe")
                | (4, "describe")
                | (5, "probe")
                | (6, "status")
                | (8, "describe")
        )
    }

    /// Requests that can change provider or app state (a connection or an app launch).
    pub fn is_mutation(&self) -> bool {
        matches!(self.method.as_str(), "connectSelected" | "openApp")
    }

    /// `{v, id, ok:false, error}` for this request.
    pub fn failure(&self, code: &str) -> Vec<u8> {
        encode(&error_reply(self.v, Some(&self.id), code))
    }
}

pub fn route(payload: &[u8]) -> Route {
    if let Some(v9) = v9(payload).filter(|_| !ambiguous(payload)) {
        return v9;
    }
    let probe = Probe::default();
    let reply =
        Router { adapters: &probe, legacy_control: &probe, control_enabled: build_info::SUPPORTS_CONNECTION_CONTROL, lock: no_lock }
            .respond(payload);
    let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&reply) else { return Route::Reply(reply) };
    let answered = object.get("ok") == Some(&Value::Bool(true));
    let (Some(v), Some(Value::String(id))) = (wire::int(object.get("v")), object.get("id")) else { return Route::Reply(reply) };
    if !probe.reached.get() && !answered {
        return Route::Reply(reply);
    }
    let request = wire::object(payload).unwrap_or_default();
    let text = |key: &str| request.get(key).and_then(Value::as_str).map(str::to_string);
    Route::Forward(Forward { v, id: id.clone(), method: text("method").unwrap_or_default(), provider: text("provider") })
}

/// Exactly `{"v":9,"id":"<UUID>","method":"appStatus"|"openApp"}`. Anything
/// else with `v:9` is malformed and keeps today's envelope: the helper's
/// router answers it the way a plain helper does (`{"v":1,…}` with
/// `invalidRequest` for a bad shape or id, `unsupportedVersion` otherwise).
fn v9(payload: &[u8]) -> Option<Route> {
    let request = wire::envelope(payload, &["v", "id", "method"]).ok()?;
    if !wire::is_version(request.object.get("v"), V9) {
        return None;
    }
    let method = match request.method.as_str() {
        "appStatus" => V9Method::AppStatus,
        "openApp" => V9Method::OpenApp,
        _ => return None,
    };
    Some(Route::V9 { id: request.id, method })
}

/// Whether the two helpers' JSON parsers may read `payload` differently, so
/// that only the installed helper can answer it as it does today.
///
/// serde_json (this crate and the Rust helper) reads strict UTF-8 JSON and
/// keeps the last of repeated keys. Foundation (the Swift helper) also reads a
/// byte-order mark, UTF-16 and UTF-32, trailing commas and lone surrogates, and
/// keeps the first of repeated keys. Unambiguous bytes are strict JSON whose
/// top-level object, if it is one, repeats no key. Nested objects don't
/// matter: every router rejects a request with one, whatever it holds.
pub fn ambiguous(payload: &[u8]) -> bool {
    match serde_json::from_slice::<Value>(payload) {
        Ok(Value::Object(_)) => !matches!(serde_json::from_slice::<UniqueKeys>(payload), Ok(UniqueKeys(true))),
        Ok(_) => false,
        Err(_) => true,
    }
}

/// A JSON object, and whether each of its keys appears once.
struct UniqueKeys(bool);

impl<'de> Deserialize<'de> for UniqueKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        deserializer.deserialize_map(UniqueKeysVisitor)
    }
}

struct UniqueKeysVisitor;

impl<'de> Visitor<'de> for UniqueKeysVisitor {
    type Value = UniqueKeys;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<UniqueKeys, A::Error> {
        let mut keys = HashSet::new();
        let mut unique = true;
        while let Some(key) = map.next_key::<String>()? {
            map.next_value::<IgnoredAny>()?;
            unique &= keys.insert(key);
        }
        Ok(UniqueKeys(unique))
    }
}

/// What the shim reports about the app (`appStatus`, `openApp`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInfo {
    pub running: bool,
    pub version: Option<String>,
    /// `enabled`, `off`, `requiresApproval` or `unknown`.
    pub start_at_login: &'static str,
}

impl AppInfo {
    fn to_json(&self) -> Value {
        json!({ "running": self.running, "version": self.version, "startAtLogin": self.start_at_login })
    }
}

pub fn app_status_reply(id: &str, app: &AppInfo, shim_version: &str) -> Vec<u8> {
    encode(&response(V9, Some(id), vec![("ok", true.into()), ("app", app.to_json()), ("shim", json!({ "version": shim_version }))]))
}

pub fn open_app_reply(id: &str, app: &AppInfo) -> Vec<u8> {
    encode(&response(V9, Some(id), vec![("ok", true.into()), ("app", app.to_json())]))
}

pub fn v9_failure(id: &str, code: &str) -> Vec<u8> {
    encode(&error_reply(V9, Some(id), code))
}

fn error_reply(v: i64, id: Option<&str>, code: &str) -> Value {
    response(v, id, vec![("ok", false.into()), ("error", code.into())])
}

pub fn encode(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("reply encodes")
}

/// Stands in for every provider and the v2 control path. Reaching it at all
/// means the router accepted the request's shape.
#[derive(Default)]
struct Probe {
    reached: Cell<bool>,
}

impl Probe {
    fn reach<T>(&self) -> Result<T> {
        self.reached.set(true);
        Err(HelperError::ProviderUnavailable)
    }
}

impl Adapter for Probe {
    fn validate(&self) -> Result<()> {
        self.reach()
    }
    fn status(&self) -> Result<Snapshot> {
        self.reach()
    }
    fn connect(&self) -> Result<Snapshot> {
        self.reach()
    }
    fn open_app(&self) -> Result<()> {
        self.reach()
    }
}

impl LegacyControl for Probe {
    fn connect_selected(&self) -> Result<Snapshot> {
        self.reach()
    }
}

impl Adapters for Probe {
    fn get(&self, _: Provider) -> &dyn Adapter {
        self
    }
}

fn no_lock() -> Result<Option<LockGuard>> {
    Ok(None)
}

/// Replaces the correlation id in a reply the helper produced for another
/// request with the same shape. Both ids are lowercase 36-character UUIDs, so
/// the bytes keep their length and every other byte is the helper's. `None`
/// unless the old id appears exactly once, as `"id":"<old>"`.
pub fn swap_id(reply: &[u8], old: &str, new: &str) -> Option<Vec<u8>> {
    if old.len() != 36 || new.len() != 36 || !wire::is_uuid(new) {
        return None;
    }
    let needle = format!("\"id\":\"{old}\"");
    let needle = needle.as_bytes();
    let mut found = None;
    for start in 0..reply.len().saturating_sub(needle.len() - 1) {
        if &reply[start..start + needle.len()] == needle {
            if found.is_some() {
                return None;
            }
            found = Some(start);
        }
    }
    let start = found? + "\"id\":\"".len();
    let mut swapped = reply.to_vec();
    swapped[start..start + 36].copy_from_slice(new.as_bytes());
    Some(swapped)
}

/// Whether the helper's reply answers `request` as the cache keys it: `ok:true`,
/// the request's id and the request's version.
pub fn reusable(reply: &[u8], request: &Forward) -> bool {
    matches!(serde_json::from_slice::<Map<String, Value>>(reply),
        Ok(object) if object.get("ok") == Some(&Value::Bool(true))
            && object.get("id").and_then(Value::as_str) == Some(request.id.as_str())
            && wire::int(object.get("v")) == Some(request.v))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "01234567-89ab-4def-8123-456789abcdef";
    const OTHER: &str = "fedcba98-7654-4321-8fed-cba987654321";

    fn route_of(value: Value) -> Route {
        route(value.to_string().as_bytes())
    }

    #[test]
    fn v9_requests_and_their_errors() {
        assert_eq!(route_of(json!({"v": 9, "id": ID, "method": "appStatus"})), Route::V9 { id: ID.into(), method: V9Method::AppStatus });
        assert_eq!(
            route_of(json!({"v": 9.0, "id": ID.to_uppercase(), "method": "openApp"})),
            Route::V9 { id: ID.into(), method: V9Method::OpenApp }
        );
        let reply = |value: Value| match route_of(value) {
            Route::Reply(bytes) => serde_json::from_slice::<Value>(&bytes).unwrap(),
            other => panic!("{other:?}"),
        };
        // Malformed v9 gets exactly what a plain helper answers today.
        let invalid = json!({"v": 1, "ok": false, "error": "invalidRequest"});
        let unknown = json!({"v": 1, "ok": false, "error": "unsupportedVersion"});
        assert_eq!(reply(json!({"v": 9, "id": ID, "method": "quit"})), unknown);
        assert_eq!(reply(json!({"v": 9, "id": ID, "method": "appStatus", "x": 1})), invalid);
        assert_eq!(reply(json!({"v": 9, "id": "nope", "method": "appStatus"})), invalid);
        assert_eq!(reply(json!({"v": 9, "id": ID, "method": 9})), invalid);
        assert_eq!(reply(json!({"v": 9, "id": ID})), invalid);
        assert_eq!(reply(json!({"v": 9.5, "id": ID, "method": "appStatus"})), unknown);
    }

    #[test]
    fn well_formed_requests_are_forwarded_and_malformed_ones_answered() {
        let forward = |value: Value| match route_of(value) {
            Route::Forward(forward) => forward,
            other => panic!("{other:?}"),
        };
        let status = forward(json!({"v": 1, "id": ID, "method": "status"}));
        assert!(status.is_read() && !status.is_mutation());
        assert_eq!((status.v, status.id.as_str()), (1, ID));
        assert!(forward(json!({"v": 8, "id": ID, "method": "describe"})).is_read());
        assert!(forward(json!({"v": 2, "id": ID, "method": "capabilities"})).is_read());
        let connect = forward(json!({"v": 3, "id": ID, "method": "connectSelected", "provider": "ivpn"}));
        assert!(connect.is_mutation() && !connect.is_read());
        assert_eq!(connect.provider.as_deref(), Some("ivpn"));
        assert!(forward(json!({"v": 5, "id": ID, "method": "openApp", "provider": "protonvpn"})).is_mutation());
        for malformed in [json!({"v": 1, "id": ID, "method": "connect"}), json!({"v": 7, "id": ID, "method": "rpcCapabilities"}), json!([])]
        {
            assert!(matches!(route_of(malformed), Route::Reply(_)));
        }
    }

    #[test]
    fn swapping_the_id_keeps_every_other_byte() {
        let reply = format!(r#"{{"id":"{ID}","ok":true,"snapshot":{{"tunnel":"connected"}},"v":1}}"#);
        let swapped = swap_id(reply.as_bytes(), ID, OTHER).unwrap();
        assert_eq!(String::from_utf8(swapped).unwrap(), reply.replace(ID, OTHER));
        assert_eq!(swap_id(format!(r#"{{"id":"{ID}","x":{{"id":"{ID}"}}}}"#).as_bytes(), ID, OTHER), None);
        assert_eq!(swap_id(br#"{"ok":true}"#, ID, OTHER), None);
        assert_eq!(swap_id(reply.as_bytes(), ID, "short"), None);
    }

    #[test]
    fn a_reply_is_reusable_only_for_the_request_it_answers() {
        let request = |v: i64, id: &str| Forward { v, id: id.into(), method: "status".into(), provider: None };
        let reply = format!(r#"{{"id":"{ID}","ok":true,"snapshot":{{}},"v":1}}"#);
        assert!(reusable(reply.as_bytes(), &request(1, ID)));
        assert!(!reusable(reply.as_bytes(), &request(1, OTHER)));
        // The helper answered another version than the key says (it read a repeated "v" another way).
        assert!(!reusable(reply.as_bytes(), &request(6, ID)));
        assert!(!reusable(reply.replace("true", "false").as_bytes(), &request(1, ID)));
        assert!(!reusable(b"not json", &request(1, ID)));
    }

    #[test]
    fn ambiguous_bytes_are_those_the_two_parsers_may_read_differently() {
        let status = format!(r#"{{"v":1,"id":"{ID}","method":"status"}}"#);
        for unambiguous in [status.clone(), "[]".into(), "1".into(), format!(r#"{{"\u0076":1,"id":"{ID}","method":"status"}}"#)] {
            assert!(!ambiguous(unambiguous.as_bytes()), "{unambiguous}");
        }
        let utf16 = |text: &str, big: bool| -> Vec<u8> {
            text.encode_utf16().flat_map(|unit| if big { unit.to_be_bytes() } else { unit.to_le_bytes() }).collect()
        };
        let ambiguous_frames: Vec<Vec<u8>> = vec![
            [b"\xef\xbb\xbf".as_slice(), status.as_bytes()].concat(),
            utf16(&status, false),
            utf16(&format!("\u{feff}{status}"), true),
            status.replace('}', ",}").into_bytes(),
            format!(r#"{{"v":4,"id":"{ID}","method":"describe","v":8}}"#).into_bytes(),
            format!(r#"{{"v":1,"id":"{ID}","method":"status","id":"{OTHER}"}}"#).into_bytes(),
            format!(r#"{{"v":1,"id":"{ID}","method":"status","p":"\ud800"}}"#).into_bytes(),
            b"not json".to_vec(),
        ];
        for frame in ambiguous_frames {
            assert!(ambiguous(&frame), "{}", String::from_utf8_lossy(&frame));
        }
    }

    #[test]
    fn repeated_keys_are_never_v9() {
        // serde_json reads v9 appStatus; Foundation reads v1 capabilities.
        let frame = format!(r#"{{"v":1,"id":"{ID}","method":"capabilities","method":"appStatus","v":9}}"#);
        assert!(!matches!(route(frame.as_bytes()), Route::V9 { .. }));
        let open = format!(r#"{{"v":9,"id":"{ID}","method":"openApp","method":"openApp"}}"#);
        assert!(!matches!(route(open.as_bytes()), Route::V9 { .. }));
    }
}
