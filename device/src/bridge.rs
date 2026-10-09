//! Bridge mode: the app answers v1–v8 by delegating each request to the
//! installed helper, framed exactly as Chrome frames it (`<helper> <origin>`,
//! a 4-byte little-endian length, the request bytes, then EOF), one helper
//! process per request. The helper's reply bytes are relayed unchanged.
//!
//! The helper is found from its installer's root, never a fixed path: the
//! receipt (`installation.json`) lists the installed versions, and
//! `bridge.json` in the app's support directory names the one to use (else
//! the newest). The file must be a regular file the user owns.
//!
//! Reads (status, probe, describe, capabilities) are cached for at most
//! `CACHE_TTL`, measured from when the helper ran; a hit never extends an
//! entry, so a reply is never more than 5 s older than the helper's read, well
//! inside the wallet's 45 s status TTL. A hit is the helper's own bytes with
//! only the 36-character request id replaced. Only `ok:true` replies are
//! kept. A connect or app launch clears the cache, and a read that overlapped
//! one is not stored.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use network_guard::error::HelperError;
use network_guard::wire::failure;
use serde_json::{json, Value};

use crate::identity::{self, CHANNEL, HELPER_EXE, HELPER_RECEIPT_OWNER};
use crate::route::{self, Forward, Route};

pub const CACHE_TTL: Duration = Duration::from_secs(5);
/// Longer than any provider deadline in the helper (status reads have 3 s).
pub const HELPER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REPLY: u64 = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeError {
    /// No installed helper for this channel, or not one we can use.
    NotInstalled,
    Spawn,
    Timeout,
    /// The helper ended without one well-framed reply (for example, it refused the origin).
    NoReply,
}

/// Runs one request through a helper. Tests substitute their own.
pub trait Runner: Send + Sync {
    fn run(&self, origin: &str, frame: &[u8]) -> Result<Vec<u8>, BridgeError>;
}

/// The installed helper, found fresh for every request.
pub struct HelperRunner;

impl Runner for HelperRunner {
    fn run(&self, origin: &str, frame: &[u8]) -> Result<Vec<u8>, BridgeError> {
        let helper = resolve_helper().map_err(|_| BridgeError::NotInstalled)?;
        run_helper(&helper, origin, frame, HELPER_TIMEOUT)
    }
}

type Key = (String, i64, String, Option<String>);

struct Entry {
    reply: Vec<u8>,
    id: String,
    at: Instant,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<Key, Entry>,
    /// Bumped around every mutation; a read stores its reply only if it is unchanged.
    generation: u64,
}

#[derive(Default)]
pub struct Stats {
    pub helper_runs: AtomicU64,
    pub cache_hits: AtomicU64,
    pub failures: AtomicU64,
}

pub struct Bridge<R: Runner = HelperRunner> {
    runner: R,
    cache: Mutex<Cache>,
    pub stats: Stats,
}

impl Default for Bridge<HelperRunner> {
    fn default() -> Self {
        Bridge::new(HelperRunner)
    }
}

impl<R: Runner> Bridge<R> {
    pub fn new(runner: R) -> Self {
        Bridge { runner, cache: Mutex::new(Cache::default()), stats: Stats::default() }
    }

    pub fn respond(&self, origin: &str, frame: &[u8]) -> Vec<u8> {
        self.respond_at(origin, frame, Instant::now())
    }

    /// `now` is injectable so tests can age the cache without sleeping.
    pub fn respond_at(&self, origin: &str, frame: &[u8], now: Instant) -> Vec<u8> {
        let route = route::route(frame);
        let request = match &route {
            // v9 is the shim's. Reaching the app, it gets what a helper without v9 says.
            Route::V9 { .. } => return route::encode(&failure(1, None, HelperError::UnsupportedVersion)),
            Route::Forward(request) => Some(request),
            Route::Reply(_) => None,
        };
        let key: Option<Key> = request.filter(|r| r.is_read()).map(|r| (origin.to_string(), r.v, r.method.clone(), r.provider.clone()));
        let mutation = request.is_some_and(Forward::is_mutation);
        let generation = {
            let mut cache = self.cache.lock().unwrap();
            if let (Some(key), Some(request)) = (&key, request) {
                match cache.entries.get(key) {
                    Some(entry) if now.saturating_duration_since(entry.at) < CACHE_TTL => {
                        if let Some(reply) = route::swap_id(&entry.reply, &entry.id, &request.id) {
                            self.stats.cache_hits.fetch_add(1, Ordering::Relaxed);
                            return reply;
                        }
                    }
                    Some(_) => {
                        cache.entries.remove(key);
                    }
                    None => {}
                }
            }
            if mutation {
                cache.entries.clear();
                cache.generation += 1;
            }
            cache.generation
        };
        self.stats.helper_runs.fetch_add(1, Ordering::Relaxed);
        let result = self.runner.run(origin, frame);
        let mut cache = self.cache.lock().unwrap();
        if mutation {
            cache.entries.clear();
            cache.generation += 1;
        }
        match result {
            Ok(reply) => {
                if let (Some(key), Some(request)) = (key, request) {
                    if cache.generation == generation && route::reply_ok_with_id(&reply, &request.id) {
                        cache.entries.insert(key, Entry { reply: reply.clone(), id: request.id.clone(), at: now });
                    }
                }
                reply
            }
            Err(_) => {
                self.stats.failures.fetch_add(1, Ordering::Relaxed);
                match route {
                    // The helper can't answer: fail closed with an allowlisted code.
                    Route::Forward(request) => request.failure(HelperError::ProviderUnavailable.code()),
                    // Malformed: the router's envelope is the helper's answer anyway.
                    Route::Reply(bytes) => bytes,
                    Route::V9 { .. } => unreachable!(),
                }
            }
        }
    }

