//! Device Guard spike app: one per user, a tray icon, and a local socket the host shim talks to.
//!
//!   anon-guard                         run the app (tray + socket)
//!   anon-guard status | quit           talk to the running app
//!   anon-guard login-item status|register|unregister [main|agent]   (macOS)

use std::env;
use std::io;
use std::process::ExitCode;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use guard_spike::{bind, connect, error_reply, now_ms, read_frame, read_json, write_json, BindError, IPC_VERSION, VERSION};
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
    started_at_ms: u128,
    launched_by: String,
    requests: AtomicU64,
    connections: AtomicU64,
}

type Notify = Arc<dyn Fn(AppEvent) + Send + Sync>;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("status") => cli(json!({ "op": "spikeStatus" })),
        Some("quit") => cli(json!({ "op": "quit" })),
        #[cfg(target_os = "macos")]
        Some("login-item") => login::cli(&args[1..]),
        Some(other) if !other.starts_with("--") => {
            eprintln!("unknown command: {other}");
            ExitCode::from(2)
        }
        _ => run(&args),
    }
}

fn cli(request: Value) -> ExitCode {
    match connect("cli", "") {
        Err(_) => {
            println!("{}", error_reply(None, "appNotRunning"));
            ExitCode::from(3)
        }
        Ok((mut stream, _)) => {
            let reply = write_json(&mut stream, &request).and_then(|_| read_json(&mut stream));
            match reply {
                Ok(Some(value)) => {
                    println!("{value}");
                    ExitCode::SUCCESS
                }
                _ => ExitCode::from(1),
            }
        }
    }
}

fn launched_by(args: &[String]) -> String {
    if let Some(flag) = args.iter().find_map(|a| a.strip_prefix("--launched-by=")) {
        return flag.to_string();
    }
    #[cfg(unix)]
    if unsafe { libc::getppid() } == 1 {
        // launchd (macOS login item or open -a) or init on Linux.
        return "pid1".into();
    }
    "parent".into()
}

fn run(args: &[String]) -> ExitCode {
    let bound = match bind() {
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
        started_at_ms: now_ms(),
        launched_by: launched_by(args),
        requests: AtomicU64::new(0),
        connections: AtomicU64::new(0),
    });
    eprintln!("anon-guard {VERSION}: listening (launched by {})", shared.launched_by);
    ui::run(bound, shared)
}

/// Accepts shim and CLI connections; one thread each. Never returns.
fn serve(bound: guard_spike::Bound, shared: Arc<Shared>, notify: Notify) {
    for conn in bound.listener.incoming() {
        let Ok(conn) = conn else { continue };
        let (shared, notify) = (shared.clone(), notify.clone());
        thread::spawn(move || {
            let _ = handle(conn, &shared, &notify);
        });
    }
}

fn handle(mut conn: Stream, shared: &Shared, notify: &Notify) -> io::Result<()> {
    #[cfg(unix)]
    {
        // Same user only. The 0700 directory already stops others; this is the second lock.
        let euid = conn.peer_creds()?.euid();
        if euid != Some(unsafe { libc::geteuid() }) {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, "peer is another user"));
        }
    }
    let Some(hello) = read_json(&mut conn)? else { return Ok(()) };
    if hello.get("ipc").and_then(Value::as_u64) != Some(IPC_VERSION) {
        write_json(&mut conn, &json!({ "ipc": IPC_VERSION, "error": "ipcVersion" }))?;
        return Ok(());
    }
    write_json(&mut conn, &json!({ "ipc": IPC_VERSION, "app": VERSION }))?;
    shared.connections.fetch_add(1, Ordering::Relaxed);
    while let Some(frame) = read_frame(&mut conn)? {
        let reply = respond(&frame, shared, notify);
        write_json(&mut conn, &reply)?;
    }
    Ok(())
}

