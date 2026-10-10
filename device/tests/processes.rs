//! The real shim and app binaries in a temporary home, with a fake installed
//! helper (a shell script that frames like the real one). Never touches the
//! user's installation, socket, login items or browser registrations, and
//! leaves no run directory behind, even one outside the temporary home.
#![cfg(unix)]

use std::fs;
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use guard_device::identity::{CHANNEL, HELPER_RECEIPT_OWNER};
use guard_device::{EXTENSION_ID, VERSION};
use serde_json::{json, Value};

const SHIM: &str = env!("CARGO_BIN_EXE_anon-guard-host");
const APP: &str = env!("CARGO_BIN_EXE_anon-guard");
const ID: &str = "01234567-89ab-4def-8123-456789abcdef";
const ID2: &str = "fedcba98-7654-4321-8fed-cba987654321";

fn origin() -> String {
    format!("chrome-extension://{EXTENSION_ID}/")
}

/// A temporary home, removed (with any app it started) on drop.
struct Home {
    base: PathBuf,
}

impl Home {
    fn new(name: &str) -> Home {
        Home::under(&std::env::temp_dir(), &format!("guard-device-{name}-"))
    }

    /// `<parent>/<prefix><pid>`, for a home short enough to hold its own socket.
    fn under(parent: &Path, prefix: &str) -> Home {
        let base = parent.join(format!("{prefix}{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        for dir in ["home", "run"] {
            fs::create_dir_all(base.join(dir)).unwrap();
            fs::set_permissions(base.join(dir), fs::Permissions::from_mode(0o700)).unwrap();
        }
        Home { base: base.canonicalize().unwrap() }
    }

    fn home(&self) -> PathBuf {
        self.base.join("home")
    }

    fn env(&self, command: &mut Command) {
        command
            .env("HOME", self.home())
            .env("ANON_GUARD_NO_TRAY", "1")
            .env_remove("XDG_STATE_HOME")
            .env_remove("XDG_CONFIG_HOME")
            .env("XDG_RUNTIME_DIR", self.base.join("run"));
    }

    fn helper_root(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.home().join("Library/Application Support/Anon/NetworkHelper").join(CHANNEL)
        } else {
            self.home().join(".local/share/anon/network-guard").join(CHANNEL)
        }
    }