    pub fn cache_entries(&self) -> usize {
        self.cache.lock().unwrap().entries.len()
    }
}

/// Chrome's way: `<helper> <origin>`, one framed request on stdin, then EOF;
/// one framed reply on stdout. The helper's stderr is discarded.
pub fn run_helper(helper: &Path, origin: &str, frame: &[u8], timeout: Duration) -> Result<Vec<u8>, BridgeError> {
    let mut command = Command::new(helper);
    command.arg(origin).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The app is a GUI binary; a console helper would otherwise flash a window.
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| BridgeError::Spawn)?;
    if let Some(mut stdin) = child.stdin.take() {
        // A helper that refuses the caller exits at once; the write then fails, harmlessly.
        let _ = stdin.write_all(&(frame.len() as u32).to_le_bytes()).and_then(|_| stdin.write_all(frame));
    }
    let mut stdout = child.stdout.take().ok_or(BridgeError::Spawn)?;
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let _ = (&mut stdout).take(MAX_REPLY).read_to_end(&mut output);
        let _ = sender.send(output);
    });
    let output = match receiver.recv_timeout(timeout) {
        Ok(output) => output,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(BridgeError::Timeout);
        }
    };
    let _ = child.wait();
    one_frame(&output).ok_or(BridgeError::NoReply)
}

/// Exactly one frame of 1–4096 bytes, nothing else.
fn one_frame(output: &[u8]) -> Option<Vec<u8>> {
    let header: [u8; 4] = output.get(..4)?.try_into().ok()?;
    let length = network_guard::frames::length(header).ok()?;
    (output.len() == 4 + length).then(|| output[4..].to_vec())
}

fn read_small(path: &Path, limit: u64) -> Result<Vec<u8>, &'static str> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "missing")?;
    if !metadata.file_type().is_file() || metadata.len() == 0 || metadata.len() > limit {
        return Err("not a regular file");
    }
    std::fs::read(path).map_err(|_| "unreadable")
}

fn is_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('.').collect();
    value.len() <= 32 && parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The installed versions' directory names (`<version>-<sha256>`), oldest first,
/// from the installer's receipt for this channel.
pub fn installed_versions() -> Result<Vec<String>, &'static str> {
    let bytes = read_small(&identity::helper_root().join("installation.json"), 64 * 1024)?;
    let receipt: Value = serde_json::from_slice(&bytes).map_err(|_| "receipt is not JSON")?;
    if receipt["schemaVersion"] != json!(1) || receipt["owner"] != json!(HELPER_RECEIPT_OWNER) || receipt["channel"] != json!(CHANNEL) {
        return Err("receipt is not this channel's installer's");
    }
    receipt["versions"]
        .as_array()
        .ok_or("receipt has no versions")?
        .iter()
        .map(|entry| match (entry["version"].as_str(), entry["sha256"].as_str()) {
            (Some(version), Some(sha256)) if is_version(version) && is_digest(sha256) => Ok(format!("{version}-{sha256}")),
            _ => Err("receipt has an invalid version"),
        })
        .collect()
}

/// `{"schemaVersion":1,"helper":"<version>-<sha256>"}`, when present and valid.
fn bridge_choice() -> Option<String> {
    let bytes = read_small(&identity::bridge_file(), 4096).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    (value["schemaVersion"] == json!(1)).then(|| value["helper"].as_str().map(str::to_string))?
}

/// The helper executable the bridge runs.
pub fn resolve_helper() -> Result<PathBuf, &'static str> {
    let versions = installed_versions()?;
    let chosen = match bridge_choice() {
        Some(choice) if versions.contains(&choice) => choice,
        Some(_) => return Err("bridge.json names a version that is not installed"),
        None => versions.last().cloned().ok_or("no installed version")?,
    };
    let helper = identity::helper_root().join("versions").join(chosen).join(HELPER_EXE);
    let metadata = std::fs::symlink_metadata(&helper).map_err(|_| "helper missing")?;
    if !metadata.file_type().is_file() {
        return Err("helper is not a regular file");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no failure mode.
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err("helper is not owned by this user or is writable by others");
        }
    }
    Ok(helper)
}

