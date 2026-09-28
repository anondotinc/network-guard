//! Runs the shared fixtures in `../conformance` against the Rust helper with
//! fake adapters. The Swift helper runs the same files (ConformanceTests.swift).
use network_guard::build_info;
use network_guard::error::{HelperError, Result};
use network_guard::provider::{ensure_connected, Adapter, Adapters, LegacyControl, Provider, Snapshot};
use network_guard::router::Router;
use network_guard::{frames, origin, status};
use serde_json::{Map, Value};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::path::PathBuf;

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance").join(name);
    serde_json::from_slice(&std::fs::read(&path).expect("fixture exists")).expect("fixture is JSON")
}

fn hex(text: &str) -> Vec<u8> {
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

struct Fake {
    provider: Provider,
    installed: bool,
    failure: Option<HelperError>,
    state: RefCell<&'static str>,
    reads: Cell<i64>,
    connects: Cell<i64>,
    opens: Cell<i64>,
}

fn tunnel(state: &str) -> &'static str {
    network_guard::provider::TUNNEL_STATES.into_iter().find(|known| *known == state).expect("fixture tunnel state")
}

impl Fake {
    fn new(provider: Provider, scenario: Option<&Value>) -> Self {
        let field = |key: &str| scenario.and_then(|s| s.get(key));
        Fake {
            provider,
            installed: field("installed").and_then(Value::as_bool).unwrap_or(true),
            failure: field("failure").and_then(Value::as_str).map(|code| HelperError::from_code(code).expect("fixture error code")),
            state: RefCell::new(field("state").and_then(Value::as_str).map(tunnel).unwrap_or("disconnected")),
            reads: Cell::new(0),
            connects: Cell::new(0),
            opens: Cell::new(0),
        }
    }
}

impl Adapter for Fake {
    fn validate(&self) -> Result<()> {
        if !self.installed {
            return Err(HelperError::NotInstalled);
        }
        self.failure.map_or(Ok(()), Err)
    }
    fn status(&self) -> Result<Snapshot> {
        self.validate()?;
        self.reads.set(self.reads.get() + 1);
        let version = match self.provider {
            Provider::Ivpn => "3.15.15",
            Provider::ProtonVpn => "6.5.1",
            Provider::Mullvad | Provider::NordVpn => "2026.4",
        };
        Ok(Snapshot {
            provider: self.provider,
            installation: "verified-local-signature",
            provider_version: Some(version.into()),
            tunnel: *self.state.borrow(),
        })
    }
    fn connect(&self) -> Result<Snapshot> {
        self.connects.set(self.connects.get() + 1);
        *self.state.borrow_mut() = "connecting";
        self.status()
    }
    fn open_app(&self) -> Result<()> {
        self.validate()?;
        self.opens.set(self.opens.get() + 1);
        Ok(())
    }
}

struct Fakes(HashMap<Provider, Fake>);
impl Adapters for Fakes {
    fn get(&self, provider: Provider) -> &dyn Adapter {
        &self.0[&provider]
    }
}
impl LegacyControl for Fakes {
    fn connect_selected(&self) -> Result<Snapshot> {
        let mullvad = &self.0[&Provider::Mullvad];
        ensure_connected(|| mullvad.status(), || mullvad.connect().map(drop))
    }
}

fn expand(value: &Value) -> Value {
    let mut text = serde_json::to_string(value).unwrap();
    for (token, replacement) in [
        ("\"{{build}}\"".to_string(), build_info::build().to_string()),
        ("{{version}}".into(), build_info::VERSION.into()),
        ("{{channel}}".into(), build_info::CHANNEL.into()),
        ("{{platform}}".into(), build_info::PLATFORM.into()),
        ("{{arch}}".into(), build_info::ARCH.into()),
    ] {
        text = text.replace(&token, &replacement);
    }
    serde_json::from_str(&text).unwrap()
}

fn for_platform<'a>(case: &'a Value, key: &str) -> Option<&'a Value> {
    case.get(format!("{key}ByPlatform")).and_then(|by| by.get(build_info::PLATFORM)).or_else(|| case.get(key))
}

