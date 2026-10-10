//! Runs `conformance/shim.json` against the shim's decisions with a fake app,
//! and derives the shim's reply for every `conformance/router.json` case.
use std::fs;
use std::path::PathBuf;

use guard_device::launch::Opened;
use guard_device::shim::{respond, AppState, Host};
use guard_device::VERSION;
use network_guard::build_info;
use serde_json::{json, Value};

fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../conformance").join(name);
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

struct FakeApp {
    state: AppState,
    start_at_login: &'static str,
    open: Opened,
    reply: Option<Vec<u8>>,
    launches: u64,
    forwards: u64,
}

impl Host for FakeApp {
    fn app_state(&mut self) -> AppState {
        self.state.clone()
    }
    fn forward(&mut self, _: &[u8]) -> Option<Vec<u8>> {
        match self.state {
            AppState::Running(_) => {
                self.forwards += 1;
                Some(self.reply.clone().unwrap_or_else(|| b"{\"relayed\":true}".to_vec()))
            }
            _ => None,
        }
    }
    fn launch_in_progress(&mut self) -> bool {
        self.state == AppState::Starting
    }
    fn start_at_login(&mut self) -> &'static str {
        self.start_at_login
    }
    fn open_app(&mut self) -> Opened {
        self.launches += 1;
        if let Opened::Running(version) = &self.open {
            self.state = AppState::Running(version.clone());
        }
        self.open.clone()
    }
}

fn app(state: &str) -> FakeApp {
    FakeApp {
        state: match state {
            "running" => AppState::Running(VERSION.into()),
            "starting" => AppState::Starting,
            "stopped" => AppState::Stopped,
            other => panic!("unknown app state {other}"),
        },
        start_at_login: "off",
        open: Opened::Failed,
        reply: None,
        launches: 0,
        forwards: 0,
    }
}

/// `request` as compact JSON, or `requestText` as raw text in
/// `requestEncoding` (`utf-8` by default, `utf-16le` or `utf-16be`).
fn payload(case: &Value) -> Vec<u8> {
    let utf16 = |text: &str, big: bool| -> Vec<u8> {
        text.encode_utf16().flat_map(|unit| if big { unit.to_be_bytes() } else { unit.to_le_bytes() }).collect()
    };
    match (case.get("request"), case.get("requestText"), case.get("requestEncoding").and_then(Value::as_str)) {
        (Some(request), None, None) => serde_json::to_vec(request).unwrap(),
        (None, Some(Value::String(text)), None | Some("utf-8")) => text.as_bytes().to_vec(),
        (None, Some(Value::String(text)), Some("utf-16le")) => utf16(text, false),
        (None, Some(Value::String(text)), Some("utf-16be")) => utf16(text, true),
        _ => panic!("case needs request, or requestText in a known encoding: {case}"),
    }
}

fn tokens(value: &Value) -> Value {
    let text = value
        .to_string()
        .replace("{{version}}", build_info::VERSION)
        .replace("\"{{build}}\"", &build_info::build().to_string())
        .replace("{{channel}}", build_info::CHANNEL)
        .replace("{{platform}}", build_info::PLATFORM)
        .replace("{{arch}}", build_info::ARCH);
    serde_json::from_str(&text).unwrap()
}

