//! The Device Guard app: one per user, a tray icon, a start-at-login item and
//! the per-user socket the host shim talks to. In bridge mode it answers
//! wallet requests v1–v8 through the installed helper (see `bridge`).
//!
//!   anon-guard [--no-tray]                        run the app
//!   anon-guard status | quit                      talk to the running app
//!   anon-guard login-item status | register | unregister | open-settings
//!   anon-guard --version
//!
//! `--no-tray` (or `ANON_GUARD_NO_TRAY=1`) serves without an icon, for tests
//! and sessions without a tray.

// A console binary started at login opens a console window; the shim stays a
// console binary because Chrome talks to it over stdio.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::env;
use std::io;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use guard_device::bridge::{self, Bridge};
use guard_device::ipc::{self, read_frame, read_json, write_frame, write_json, BindError, IPC_VERSION};
use guard_device::{identity, login, CHANNEL, VERSION};
use interprocess::local_socket::{prelude::*, Stream};
use serde_json::{json, Value};

#[derive(Debug, Clone)]
#[cfg_attr(target_os = "linux", allow(dead_code))]
enum AppEvent {
    Request,
    Refresh,
    Quit,
}

struct Shared {
    started: Instant,
    started_at_ms: u64,
    launched_by: String,
    requests: AtomicU64,
    connections: AtomicU64,
    bridge: Bridge,
}

type Notify = Arc<dyn Fn(AppEvent) + Send + Sync>;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("status") => cli(json!({ "op": "status" })),
        Some("quit") => cli(json!({ "op": "quit" })),
        Some("login-item") => login_cli(&args[1..]),
        Some("--version") => {
            attach_console();
            println!("{VERSION} {CHANNEL} {}", identity::BUNDLE_ID);
            ExitCode::SUCCESS
        }
        Some(other) if !other.starts_with("--") => {
            attach_console();
            eprintln!("unknown command: {other}");
            ExitCode::from(2)
        }
        _ => run(&args),
    }
}