#[test]
fn router() {
    let file = fixture("router.json");
    let mut failures = Vec::new();
    for case in file["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let scenario = case.get("scenario");
        let providers = scenario.and_then(|s| s.get("providers"));
        let fakes = Fakes(Provider::ALL.into_iter().map(|p| (p, Fake::new(p, providers.and_then(|all| all.get(p.name()))))).collect());
        let router = Router {
            adapters: &fakes,
            legacy_control: &fakes,
            control_enabled: scenario.and_then(|s| s.get("control")).and_then(Value::as_bool).unwrap_or(true),
            lock: || Ok(None),
        };
        let payload = match case.get("requestText") {
            Some(text) => text.as_str().unwrap().as_bytes().to_vec(),
            None => serde_json::to_vec(&case["request"]).unwrap(),
        };
        let actual: Value = serde_json::from_slice(&router.respond(&payload)).unwrap();
        let expected = expand(for_platform(case, "response").expect("case has a response"));
        if actual != expected {
            failures.push(format!("{name}\n  expected {expected}\n  actual   {actual}"));
        }
        if let Some(Value::Object(calls)) = for_platform(case, "calls") {
            for (provider, counts) in calls {
                let fake = &fakes.0[&Provider::from_name(provider).unwrap()];
                let mut actual = Map::new();
                actual.insert("reads".into(), fake.reads.get().into());
                actual.insert("connects".into(), fake.connects.get().into());
                actual.insert("opens".into(), fake.opens.get().into());
                if &Value::Object(actual.clone()) != counts {
                    failures.push(format!("{name}: {provider} calls expected {counts} actual {}", Value::Object(actual)));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{} router cases failed:\n{}", failures.len(), failures.join("\n"));
}

#[test]
fn frames() {
    let file = fixture("frames.json");
    assert_eq!(file["maxBytes"].as_u64(), Some(frames::MAX_BYTES as u64));
    for stream in file["streams"].as_array().unwrap() {
        let name = stream["name"].as_str().unwrap();
        let bytes = hex(stream["hex"].as_str().unwrap());
        let mut input = bytes.as_slice();
        let mut read = Vec::new();
        let end = loop {
            match frames::read(&mut input) {
                Ok(Some(frame)) => read.push(frame),
                Ok(None) => break "eof",
                Err(error) => break error.code(),
            }
        };
        let expected: Vec<Vec<u8>> = stream["frames"].as_array().unwrap().iter().map(|f| hex(f.as_str().unwrap())).collect();
        assert_eq!(read, expected, "{name}");
        assert_eq!(end, stream["end"].as_str().unwrap(), "{name}");
    }
    for item in file["encode"].as_array().unwrap() {
        let name = item["name"].as_str().unwrap();
        let result = frames::encode(&hex(item["payloadHex"].as_str().unwrap()));
        match item.get("error").and_then(Value::as_str) {
            Some(code) => assert_eq!(result.unwrap_err().code(), code, "{name}"),
            None => assert_eq!(result.unwrap(), hex(item["hex"].as_str().unwrap()), "{name}"),
        }
    }
}

#[test]
fn origins() {
    let file = fixture("origins.json");
    let allowed = file["allowedId"].as_str().unwrap();
    for item in file["accept"].as_array().unwrap() {
        assert!(origin::accepts(item.as_str().unwrap(), &[allowed]), "{item}");
    }
    for item in file["reject"].as_array().unwrap() {
        assert!(!origin::accepts(item.as_str().unwrap(), &[allowed]), "{item}");
    }
    for item in file["rejectWithIds"].as_array().unwrap() {
        let ids: Vec<&str> = item["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap()).collect();
        assert!(!origin::accepts(item["origin"].as_str().unwrap(), &ids), "{item}");
    }
}

#[test]
fn status_parsers() {
    let file = fixture("status-parsers.json");
    type Parser = fn(&[u8]) -> Result<&'static str>;
    let parsers: [(&str, Parser); 2] = [("mullvad", status::mullvad), ("ivpn", status::ivpn)];
    for (provider, parse) in parsers {
        for item in file[provider]["cases"].as_array().unwrap() {
            let text = item["text"].as_str().unwrap();
            match item.get("tunnel").and_then(Value::as_str) {
                Some(tunnel) => assert_eq!(parse(text.as_bytes()), Ok(tunnel), "{provider}: {text:?}"),
                None => assert_eq!(parse(text.as_bytes()).unwrap_err().code(), item["error"].as_str().unwrap(), "{provider}: {text:?}"),
            }
        }
    }
}
