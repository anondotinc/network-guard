// Reads the single version source shared with the Swift helper and setup scripts.
use std::fs;

fn main() {
    let path = "../Sources/NetworkHelperCore/BuildVersion.swift";
    println!("cargo:rerun-if-changed={path}");
    let source = fs::read_to_string(path).expect("BuildVersion.swift is readable");
    let value = |key: &str| -> String {
        let line = source
            .lines()
            .find(|line| line.contains(&format!("static let {key} = ")))
            .unwrap_or_else(|| panic!("BuildVersion.swift declares {key}"));
        line.split('=').nth(1).unwrap().trim().trim_matches('"').to_string()
    };
    let version = value("version");
    let build = value("build");
    assert!(version.split('.').count() == 3 && version.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())));
    assert!(!build.is_empty() && build.bytes().all(|b| b.is_ascii_digit()));
    println!("cargo:rustc-env=NETWORK_GUARD_VERSION={version}");
    println!("cargo:rustc-env=NETWORK_GUARD_BUILD={build}");
}