#[test]
fn shim_fixtures() {
    let document = fixture("shim.json");
    let cases = document["cases"].as_array().unwrap();
    assert!(cases.len() >= 40);
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut host = app(case["app"].as_str().unwrap());
        host.start_at_login = match case.get("startAtLogin").and_then(Value::as_str).unwrap_or("off") {
            "off" => "off",
            "enabled" => "enabled",
            "requiresApproval" => "requiresApproval",
            "unknown" => "unknown",
            other => panic!("{name}: startAtLogin {other}"),
        };
        host.open = match case.get("open").and_then(Value::as_str) {
            Some("running") => Opened::Running(VERSION.into()),
            Some("starting") => Opened::Starting,
            Some("failed") | None => Opened::Failed,
            Some(other) => panic!("{name}: open {other}"),
        };
        host.reply = case.get("appReply").map(|reply| serde_json::to_vec(reply).unwrap());
        let reply = respond(&mut host, &payload(case), VERSION);
        let parsed: Value = serde_json::from_slice(&reply).unwrap_or_else(|_| panic!("{name}: reply is not JSON"));
        assert_eq!(parsed, tokens(&case["response"]), "{name}");
        if let Some(app_reply) = &host.reply {
            assert_eq!(&reply, app_reply, "{name}: relayed bytes changed");
        }
        if let Some(launches) = case.get("launches").and_then(Value::as_u64) {
            assert_eq!(host.launches, launches, "{name}: launches");
        }
        if let Some(forwards) = case.get("forwards").and_then(Value::as_u64) {
            assert_eq!(host.forwards, forwards, "{name}: forwards");
        }
    }
}

/// With the app stopped, every router case gets either its router reply
/// (malformed: decided by the request alone) or `appNotRunning` with the
/// request's version and id (well-formed: it needs the helper). With the app
/// running, well-formed requests are relayed and malformed ones still get the
/// router's reply, unless only the helper can read them unambiguously (not
/// strict JSON): those are relayed too. Nothing starts the app.
#[test]
fn every_router_case_through_the_shim() {
    let document = fixture("router.json");
    let mut checked = 0;
    for case in document["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // The build's control flag is always on; fixtures that turn it off don't apply.
        if case.pointer("/scenario/control") == Some(&json!(false)) {
            continue;
        }
        let expected = tokens(case.get("responseByPlatform").and_then(|r| r.get(build_info::PLATFORM)).unwrap_or(&case["response"]));
        let parse_error = matches!(expected["error"].as_str(), Some("invalidRequest" | "unsupportedVersion" | "unsupportedMethod"));
        let stopped_reply = {
            let mut host = app("stopped");
            let reply: Value = serde_json::from_slice(&respond(&mut host, &payload(case), VERSION)).unwrap();
            assert_eq!(host.launches, 0, "{name}");
            reply
        };
        let mut running = app("running");
        let running_reply: Value = serde_json::from_slice(&respond(&mut running, &payload(case), VERSION)).unwrap();
        if expected["ok"] == json!(false) && parse_error {
            assert_eq!(stopped_reply, expected, "{name} (stopped)");
            if guard_device::route::ambiguous(&payload(case)) {
                assert_eq!(running_reply, json!({ "relayed": true }), "{name} (running)");
                assert_eq!(running.forwards, 1, "{name}");
            } else {
                assert_eq!(running_reply, expected, "{name} (running)");
                assert_eq!(running.forwards, 0, "{name}");
            }
        } else {
            let id = expected["id"].as_str().unwrap_or_else(|| panic!("{name}: a well-formed reply has an id"));
            assert_eq!(stopped_reply, json!({ "v": expected["v"], "id": id, "ok": false, "error": "appNotRunning" }), "{name}");
            assert_eq!(running_reply, json!({ "relayed": true }), "{name} (running)");
            assert_eq!(running.forwards, 1, "{name}");
        }
        checked += 1;
    }
    assert!(checked >= 70, "{checked}");
}

/// The `shim.json` cases with a `helperResponse` are bytes the two helper
/// parsers read differently (a byte-order mark, UTF-16, a trailing comma, a
/// repeated key). While the app runs, each one is relayed and the installed
/// helper's reply comes back unchanged; nothing is answered from this crate's
/// reading of it, and nothing starts the app.
#[test]
fn bytes_only_the_helper_can_read_are_relayed_while_the_app_runs() {
    let mut checked = 0;
    for case in fixture("shim.json")["cases"].as_array().unwrap() {
        if case.get("helperResponse").is_none() {
            continue;
        }
        let name = case["name"].as_str().unwrap();
        let frame = payload(case);
        assert!(guard_device::route::ambiguous(&frame), "{name}");
        let mut host = app("running");
        let reply = br#"{"from":"the installed helper"}"#.to_vec();
        host.reply = Some(reply.clone());
        assert_eq!(respond(&mut host, &frame, VERSION), reply, "{name}");
        assert_eq!((host.forwards, host.launches), (1, 0), "{name}");
        checked += 1;
    }
    assert!(checked >= 8, "{checked}");
}