/// For `anon-guard status`.
pub fn describe_helper() -> Value {
    match resolve_helper() {
        Ok(path) => json!({ "helper": path.to_string_lossy(), "error": null }),
        Err(error) => json!({ "helper": null, "error": error }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

    /// Answers like the helper: sorted keys, the lowercased id, a counter in the snapshot.
    struct Fake {
        runs: AtomicUsize,
        fail: bool,
    }

    impl Runner for Fake {
        fn run(&self, _: &str, frame: &[u8]) -> Result<Vec<u8>, BridgeError> {
            let run = self.runs.fetch_add(1, Ordering::SeqCst);
            if self.fail {
                return Err(BridgeError::NotInstalled);
            }
            let request: Value = serde_json::from_slice(frame).unwrap();
            let id = request["id"].as_str().unwrap().to_ascii_lowercase();
            Ok(format!(r#"{{"id":"{id}","ok":true,"snapshot":{{"run":{run}}},"v":{}}}"#, request["v"]).into_bytes())
        }
    }

    fn bridge(fail: bool) -> Bridge<Fake> {
        Bridge::new(Fake { runs: AtomicUsize::new(0), fail })
    }

    fn request(v: i64, id: &str, method: &str, provider: Option<&str>) -> Vec<u8> {
        let mut value = json!({ "v": v, "id": id, "method": method });
        if let Some(provider) = provider {
            value["provider"] = json!(provider);
        }
        value.to_string().into_bytes()
    }

    const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000B";

    #[test]
    fn reads_are_reused_for_five_seconds_with_the_new_id() {
        let bridge = bridge(false);
        let t0 = Instant::now();
        let first = bridge.respond_at(ORIGIN, &request(1, A, "status", None), t0);
        let second = bridge.respond_at(ORIGIN, &request(1, B, "status", None), t0 + Duration::from_millis(4900));
        assert_eq!(bridge.runner.runs.load(Ordering::SeqCst), 1);
        assert_eq!(String::from_utf8(second).unwrap(), String::from_utf8(first).unwrap().replace(A, &B.to_ascii_lowercase()));
        // Five seconds after the helper ran, a hit is not allowed even though a hit happened at 4.9 s.
        bridge.respond_at(ORIGIN, &request(1, A, "status", None), t0 + CACHE_TTL);
        assert_eq!(bridge.runner.runs.load(Ordering::SeqCst), 2);
        assert_eq!(bridge.stats.cache_hits.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn keys_separate_versions_providers_and_methods() {
        let bridge = bridge(false);
        let t0 = Instant::now();
        for frame in [
            request(1, A, "status", None),
            request(3, A, "status", Some("ivpn")),
            request(3, A, "status", Some("mullvad")),
            request(3, A, "probe", Some("ivpn")),
            request(8, A, "describe", None),
        ] {
            bridge.respond_at(ORIGIN, &frame, t0);
        }
        assert_eq!(bridge.runner.runs.load(Ordering::SeqCst), 5);
        assert_eq!(bridge.cache_entries(), 5);
    }

    #[test]
    fn mutations_are_never_cached_and_clear_reads() {
        let bridge = bridge(false);
        let t0 = Instant::now();
        bridge.respond_at(ORIGIN, &request(3, A, "status", Some("ivpn")), t0);
        bridge.respond_at(ORIGIN, &request(3, A, "connectSelected", Some("ivpn")), t0);
        bridge.respond_at(ORIGIN, &request(3, A, "connectSelected", Some("ivpn")), t0);
        assert_eq!(bridge.cache_entries(), 0);
        bridge.respond_at(ORIGIN, &request(3, A, "status", Some("ivpn")), t0);
        assert_eq!(bridge.runner.runs.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn failures_fail_closed_and_malformed_requests_keep_their_envelope() {
        let bridge = bridge(true);
        let reply: Value = serde_json::from_slice(&bridge.respond(ORIGIN, &request(1, B, "status", None))).unwrap();
        assert_eq!(reply, json!({ "v": 1, "id": B.to_ascii_lowercase(), "ok": false, "error": "providerUnavailable" }));
        let malformed: Value = serde_json::from_slice(&bridge.respond(ORIGIN, &request(1, A, "exec", None))).unwrap();
        assert_eq!(malformed, json!({ "v": 1, "ok": false, "error": "unsupportedMethod" }));
        assert_eq!(bridge.cache_entries(), 0);
        let v9: Value = serde_json::from_slice(&bridge.respond(ORIGIN, &request(9, A, "appStatus", None))).unwrap();
        assert_eq!(v9, json!({ "v": 1, "ok": false, "error": "unsupportedVersion" }));
    }

    #[test]
    fn one_frame_means_exactly_one() {
        assert_eq!(one_frame(&[2, 0, 0, 0, b'{', b'}']), Some(b"{}".to_vec()));
        assert_eq!(one_frame(&[2, 0, 0, 0, b'{']), None);
        assert_eq!(one_frame(&[2, 0, 0, 0, b'{', b'}', 0]), None);
        assert_eq!(one_frame(&[0, 0, 0, 0]), None);
        assert_eq!(one_frame(&[]), None);
    }
}
