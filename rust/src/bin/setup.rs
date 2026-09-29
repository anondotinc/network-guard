//! `anon-network-guard-setup install | check | uninstall`, run from the
//! extracted release folder. Per-user only: no root, no daemon, no network.
use network_guard::build_info;
use std::process::ExitCode;

#[cfg(any(target_os = "linux", windows))]
fn run(command: &str) -> Result<String, String> {
    use network_guard::setup::{Installer, Payload, State, BROWSERS};
    let names = |ids: &[&str]| -> String {
        ids.iter().filter_map(|id| BROWSERS.iter().find(|b| b.id == *id)).map(|b| b.name).collect::<Vec<_>>().join(", ")
    };
    let installer = Installer::for_current_user().map_err(|e| e.message().to_string())?;
    match command {
        "install" => {
            let folder = std::env::current_exe()
                .and_then(|path| path.canonicalize())
                .ok()
                .and_then(|path| path.parent().map(|p| p.to_path_buf()))
                .ok_or("Setup could not find its own folder.")?;
            let payload = Payload::load(&folder).map_err(|e| e.message().to_string())?;
            let browsers = installer.install(&payload, &folder.join(network_guard::setup::HELPER)).map_err(|e| e.message().to_string())?;
            Ok(format!(
                "Installed Network Guard {} for {}.\nNext: open Anon, go to Settings → Connection privacy, allow local access, then verify Network Guard.\nInstalling does not connect a VPN or grant browser permission.",
                payload.version,
                names(&browsers)
            ))
        }
        "check" => Ok(match installer.check().map_err(|e| e.message().to_string())? {
            State::NotInstalled => "Network Guard is not installed for this user.".into(),
            State::NeedsRepair => "Network Guard needs repair. Run install again from the latest release.".into(),
            State::Installed { version, browsers } => format!("Network Guard {version} is installed for {}.", names(&browsers)),
        }),
        "uninstall" => {
            installer.uninstall().map_err(|e| e.message().to_string())?;
            Ok("Network Guard was removed for this user. VPN apps and settings are unchanged.".into())
        }
        _ => unreachable!(),
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn run(_: &str) -> Result<String, String> {
    Err("This setup program is for Linux and Windows. macOS uses Anon Network Guard Setup.app.".into())
}

fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // Double-clicking the .exe on Windows passes no arguments: install, then
    // keep the window open so the result can be read.
    let double_clicked = cfg!(windows) && args.is_empty();
    if double_clicked {
        args.push("install".into());
    }
    let code = run_command(&args);
    if double_clicked {
        println!("\nPress Enter to close.");
        let _ = std::io::stdin().read_line(&mut String::new());
    }
    code
}

fn run_command(args: &[String]) -> ExitCode {
    let [command] = args else {
        eprintln!("Usage: anon-network-guard-setup install | check | uninstall");
        return ExitCode::from(2);
    };
    if !["install", "check", "uninstall"].contains(&command.as_str()) {
        eprintln!("Usage: anon-network-guard-setup install | check | uninstall");
        return ExitCode::from(2);
    }
    println!(
        "Anon Network Guard {} ({}) · {} channel · {}/{}",
        build_info::VERSION,
        build_info::build(),
        build_info::CHANNEL,
        build_info::PLATFORM,
        build_info::ARCH
    );
    match run(command) {
        Ok(message) => {
            println!("{message}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("{message}");
            ExitCode::from(1)
        }
    }
}