/// What a helper without v9 answers to a well-formed v9 request; the wallet
/// reads it as "no Device Guard app" and behaves as before.
const PLAIN_HELPER_V9: &[u8] = br#"{"error":"unsupportedVersion","ok":false,"v":1}"#;

/// With `NETWORK_GUARD_SWIFT_HELPER` set to a compiled helper of the same
/// channel: every request the shim answers by itself (malformed, v9 included:
/// rejected before any provider) gets the same bytes from that helper, and a
/// well-formed v9 request gets `PLAIN_HELPER_V9`. A `shim.json` case with a
/// `helperResponse` (bytes only the helper reads unambiguously) gets that
/// response, which pins where the shim's own reading differs while the app is
/// down. Only these requests are sent, and those cases ask only for
/// `capabilities` or `describe`, so no provider is ever read or controlled.
#[test]
fn malformed_replies_match_the_compiled_helper_byte_for_byte() {
    use guard_device::route::{route, Route};
    use std::io::Write;
    use std::process::{Command, Stdio};
    let Some(helper) = std::env::var_os("NETWORK_GUARD_SWIFT_HELPER") else {
        eprintln!("skipped: set NETWORK_GUARD_SWIFT_HELPER to a compiled helper of this channel");
        return;
    };
    /// The router's bytes exactly, or a fixture's `helperResponse` as parsed JSON.
    enum Expect {
        Bytes(Vec<u8>),
        Json(Value),
    }
    let mut frames = Vec::new();
    let mut malformed_v9 = 0;
    let mut pinned = 0;
    for document in [fixture("router.json"), fixture("shim.json")] {
        for case in document["cases"].as_array().unwrap() {
            let frame = payload(case);
            let name = case["name"].as_str().unwrap().to_string();
            if let Some(response) = case.get("helperResponse") {
                pinned += 1;
                frames.push((name, frame, Expect::Json(tokens(response))));
                continue;
            }
            let v9 = network_guard::wire::object(&frame).and_then(|o| network_guard::wire::int(o.get("v"))) == Some(9);
            match route(&frame) {
                Route::V9 { .. } => frames.push((name, frame, Expect::Bytes(PLAIN_HELPER_V9.to_vec()))),
                Route::Reply(reply) => {
                    malformed_v9 += usize::from(v9);
                    frames.push((name, frame, Expect::Bytes(reply)));
                }
                Route::Forward(_) => {}
            }
        }
    }
    assert!(frames.len() >= 40, "{}", frames.len());
    assert!(malformed_v9 >= 6, "{malformed_v9}");
    assert!(pinned >= 8, "{pinned}");
    // Up to 128 frames per helper session; one session per frame keeps it simple.
    for (name, frame, expected) in frames {
        let mut child = Command::new(&helper)
            .arg(format!("chrome-extension://{}/", guard_device::EXTENSION_ID))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(&(frame.len() as u32).to_le_bytes()).unwrap();
        stdin.write_all(&frame).unwrap();
        drop(stdin);
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(0), "{name}");
        let reply = &output.stdout[4..];
        match expected {
            Expect::Bytes(bytes) => assert_eq!(reply, &bytes[..], "{name}: {}", String::from_utf8_lossy(reply)),
            Expect::Json(value) => assert_eq!(serde_json::from_slice::<Value>(reply).ok(), Some(value), "{name}"),
        }
    }
}
