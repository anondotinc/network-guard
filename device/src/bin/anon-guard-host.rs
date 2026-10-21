//! The Chrome native-messaging host for the Device Guard app. Chrome starts it
//! with the caller's origin; it answers v9 itself, relays v1–v8 to the app and
//! only starts the app for v9 `openApp`, a user's click. Framing, the origin
//! check and their exit codes match the helper's: 64 for an unenrolled
//! caller, 65 for broken framing, with nothing on stdout.
use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};

use guard_device::route::{self, Route, V9Method};
use guard_device::shim::{self, LaunchDispatched, LiveHost};
use guard_device::{EXTENSION_ID, VERSION};
use network_guard::{frames, manifest, origin};

fn fail(message: &str, code: u8) -> ExitCode {
    let _ = io::stderr().write_all(message.as_bytes());
    ExitCode::from(code)
}

fn write(output: &Mutex<io::Stdout>, reply: &[u8]) -> bool {
    let Ok(frame) = frames::encode(reply) else { return false };
    let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
    output.write_all(&frame).and_then(|_| output.flush()).is_ok()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--version"] {
        println!("{VERSION} {}", guard_device::CHANNEL);
        return ExitCode::SUCCESS;
    }
    if args == ["--print-host-manifest"] {
        let path = std::env::current_exe().and_then(|path| path.canonicalize());
        let text = |path: std::path::PathBuf| path.to_str().map(|text| text.strip_prefix(r"\\?\").unwrap_or(text).to_string());
        return match path.ok().and_then(text).and_then(|path| manifest::host(&path).ok()) {
            Some(value) => {
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
                ExitCode::SUCCESS
            }
            None => fail("Cannot prepare host manifest.\n", 64),
        };
    }
    let Some(caller) = origin::caller_origin(&args).filter(|caller| origin::accepts(caller, &[EXTENSION_ID])) else {
        return fail("Native caller is not enrolled.\n", 64);
    };
    let caller = caller.to_string();
    let output = Arc::new(Mutex::new(io::stdout()));
    let mut host = LiveHost::new(&caller);
    let mut launches = Vec::new();
    let mut input = io::stdin().lock();
    let code = loop {
        let frame = match frames::read(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break ExitCode::SUCCESS,
            // No raw frame or error contents on stderr or stdout.
            Err(_) => break fail("Native protocol ended.\n", 65),
        };
        // openApp waits up to 10 s; other requests on this port keep flowing
        // meanwhile (and see appStarting). Replies carry their request's id.
        if matches!(route::route(&frame), Route::V9 { method: V9Method::OpenApp, .. }) {
            let (caller, output, dispatched) = (caller.clone(), output.clone(), LaunchDispatched::new());
            launches.push(std::thread::spawn(move || {
                let reply = shim::respond(&mut LiveHost::launcher(&caller), &frame, VERSION);
                drop(dispatched);
                write(&output, &reply)
            }));
            continue;
        }
        if !write(&output, &shim::respond(&mut host, &frame, VERSION)) {
            break fail("Native protocol ended.\n", 65);
        }
    };
    for launch in launches {
        let _ = launch.join();
    }
    code
}
