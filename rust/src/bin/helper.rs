//! The native-messaging host Chrome launches. No daemon, no network, no
//! telemetry: it answers at most 128 frames on stdin and exits.
use network_guard::{build_info, frames, manifest, origin};
use std::io::Write;
use std::process::ExitCode;

#[cfg(target_os = "linux")]
fn respond(payload: &[u8]) -> Vec<u8> {
    use network_guard::platform::linux::{adapters::Live, lock};
    use network_guard::router::Router;
    let live = Live::new();
    Router { adapters: &live, legacy_control: &live, control_enabled: build_info::SUPPORTS_CONNECTION_CONTROL, lock: lock::connection }
        .respond(payload)
}

#[cfg(not(target_os = "linux"))]
fn respond(_: &[u8]) -> Vec<u8> {
    unimplemented!("Network Guard for this platform ships from the Swift package or a later packet")
}

fn fail(message: &str, code: u8) -> ExitCode {
    let _ = std::io::stderr().write_all(message.as_bytes());
    ExitCode::from(code)
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == ["--print-host-manifest"] {
        let path = std::env::current_exe().and_then(|path| path.canonicalize());
        return match path.ok().and_then(|path| manifest::host(path.to_str()?).ok()) {
            Some(value) => {
                println!("{}", serde_json::to_string_pretty(&value).unwrap());
                ExitCode::SUCCESS
            }
            None => fail("Cannot prepare host manifest.\n", 64),
        };
    }
    if args == ["--inspect"] {
        // Read-only local check: one v1 status request through the real adapters.
        let request = br#"{"v":1,"id":"00000000-0000-4000-8000-000000000000","method":"status"}"#;
        let response = respond(request);
        println!("{}", String::from_utf8_lossy(&response));
        let ok = serde_json::from_slice::<serde_json::Value>(&response).is_ok_and(|value| value["ok"] == true);
        return if ok { ExitCode::SUCCESS } else { ExitCode::from(1) };
    }
    if args == ["--version"] {
        println!("{} ({}) {} {}/{}", build_info::VERSION, build_info::build(), build_info::CHANNEL, build_info::PLATFORM, build_info::ARCH);
        return ExitCode::SUCCESS;
    }
    if !origin::caller_origin(&args).is_some_and(|caller| origin::accepts(caller, &[build_info::EXTENSION_ID])) {
        return fail("Native caller is not enrolled. Read-only local check: --inspect\n", 64);
    }
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    for _ in 0..128 {
        let frame = match frames::read(&mut input) {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            // No raw frame or error contents on stderr or stdout.
            Err(_) => return fail("Native protocol ended.\n", 65),
        };
        let written = frames::encode(&respond(&frame)).ok().and_then(|reply| output.write_all(&reply).and_then(|_| output.flush()).ok());
        if written.is_none() {
            return fail("Native protocol ended.\n", 65);
        }
    }
    ExitCode::SUCCESS
}