/// A GUI-subsystem binary has no console. Commands run from a terminal print
/// to the parent's console; pipes (scripts) already work without it.
fn attach_console() {
    #[cfg(windows)]
    // SAFETY: plain Win32 calls with constant arguments.
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle.is_null() || handle as isize == -1 {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

fn cli(request: Value) -> ExitCode {
    attach_console();
    match ipc::connect("cli", "") {
        Err(_) => {
            println!("{}", json!({ "ok": false, "error": "appNotRunning" }));
            ExitCode::from(3)
        }
        Ok((mut stream, _)) => match write_json(&mut stream, &request).and_then(|_| read_json(&mut stream)) {
            Ok(Some(value)) => {
                println!("{value}");
                ExitCode::SUCCESS
            }
            _ => ExitCode::from(1),
        },
    }
}

fn login_cli(args: &[String]) -> ExitCode {
    attach_console();
    let action = args.first().map(String::as_str).unwrap_or("status");
    let result = match action {
        "status" => Ok(()),
        "register" => login::register(),
        "unregister" => login::unregister(),
        "open-settings" => {
            login::open_settings();
            Ok(())
        }
        _ => Err("usage: login-item status|register|unregister|open-settings".to_string()),
    };
    let mut out = json!({ "action": action, "startAtLogin": login::status() });
    if let Err(e) = &result {
        out["error"] = json!(e);
    }
    println!("{out}");
    if result.is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

fn launched_by(args: &[String]) -> String {
    if let Some(flag) = args.iter().find_map(|a| a.strip_prefix("--launched-by=")) {
        return flag.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
    }
    #[cfg(unix)]
    // SAFETY: getppid has no failure mode.
    if unsafe { libc::getppid() } == 1 {
        // launchd (macOS login item or LaunchServices) or init on Linux.
        return "pid1".into();
    }
    "parent".into()
}

fn run(args: &[String]) -> ExitCode {
    let bound = match ipc::bind() {
        Ok(bound) => bound,
        Err(BindError::AlreadyRunning) => {
            eprintln!("anon-guard: already running");
            return ExitCode::SUCCESS;
        }
        Err(BindError::Io(e)) => {
            eprintln!("anon-guard: cannot open the local socket: {e}");
            return ExitCode::from(1);
        }
    };
    let shared = Arc::new(Shared {
        started: Instant::now(),
        started_at_ms: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
        launched_by: launched_by(args),
        requests: AtomicU64::new(0),
        connections: AtomicU64::new(0),
        bridge: Bridge::default(),
    });
    eprintln!("anon-guard {VERSION} ({CHANNEL}): listening (launched by {})", shared.launched_by);
    let headless = args.iter().any(|a| a == "--no-tray") || env::var_os("ANON_GUARD_NO_TRAY").is_some_and(|v| v == "1");
    if headless {
        let (quit_tx, quit_rx) = std::sync::mpsc::channel();
        let notify: Notify = Arc::new(move |event| {
            if matches!(event, AppEvent::Quit) {
                let _ = quit_tx.send(());
            }
        });
        thread::spawn(move || serve(bound, shared, notify));
        let _ = quit_rx.recv();
        return ExitCode::SUCCESS;
    }
    ui::run(bound, shared)
}

/// Accepts shim and CLI connections; one thread each. Never returns.
fn serve(bound: ipc::Bound, shared: Arc<Shared>, notify: Notify) {
    for conn in bound.listener.incoming() {
        let Ok(conn) = conn else { continue };
        let (shared, notify) = (shared.clone(), notify.clone());
        thread::spawn(move || {
            let _ = handle(conn, &shared, &notify);
        });
    }
}

fn handle(mut conn: Stream, shared: &Shared, notify: &Notify) -> io::Result<()> {
    ipc::check_peer(&conn)?;
    let Some(hello) = read_json(&mut conn)? else { return Ok(()) };
    if hello.get("ipc").and_then(Value::as_u64) != Some(IPC_VERSION) {
        write_json(&mut conn, &json!({ "ipc": IPC_VERSION, "error": "ipcVersion" }))?;
        return Ok(());
    }
    write_json(&mut conn, &json!({ "ipc": IPC_VERSION, "app": VERSION }))?;
    shared.connections.fetch_add(1, Ordering::Relaxed);
    let origin = hello.get("origin").and_then(Value::as_str).unwrap_or_default().to_string();
    match hello.get("role").and_then(Value::as_str) {
        Some("shim") => {
            while let Some(frame) = read_frame(&mut conn)? {
                shared.requests.fetch_add(1, Ordering::Relaxed);
                notify(AppEvent::Request);
                write_frame(&mut conn, &shared.bridge.respond(&origin, &frame))?;
            }
        }
        Some("cli") => {
            while let Some(request) = read_json(&mut conn)? {
                write_json(&mut conn, &cli_reply(&request, shared, notify))?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn cli_reply(request: &Value, shared: &Shared, notify: &Notify) -> Value {
    match request.get("op").and_then(Value::as_str) {
        Some("status") => json!({
            "ok": true,
            "app": VERSION,
            "channel": CHANNEL,
            "bundleId": identity::BUNDLE_ID,
            "pid": std::process::id(),
            "launchedBy": shared.launched_by,
            "startedAt": shared.started_at_ms,
            "uptimeMs": shared.started.elapsed().as_millis() as u64,
            "requests": shared.requests.load(Ordering::Relaxed),
            "connections": shared.connections.load(Ordering::Relaxed),
            "startAtLogin": login::status(),
            "bridge": {
                "mode": "helper",
                "resolved": bridge::describe_helper(),
                "helperRuns": shared.bridge.stats.helper_runs.load(Ordering::Relaxed),
                "cacheHits": shared.bridge.stats.cache_hits.load(Ordering::Relaxed),
                "failures": shared.bridge.stats.failures.load(Ordering::Relaxed),
                "cacheEntries": shared.bridge.cache_entries(),
            },
        }),
        Some("quit") => {
            notify(AppEvent::Quit);
            json!({ "ok": true })
        }
        _ => json!({ "ok": false, "error": "unsupportedMethod" }),
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod ui {
    use super::*;
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIconBuilder};

    pub fn run(bound: ipc::Bound, shared: Arc<Shared>) -> ExitCode {
        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
        #[cfg(target_os = "macos")]
        {
            // No Dock icon and no app menu: a menu-bar accessory (LSUIElement does the same at launch).
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }
        let proxy = event_loop.create_proxy();
        let notify: Notify = Arc::new(move |event| {
            let _ = proxy.send_event(event);
        });
        {
            let (shared, notify) = (shared.clone(), notify.clone());
            thread::spawn(move || serve(bound, shared, notify));
        }
        let menu_proxy = event_loop.create_proxy();

        let header = MenuItem::new(format!("{} {VERSION}", identity::APP_NAME), false, None);
        let requests = MenuItem::new("Wallet requests: 0", false, None);
        let start_at_login = CheckMenuItem::new("Start at login", true, login::status() == "enabled", None);
        let quit = MenuItem::new("Quit", true, None);
        let menu = Menu::new();
        let _ = menu.append_items(&[
            &header,
            &requests,
            &PredefinedMenuItem::separator(),
            &start_at_login,
            &PredefinedMenuItem::separator(),
            &quit,
        ]);
        let (quit_id, login_id) = (quit.id().clone(), start_at_login.id().clone());
        MenuEvent::set_event_handler(Some(move |event: MenuEvent| {
            if event.id == quit_id {
                let _ = menu_proxy.send_event(AppEvent::Quit);
            } else if event.id == login_id {
                toggle_login();
                let _ = menu_proxy.send_event(AppEvent::Refresh);
            }
        }));

        let mut tray = None;
        event_loop.run(move |event, _, control_flow| {
            *control_flow = ControlFlow::Wait;
            match event {
                Event::NewEvents(StartCause::Init) => {
                    // The tray has to be created on the main thread once the loop runs.
                    let (rgba, size) = icon_rgba();
                    let icon = Icon::from_rgba(rgba, size, size).expect("icon");
                    let builder = TrayIconBuilder::new();
                    // A template image follows the menu bar's light or dark look (macOS only).
                    #[cfg(target_os = "macos")]
                    let builder = builder.with_icon_templated(icon);
                    #[cfg(not(target_os = "macos"))]
                    let builder = builder.with_icon(icon);
                    tray = builder
                        .with_tooltip(identity::APP_NAME)
                        .with_menu(Box::new(menu.clone()))
                        .build()
                        .map_err(|e| eprintln!("anon-guard: tray unavailable: {e}"))
                        .ok();
                }
                Event::UserEvent(AppEvent::Request) => {
                    requests.set_text(format!("Wallet requests: {}", shared.requests.load(Ordering::Relaxed)));
                }
                Event::UserEvent(AppEvent::Quit) => {
                    tray.take();
                    *control_flow = ControlFlow::Exit;
                }
                Event::UserEvent(AppEvent::Refresh) => {
                    start_at_login.set_checked(login::status() == "enabled");
                }
                _ => {}
            }
        })
    }

    fn toggle_login() {
        let result = if login::status() == "enabled" { login::unregister() } else { login::register() };
        if let Err(e) = result {
            eprintln!("anon-guard: start at login: {e}");
        }
        if login::status() == "requiresApproval" {
            login::open_settings();
        }
    }
}

#[cfg(target_os = "linux")]
mod ui {
    use super::*;
    use std::sync::mpsc;

    struct GuardTray {
        requests: u64,
        quit: mpsc::Sender<()>,
    }

    impl ksni::Tray for GuardTray {
        fn id(&self) -> String {
            identity::BUNDLE_ID.into()
        }
        fn title(&self) -> String {
            identity::APP_NAME.into()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            // SNI wants ARGB32 in network byte order.
            let (rgba, size) = icon_rgba();
            let data = rgba.chunks(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect();
            vec![ksni::Icon { width: size as i32, height: size as i32, data }]
        }
        fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
            // Keep the service: the shell's indicator extension can come back (shell restart).
            eprintln!("anon-guard: tray watcher offline: {reason:?}");
            true
        }
        fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
            use ksni::menu::StandardItem;
            vec![
                StandardItem { label: format!("Wallet requests: {}", self.requests), enabled: false, ..Default::default() }.into(),
                ksni::MenuItem::Separator,
                StandardItem {
                    label: "Quit".into(),
                    activate: Box::new(|tray: &mut Self| {
                        let _ = tray.quit.send(());
                    }),
                    ..Default::default()
                }
                .into(),
            ]
        }
    }

    pub fn run(bound: ipc::Bound, shared: Arc<Shared>) -> ExitCode {
        use ksni::blocking::TrayMethods;
        let (quit_tx, quit_rx) = mpsc::channel();
        // At login the app can start before the shell's indicator extension owns the watcher;
        // assume_sni_available keeps the item and registers when the watcher appears.
        let handle = match (GuardTray { requests: 0, quit: quit_tx.clone() }).assume_sni_available(true).spawn() {
            Ok(handle) => Some(handle),
            Err(e) => {
                // Stock GNOME has no StatusNotifierWatcher; the app keeps serving without an icon.
                eprintln!("anon-guard: tray unavailable: {e}");
                None
            }
        };
        let notify: Notify = {
            let handle = handle.clone();
            Arc::new(move |event| match event {
                AppEvent::Quit => {
                    let _ = quit_tx.send(());
                }
                AppEvent::Request => {
                    if let Some(handle) = &handle {
                        handle.update(|t| t.requests += 1);
                    }
                }
                AppEvent::Refresh => {}
            })
        };
        thread::spawn(move || serve(bound, shared, notify));
        let _ = quit_rx.recv();
        if let Some(handle) = handle {
            handle.shutdown().wait();
        }
        ExitCode::SUCCESS
    }
}

/// A 36 px monochrome mark (ring and dot) as RGBA. macOS draws it as a template image.
fn icon_rgba() -> (Vec<u8>, u32) {
    const S: u32 = 36;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let c = (S as f32 - 1.0) / 2.0;
    for y in 0..S {
        for x in 0..S {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            if (12.0..=16.0).contains(&d) || d <= 6.0 {
                rgba[((y * S + x) * 4 + 3) as usize] = 255;
            }
        }
    }
    (rgba, S)
}