    /// A receipt and one helper version, laid out as the installer does. The
    /// helper checks the origin, answers with the request's id and counts runs.
    fn install_fake_helper(&self) -> PathBuf {
        let sha = "a".repeat(64);
        let root = self.helper_root();
        let dir = root.join("versions").join(format!("9.9.9-{sha}"));
        fs::create_dir_all(&dir).unwrap();
        let receipt = json!({ "schemaVersion": 1, "owner": HELPER_RECEIPT_OWNER, "channel": CHANNEL,
            "versions": [{ "schemaVersion": 1, "version": "9.9.9", "channel": CHANNEL, "sha256": sha }] });
        fs::write(root.join("installation.json"), receipt.to_string()).unwrap();
        let counter = self.base.join("helper-runs");
        let helper = dir.join("anon-network-helper");
        fs::write(
            &helper,
            format!(
                r#"#!/bin/sh
[ "$#" = 1 ] && [ "$1" = "{origin}" ] || exit 64
# One request, then EOF (the bridge closes stdin): skip the 4-byte length.
body=$(tail -c +5)
id=$(printf '%s' "$body" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | tr 'A-F' 'a-f')
v=$(printf '%s' "$body" | sed -n 's/.*"v":\([0-9]*\).*/\1/p')
n=$(($(cat "{counter}" 2>/dev/null || echo 0) + 1)); echo "$n" > "{counter}"
reply="{{\"id\":\"$id\",\"ok\":true,\"snapshot\":{{\"run\":$n}},\"v\":$v}}"
len=${{#reply}}
printf "$(printf '\\%03o\\%03o\\%03o\\%03o' $((len & 255)) $((len >> 8 & 255)) 0 0)"
printf '%s' "$reply"
"#,
                origin = origin(),
                counter = counter.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        helper
    }

    fn helper_runs(&self) -> u64 {
        fs::read_to_string(self.base.join("helper-runs")).map(|t| t.trim().parse().unwrap()).unwrap_or(0)
    }

    fn app_cli(&self, app: &Path, op: &str) -> Option<Value> {
        let mut command = Command::new(app);
        self.env(&mut command);
        let output = command.arg(op).output().unwrap();
        serde_json::from_slice(&output.stdout).ok()
    }

    fn app_running(&self) -> bool {
        self.app_cli(Path::new(APP), "status").is_some_and(|s| s["ok"] == json!(true))
    }

    fn wait_for(&self, want: bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if self.app_running() == want {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// The app's run directory for this home, as the app itself derives it. A
    /// long home puts it in the per-user temporary folder, outside `base`.
    fn run_dir(&self) -> Option<PathBuf> {
        self.app_cli(Path::new(APP), "paths")?.get("runDir")?.as_str().map(PathBuf::from)
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let run = self.run_dir();
        let _ = self.app_cli(Path::new(APP), "quit");
        let _ = fs::remove_dir_all(&self.base);
        // Only ever this home's: the name carries a hash of it.
        if let Some(run) = run {
            let _ = fs::remove_dir_all(run);
        }
    }
}

/// One shim process, as Chrome runs it for a port.
struct Port {
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<Value>,
}

impl Port {
    fn open(home: &Home, shim: &Path) -> Port {
        let mut command = Command::new(shim);
        home.env(&mut command);
        let mut child = command.arg(origin()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        let input = child.stdin.take().unwrap();
        let mut output: ChildStdout = child.stdout.take().unwrap();
        let (sender, replies) = mpsc::channel();
        std::thread::spawn(move || loop {
            let mut header = [0u8; 4];
            if output.read_exact(&mut header).is_err() {
                return;
            }
            let mut body = vec![0u8; u32::from_le_bytes(header) as usize];
            output.read_exact(&mut body).unwrap();
            if sender.send(serde_json::from_slice(&body).unwrap()).is_err() {
                return;
            }
        });
        Port { child, input, replies }
    }

    fn send(&mut self, request: &Value) {
        self.send_bytes(request.to_string().as_bytes());
    }

    fn send_bytes(&mut self, body: &[u8]) {
        self.input.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
        self.input.write_all(body).unwrap();
        self.input.flush().unwrap();
    }

    fn reply(&self, within: Duration) -> Value {
        self.replies.recv_timeout(within).expect("a reply")
    }

    fn call(&mut self, request: Value) -> Value {
        self.send(&request);
        self.reply(Duration::from_secs(15))
    }

    fn close(mut self) -> i32 {
        drop(self.input);
        self.child.wait().unwrap().code().unwrap_or(-1)
    }
}

fn request(v: i64, method: &str) -> Value {
    json!({ "v": v, "id": ID, "method": method })
}

fn not_running(v: i64) -> Value {
    json!({ "v": v, "id": ID, "ok": false, "error": "appNotRunning" })
}

#[test]
fn app_down_v9_answers_and_nothing_starts_it() {
    let home = Home::new("down");
    home.install_fake_helper();
    let mut port = Port::open(&home, Path::new(SHIM));
    let status = port.call(request(9, "appStatus"));
    assert_eq!(status["ok"], json!(true));
    assert_eq!(status["app"]["running"], json!(false));
    assert_eq!(status["app"]["version"], Value::Null);
    assert_eq!(status["shim"]["version"], json!(VERSION));
    for (v, method) in [(1, "status"), (8, "describe"), (4, "describe")] {
        assert_eq!(port.call(request(v, method)), not_running(v));
    }
    let probe = port.call(json!({ "v": 3, "id": ID, "method": "probe", "provider": "mullvad" }));
    assert_eq!(probe, not_running(3));
    assert_eq!(port.close(), 0);
    assert!(!home.app_running(), "a background request started the app");
    assert_eq!(home.helper_runs(), 0);
}

#[test]
fn open_app_then_the_bridge_relays_and_caches_reads() {
    let home = Home::new("bridge");
    home.install_fake_helper();
    let mut port = Port::open(&home, Path::new(SHIM));
    let opened = port.call(request(9, "openApp"));
    assert_eq!(
        opened,
        json!({ "v": 9, "id": ID, "ok": true, "app": { "running": true, "version": VERSION, "startAtLogin": opened["app"]["startAtLogin"] } })
    );
    let status = port.call(request(9, "appStatus"));
    assert_eq!(status["app"]["running"], json!(true));
    assert_eq!(status["app"]["version"], json!(VERSION));
    // Relayed from the helper, then served from the cache with the new id.
    let first = port.call(request(1, "status"));
    assert_eq!(first, json!({ "id": ID, "ok": true, "snapshot": { "run": 1 }, "v": 1 }));
    let second = port.call(json!({ "v": 1, "id": ID2.to_uppercase(), "method": "status" }));
    assert_eq!(second, json!({ "id": ID2, "ok": true, "snapshot": { "run": 1 }, "v": 1 }));
    assert_eq!(home.helper_runs(), 1);
    // A mutation is never cached and clears reads.
    let connect = port.call(json!({ "v": 3, "id": ID, "method": "connectSelected", "provider": "mullvad" }));
    assert_eq!(connect["snapshot"]["run"], json!(2));
    assert_eq!(port.call(request(1, "status"))["snapshot"]["run"], json!(3));
    // Malformed requests keep the router's envelope and never reach the helper.
    assert_eq!(port.call(json!({ "v": 1, "id": ID, "method": "exec" })), json!({ "v": 1, "ok": false, "error": "unsupportedMethod" }));
    assert_eq!(home.helper_runs(), 3);
    assert_eq!(port.close(), 0);

    // A fresh one-shot port reaches the same app; the app outlives the shim.
    let mut once = Port::open(&home, Path::new(SHIM));
    assert_eq!(once.call(request(8, "describe"))["v"], json!(8));
    assert_eq!(once.close(), 0);
    let status = home.app_cli(Path::new(APP), "status").unwrap();
    assert_eq!(status["launchedBy"], json!("shim"));
    assert!(status["bridge"]["resolved"]["helper"].as_str().unwrap().ends_with("anon-network-helper"));
    assert_eq!(status["bridge"]["cacheHits"], json!(1));

    // Quit: requests are appNotRunning again, and nothing restarts it.
    home.app_cli(Path::new(APP), "quit");
    assert!(home.wait_for(false));
    let mut after = Port::open(&home, Path::new(SHIM));
    assert_eq!(after.call(request(1, "status")), not_running(1));
    assert_eq!(after.close(), 0);
    assert!(!home.app_running());
}

/// A socket in a run directory that other users can enter is never trusted,
/// even when something there answers the hello: on a shared `/tmp` that
/// directory may be another user's. (The other half, a server running as
/// another user, is the peer UID check; exercising it needs a second account.)
#[test]
fn shim_trusts_only_a_private_run_directory() {
    // Short enough that the run directory is `<support>/run` on macOS too.
    let home = Home::under(Path::new("/tmp"), "gq");
    let run = if cfg!(target_os = "macos") {
        home.home().join("Library/Application Support/Anon/DeviceGuard").join(CHANNEL).join("run")
    } else {
        home.base.join("run").join(format!("anon-device-guard-{CHANNEL}"))
    };
    fs::create_dir_all(&run).unwrap();
    fs::set_permissions(&run, fs::Permissions::from_mode(0o755)).unwrap();
    let listener = UnixListener::bind(run.join("guard.sock")).unwrap();
    // A forged app: completes the hello, then reports a connected tunnel.
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(mut conn) = conn else { return };
            std::thread::spawn(move || {
                let mut hello = true;
                loop {
                    let mut header = [0u8; 4];
                    if conn.read_exact(&mut header).is_err() {
                        return;
                    }
                    let mut body = vec![0u8; u32::from_ne_bytes(header) as usize];
                    if conn.read_exact(&mut body).is_err() {
                        return;
                    }
                    let reply = if std::mem::take(&mut hello) {
                        json!({ "ipc": 1, "app": "forged" })
                    } else {
                        json!({ "v": 1, "id": ID, "ok": true, "snapshot": { "tunnel": "connected" } })
                    };
                    let reply = reply.to_string();
                    let _ = conn.write_all(&(reply.len() as u32).to_ne_bytes());
                    let _ = conn.write_all(reply.as_bytes());
                }
            });
        }
    });

    let mut port = Port::open(&home, Path::new(SHIM));
    let status = port.call(request(9, "appStatus"));
    assert_eq!((&status["app"]["running"], &status["app"]["version"]), (&json!(false), &Value::Null), "{status}");
    assert_eq!(port.call(request(1, "status")), not_running(1));
    assert_eq!(port.close(), 0);

    // The same server in an owner-only directory is the user's own, and is trusted.
    fs::set_permissions(&run, fs::Permissions::from_mode(0o700)).unwrap();
    let mut port = Port::open(&home, Path::new(SHIM));
    assert_eq!(port.call(request(9, "appStatus"))["app"]["version"], json!("forged"));
    assert_eq!(port.call(request(1, "status"))["snapshot"]["tunnel"], json!("connected"));
    assert_eq!(port.close(), 0);
}

#[test]
fn bridge_without_an_installed_helper_fails_closed() {
    let home = Home::new("nohelper");
    let mut port = Port::open(&home, Path::new(SHIM));
    assert_eq!(port.call(request(9, "openApp"))["ok"], json!(true));
    assert_eq!(port.call(request(1, "status")), json!({ "v": 1, "id": ID, "ok": false, "error": "providerUnavailable" }));
    assert_eq!(port.close(), 0);
}

/// A shim whose sibling "app" never answers: openApp holds the starting lock
/// for the whole 10 s wait. Meanwhile the same port and another shim see
/// appStarting, and the launch ends in appStartFailed.
#[test]
fn requests_during_a_launch_get_app_starting() {
    let home = Home::new("starting");
    let bin = home.base.join("bin");
    fs::create_dir_all(&bin).unwrap();
    let shim = bin.join("anon-guard-host");
    fs::copy(SHIM, &shim).unwrap();
    let stub = bin.join("anon-guard");
    fs::write(&stub, "#!/bin/sh\nsleep 12\n").unwrap();
    fs::set_permissions(&stub, fs::Permissions::from_mode(0o700)).unwrap();

    let mut launcher = Port::open(&home, &shim);
    // Both frames at once: the second is handled while the first launches.
    launcher.send(&request(9, "openApp"));
    launcher.send(&json!({ "v": 1, "id": ID2, "method": "status" }));
    // Same port: answered before the launch's own reply. (A freshly copied
    // binary can take seconds to start the first time on macOS.)
    assert_eq!(launcher.reply(Duration::from_secs(8)), json!({ "v": 1, "id": ID2, "ok": false, "error": "appStarting" }));
    let started = Instant::now();
    // Another shim (another one-shot message).
    let mut other = Port::open(&home, &shim);
    assert_eq!(other.call(request(8, "describe")), json!({ "v": 8, "id": ID, "ok": false, "error": "appStarting" }));
    assert_eq!(other.call(request(9, "openApp")), json!({ "v": 9, "id": ID, "ok": false, "error": "appStarting" }));
    assert_eq!(other.call(request(9, "appStatus"))["app"]["running"], json!(false));
    assert_eq!(other.close(), 0);
    let failed = launcher.reply(Duration::from_secs(15));
    assert_eq!(failed, json!({ "v": 9, "id": ID, "ok": false, "error": "appStartFailed" }));
    assert!(started.elapsed() >= Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(launcher.close(), 0);
    // The lock is free again.
    let mut after = Port::open(&home, &shim);
    assert_eq!(after.call(request(1, "status")), not_running(1));
    assert_eq!(after.close(), 0);
}

#[test]
fn shim_refuses_unenrolled_callers_and_broken_frames_like_the_helper() {
    let home = Home::new("refuse");
    for args in [vec!["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/".to_string()], vec![], vec![origin(), "extra".into()]] {
        let mut command = Command::new(SHIM);
        home.env(&mut command);
        let output = command.args(&args).stdin(Stdio::null()).output().unwrap();
        assert_eq!(output.status.code(), Some(64), "{args:?}");
        assert!(output.stdout.is_empty());
    }
    for input in [vec![1u8, 16, 0, 0], vec![3, 0], vec![3, 0, 0, 0, 65], vec![0, 0, 0, 0]] {
        let mut command = Command::new(SHIM);
        home.env(&mut command);
        let mut child = command.arg(origin()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(65), "{input:?}");
        assert!(output.stdout.is_empty());
    }
    let manifest = Command::new(SHIM).arg("--print-host-manifest").output().unwrap();
    let manifest: Value = serde_json::from_slice(&manifest.stdout).unwrap();
    assert_eq!(manifest["allowed_origins"], json!([origin()]));
    assert_eq!(manifest["path"], json!(Path::new(SHIM).canonicalize().unwrap().to_str().unwrap()));
}

#[test]
fn one_app_per_user() {
    let home = Home::new("single");
    let copies: Vec<Child> = (0..4)
        .map(|_| {
            let mut command = Command::new(APP);
            home.env(&mut command);
            command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().unwrap()
        })
        .collect();
    assert!(home.wait_for(true));
    std::thread::sleep(Duration::from_millis(500));
    let mut exited = 0;
    let mut running = Vec::new();
    for mut child in copies {
        match child.try_wait().unwrap() {
            Some(_) => {
                let mut stderr = String::new();
                child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();
                assert!(stderr.contains("already running"), "{stderr}");
                exited += 1;
            }
            None => running.push(child),
        }
    }
    assert_eq!((exited, running.len()), (3, 1));
    let status = home.app_cli(Path::new(APP), "status").unwrap();
    assert_eq!(status["pid"], json!(running[0].id()));
    home.app_cli(Path::new(APP), "quit");
    assert!(running.pop().unwrap().wait().unwrap().success());
}

/// Stops a process for as long as it lives (a deadlock or a debugger looks the
/// same to the shim), and lets it run again on drop.
struct Stopped(u64);

impl Stopped {
    fn new(pid: u64) -> Stopped {
        assert!(Command::new("kill").args(["-STOP", &pid.to_string()]).status().unwrap().success());
        Stopped(pid)
    }
}

impl Drop for Stopped {
    fn drop(&mut self) {
        let _ = Command::new("kill").args(["-CONT", &self.0.to_string()]).status();
    }
}

/// An app that is alive but answers nothing must not stall the wallet: the
/// shim gives up on its hello in about 2 s, says it is not running, and never
/// retries into the hang. openApp waits up to 10 s for it, then fails.
#[test]
fn a_hung_app_is_reported_quickly() {
    let home = Home::new("hung");
    home.install_fake_helper();
    let mut launcher = Port::open(&home, Path::new(SHIM));
    assert_eq!(launcher.call(request(9, "openApp"))["ok"], json!(true));
    assert_eq!(launcher.close(), 0);
    let pid = home.app_cli(Path::new(APP), "status").unwrap()["pid"].as_u64().unwrap();
    let stopped = Stopped::new(pid);

    let quick = Duration::from_secs(6);
    let mut port = Port::open(&home, Path::new(SHIM));
    port.send(&request(9, "appStatus"));
    let status = port.reply(quick);
    assert_eq!((&status["app"]["running"], &status["app"]["version"]), (&json!(false), &Value::Null), "{status}");
    for (v, method) in [(1, "status"), (8, "describe")] {
        port.send(&request(v, method));
        assert_eq!(port.reply(quick), not_running(v));
    }
    let started = Instant::now();
    let cli = home.app_cli(Path::new(APP), "status").unwrap();
    assert_eq!(cli, json!({ "ok": false, "error": "appUnresponsive" }));
    assert!(started.elapsed() < quick, "{:?}", started.elapsed());

    // Waits for the live copy rather than starting another, then gives up.
    let started = Instant::now();
    port.send(&request(9, "openApp"));
    assert_eq!(port.reply(Duration::from_secs(16)), json!({ "v": 9, "id": ID, "ok": false, "error": "appStartFailed" }));
    assert!(started.elapsed() >= Duration::from_secs(8), "{:?}", started.elapsed());
    assert_eq!(home.helper_runs(), 0);

    drop(stopped);
    assert_eq!(port.call(request(9, "appStatus"))["app"]["running"], json!(true));
    assert_eq!(home.app_cli(Path::new(APP), "status").unwrap()["pid"], json!(pid));
    assert_eq!(port.close(), 0);
}

/// Bytes the shim's parser can't read unambiguously are the installed helper's
/// to answer while the app runs: Foundation reads a byte-order mark (serde_json
/// does not), and the two keep different copies of a repeated key. Such a
/// frame is never answered from the bridge's cache.
#[test]
fn bytes_only_the_helper_can_read_are_relayed_while_the_app_runs() {
    let home = Home::new("ambiguous");
    home.install_fake_helper();
    let bom = [b"\xef\xbb\xbf".as_slice(), request(1, "capabilities").to_string().as_bytes()].concat();
    let repeated = format!(r#"{{"v":1,"id":"{ID2}","method":"status","id":"{ID}"}}"#);
    let mut port = Port::open(&home, Path::new(SHIM));
    // The app is down: the shim keeps its router's envelope.
    port.send_bytes(&bom);
    assert_eq!(port.reply(Duration::from_secs(15)), json!({ "v": 1, "ok": false, "error": "invalidRequest" }));
    assert_eq!(port.call(request(9, "openApp"))["ok"], json!(true));
    port.send_bytes(&bom);
    assert_eq!(port.reply(Duration::from_secs(15)), json!({ "id": ID, "ok": true, "snapshot": { "run": 1 }, "v": 1 }));
    for run in [2, 3] {
        port.send_bytes(repeated.as_bytes());
        assert_eq!(port.reply(Duration::from_secs(15))["snapshot"]["run"], json!(run));
    }
    assert_eq!(home.helper_runs(), 3);
    assert_eq!(port.close(), 0);
}

/// A home too long for a socket path puts the app's run directory in the
/// per-user temporary folder. Dropping the home removes it too.
#[test]
fn a_test_home_leaves_no_run_directory_behind() {
    let home = Home::new("run-directory");
    let run = home.run_dir().expect("anon-guard paths names the run directory");
    let mut port = Port::open(&home, Path::new(SHIM));
    assert_eq!(port.call(request(9, "openApp"))["ok"], json!(true));
    assert_eq!(port.close(), 0);
    assert!(run.join("guard.lock").is_file(), "{}", run.display());
    if cfg!(target_os = "macos") {
        assert!(!run.starts_with(&home.base), "{} is inside the home", run.display());
    }
    drop(home);
    assert!(!run.exists(), "{} outlived its home", run.display());
}