fn respond(frame: &[u8], shared: &Shared, notify: &Notify) -> Value {
    let Ok(request) = serde_json::from_slice::<Value>(frame) else {
        return error_reply(None, "badRequest");
    };
    let id = request.get("id");
    match request.get("op").and_then(Value::as_str) {
        Some("spikeStatus") => {
            #[allow(unused_mut)]
            let mut status = json!({
                "ok": true,
                "app": VERSION,
                "pid": std::process::id(),
                "launchedBy": shared.launched_by,
                "startedAt": shared.started_at_ms as u64,
                "uptimeMs": shared.started.elapsed().as_millis() as u64,
                "requests": shared.requests.load(Ordering::Relaxed),
                "connections": shared.connections.load(Ordering::Relaxed),
                "job": guard_spike::job_info(),
            });
            #[cfg(target_os = "macos")]
            {
                status["loginItem"] = login::status_json();
            }
            status
        }
        Some("quit") => {
            notify(AppEvent::Quit);
            json!({ "ok": true })
        }
        _ => {
            // Stand-in for the wallet wire: the real app answers from its cached VPN status.
            shared.requests.fetch_add(1, Ordering::Relaxed);
            notify(AppEvent::Request);
            let mut reply = json!({
                "v": request.get("v").cloned().unwrap_or(json!(1)),
                "ok": true,
                "spike": "device-guard",
                "app": VERSION,
                "status": { "state": "unknown", "checkedAt": now_ms() as u64 },
            });
            if let Some(id) = id {
                reply["id"] = id.clone();
            }
            reply
        }
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod ui {
    use super::*;
    use tao::event::{Event, StartCause};
    use tao::event_loop::{ControlFlow, EventLoopBuilder};
    use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
    use tray_icon::{Icon, TrayIconBuilder};

    pub fn run(bound: guard_spike::Bound, shared: Arc<Shared>) -> ExitCode {
        #[allow(unused_mut)]
        let mut event_loop = EventLoopBuilder::<AppEvent>::with_user_event().build();
        #[cfg(target_os = "macos")]
        {
            // No Dock icon and no app menu: a menu-bar accessory (LSUIElement does the same at launch).
            use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
            event_loop.set_activation_policy(ActivationPolicy::Accessory);
        }
        drive(event_loop, bound, shared)
    }

    fn drive(event_loop: tao::event_loop::EventLoop<AppEvent>, bound: guard_spike::Bound, shared: Arc<Shared>) -> ExitCode {
        let proxy = event_loop.create_proxy();
        let notify: Notify = Arc::new(move |event| {
            let _ = proxy.send_event(event);
        });
        {
            let (shared, notify) = (shared.clone(), notify.clone());
            thread::spawn(move || serve(bound, shared, notify));
        }
        let menu_proxy = event_loop.create_proxy();

        let header = MenuItem::new(format!("Anon Network Guard (spike {VERSION})"), false, None);
        let requests = MenuItem::new("Wallet requests: 0", false, None);
        let login_line = MenuItem::new(login_text(), false, None);
        let start_at_login = CheckMenuItem::new("Start at login", cfg!(target_os = "macos"), login_enabled(), None);
        let quit = MenuItem::new("Quit", true, None);
        let menu = Menu::new();
        let _ = menu.append_items(&[
            &header,
            &requests,
            &login_line,
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
                    let (rgba, size) = guard_spike::icon_rgba();
                    let icon = Icon::from_rgba(rgba, size, size).expect("icon");
                    let builder = TrayIconBuilder::new();
                    // A template image follows the menu bar's light or dark look (macOS only).
                    #[cfg(target_os = "macos")]
                    let builder = builder.with_icon_templated(icon);
                    #[cfg(not(target_os = "macos"))]
                    let builder = builder.with_icon(icon);
                    tray = builder
                        .with_tooltip("Anon Network Guard (spike)")
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
                    login_line.set_text(login_text());
                    start_at_login.set_checked(login_enabled());
                }
                _ => {}
            }
        })
    }

    #[cfg(target_os = "macos")]
    fn login_text() -> String {
        format!("Login item: {}", super::login::main_status())
    }
    #[cfg(target_os = "macos")]
    fn login_enabled() -> bool {
        super::login::main_status() == "enabled"
    }
    #[cfg(target_os = "macos")]
    fn toggle_login() {
        let result = if login_enabled() { super::login::unregister("main") } else { super::login::register("main") };
        if let Err(e) = result {
            eprintln!("anon-guard: login item: {e}");
        }
        if super::login::main_status() == "requiresApproval" {
            super::login::open_settings();
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn login_text() -> String {
        "Login item: not in this spike".into()
    }
    #[cfg(not(target_os = "macos"))]
    fn login_enabled() -> bool {
        false
    }
    #[cfg(not(target_os = "macos"))]
    fn toggle_login() {}
}

#[cfg(target_os = "linux")]
mod ui {
    use super::*;
    use std::sync::mpsc;

    struct SpikeTray {
        requests: u64,
        quit: mpsc::Sender<()>,
    }

    impl ksni::Tray for SpikeTray {
        fn id(&self) -> String {
            "anon-network-guard-spike".into()
        }
        fn title(&self) -> String {
            "Anon Network Guard (spike)".into()
        }
        fn icon_pixmap(&self) -> Vec<ksni::Icon> {
            // SNI wants ARGB32 in network byte order.
            let (rgba, size) = guard_spike::icon_rgba();
            let data = rgba.chunks(4).flat_map(|p| [p[3], p[0], p[1], p[2]]).collect();
            vec![ksni::Icon { width: size as i32, height: size as i32, data }]
        }
        fn watcher_online(&self) {
            eprintln!("anon-guard: tray registered (watcher online)");
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

    pub fn run(bound: guard_spike::Bound, shared: Arc<Shared>) -> ExitCode {
        use ksni::blocking::TrayMethods;
        let (quit_tx, quit_rx) = mpsc::channel();
        // At login the app can start before the shell's indicator extension owns the watcher;
        // assume_sni_available keeps the item and registers when the watcher appears.
        let handle = match (SpikeTray { requests: 0, quit: quit_tx.clone() }).assume_sni_available(true).spawn() {
            Ok(handle) => {
                eprintln!("anon-guard: tray spawned");
                Some(handle)
            }
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
        {
            let shared = shared.clone();
            thread::spawn(move || serve(bound, shared, notify));
        }
        let _ = quit_rx.recv();
        if let Some(handle) = handle {
            handle.shutdown().wait();
        }
        ExitCode::SUCCESS
    }
}

#[cfg(target_os = "macos")]
mod login {
    use super::*;
    use objc2::rc::Retained;
    use objc2_foundation::NSString;
    use objc2_service_management::{SMAppService, SMAppServiceStatus};

    fn service(kind: &str) -> Retained<SMAppService> {
        unsafe {
            match kind {
                "agent" => SMAppService::agentServiceWithPlistName(&NSString::from_str(guard_spike::AGENT_PLIST)),
                _ => SMAppService::mainAppService(),
            }
        }
    }

    fn name(status: SMAppServiceStatus) -> &'static str {
        match status {
            SMAppServiceStatus::NotRegistered => "notRegistered",
            SMAppServiceStatus::Enabled => "enabled",
            SMAppServiceStatus::RequiresApproval => "requiresApproval",
            SMAppServiceStatus::NotFound => "notFound",
            _ => "unknown",
        }
    }

    pub fn status(kind: &str) -> &'static str {
        name(unsafe { service(kind).status() })
    }

    pub fn main_status() -> &'static str {
        status("main")
    }

    pub fn status_json() -> Value {
        json!({ "main": status("main"), "agent": status("agent") })
    }

    pub fn register(kind: &str) -> Result<(), String> {
        unsafe { service(kind).registerAndReturnError() }
            .map_err(|e| format!("{} (code {})", e.localizedDescription(), e.code()))
    }

    pub fn unregister(kind: &str) -> Result<(), String> {
        unsafe { service(kind).unregisterAndReturnError() }
            .map_err(|e| format!("{} (code {})", e.localizedDescription(), e.code()))
    }

    pub fn open_settings() {
        unsafe { SMAppService::openSystemSettingsLoginItems() }
    }

    pub fn cli(args: &[String]) -> ExitCode {
        let action = args.first().map(String::as_str).unwrap_or("status");
        let kind = args.get(1).map(String::as_str).unwrap_or("main");
        let result = match action {
            "status" => Ok(()),
            "register" => register(kind),
            "unregister" => unregister(kind),
            "open-settings" => {
                open_settings();
                Ok(())
            }
            _ => Err("usage: login-item status|register|unregister|open-settings [main|agent]".into()),
        };
        let mut out = json!({ "action": action, "kind": kind, "status": status_json() });
        if let Err(e) = &result {
            out["error"] = json!(e);
        }
        println!("{out}");
        if result.is_ok() { ExitCode::SUCCESS } else { ExitCode::from(1) }
    }
}
