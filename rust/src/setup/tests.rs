use super::*;
use std::os::unix::fs::symlink;

struct Sandbox {
    home: PathBuf,
    installer: Installer,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let base = std::env::temp_dir().join(format!("network-guard-setup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let home = base.join("home");
        let run = base.join("run");
        for directory in [&base, &home, &run] {
            fs::DirBuilder::new().mode(0o700).create(directory).unwrap();
        }
        let installer = Installer::new(home.clone(), home.join(".config"), run.to_string_lossy().into_owned());
        Sandbox { home, installer }
    }

    fn profile(&self, browser: &str) {
        let browser = browser_by_id(browser);
        fs::DirBuilder::new().recursive(true).mode(0o700).create(self.home.join(".config").join(browser.profile)).unwrap();
    }

    /// A bundled helper and matching payload, like an extracted release.
    fn release(&self, version: &str, contents: &[u8]) -> (Payload, PathBuf) {
        let directory = self.home.parent().unwrap().join(format!("release-{version}"));
        fs::DirBuilder::new().recursive(true).mode(0o700).create(&directory).unwrap();
        let helper = directory.join(HELPER);
        fs::write(&helper, contents).unwrap();
        let payload = Payload { version: version.into(), channel: build_info::CHANNEL.into(), sha256: digest(contents) };
        (payload, helper)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.home.parent().unwrap());
    }
}

fn browser_by_id(id: &str) -> &'static Browser {
    browser(id).unwrap()
}

fn registration(sandbox: &Sandbox, id: &str) -> Value {
    serde_json::from_slice(&fs::read(sandbox.installer.registration(browser_by_id(id))).unwrap()).unwrap()
}

#[test]
fn installs_for_present_browsers_only_and_checks() {
    let sandbox = Sandbox::new("present");
    sandbox.profile("chrome");
    sandbox.profile("brave");
    let (payload, helper) = sandbox.release("0.2.0", b"helper-one");
    assert_eq!(sandbox.installer.check().unwrap(), State::NotInstalled);
    assert_eq!(sandbox.installer.install(&payload, &helper).unwrap(), vec!["chrome", "brave"]);
    let manifest = registration(&sandbox, "chrome");
    let executable = sandbox.installer.executable(&payload);
    assert_eq!(manifest["path"], json!(executable.to_str().unwrap()));
    assert_eq!(manifest["name"], json!(build_info::HOST_NAME));
    assert_eq!(manifest["allowed_origins"], json!([format!("chrome-extension://{}/", build_info::EXTENSION_ID)]));
    assert_eq!(fs::metadata(&executable).unwrap().permissions().mode() & 0o777, 0o700);
    assert!(!sandbox.installer.registration(browser_by_id("chromium")).exists());
    assert!(!sandbox.home.join(".config/chromium").exists(), "setup never creates a browser profile");
    assert_eq!(sandbox.installer.check().unwrap(), State::Installed { version: "0.2.0".into(), browsers: vec!["chrome", "brave"] });
}

#[test]
fn refuses_without_any_browser_profile_and_writes_nothing() {
    let sandbox = Sandbox::new("nobrowser");
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::NoBrowser));
    assert!(!sandbox.installer.root.exists());
}

#[test]
fn new_browser_needs_repair_and_repair_registers_it() {
    let sandbox = Sandbox::new("repair");
    sandbox.profile("chrome");
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    sandbox.installer.install(&payload, &helper).unwrap();
    sandbox.profile("edge");
    assert_eq!(sandbox.installer.check().unwrap(), State::NeedsRepair);
    assert_eq!(sandbox.installer.install(&payload, &helper).unwrap(), vec!["chrome", "edge"]);
    assert!(matches!(sandbox.installer.check().unwrap(), State::Installed { .. }));
}

#[test]
fn changed_binary_needs_repair() {
    let sandbox = Sandbox::new("tamper");
    sandbox.profile("chrome");
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    sandbox.installer.install(&payload, &helper).unwrap();
    fs::write(sandbox.installer.executable(&payload), b"changed").unwrap();
    assert_eq!(sandbox.installer.check().unwrap(), State::NeedsRepair);
    sandbox.installer.install(&payload, &helper).unwrap();
    assert!(matches!(sandbox.installer.check().unwrap(), State::Installed { .. }));
}

#[test]
fn upgrade_repoints_every_registration_and_uninstall_removes_all_versions() {
    let sandbox = Sandbox::new("upgrade");
    sandbox.profile("chrome");
    sandbox.profile("chromium");
    let (first, first_helper) = sandbox.release("0.2.0", b"one");
    let (second, second_helper) = sandbox.release("0.2.1", b"two");
    sandbox.installer.install(&first, &first_helper).unwrap();
    sandbox.installer.install(&second, &second_helper).unwrap();
    for id in ["chrome", "chromium"] {
        assert_eq!(registration(&sandbox, id)["path"], json!(sandbox.installer.executable(&second).to_str().unwrap()));
    }
    assert!(sandbox.installer.executable(&first).exists(), "old versions stay until uninstall");
    sandbox.installer.uninstall().unwrap();
    assert!(!sandbox.home.join(".local/share/anon").exists());
    assert!(!sandbox.installer.registration(browser_by_id("chrome")).exists());
    assert!(sandbox.home.join(".config/google-chrome/NativeMessagingHosts").is_dir(), "browser directories are left alone");
    assert_eq!(sandbox.installer.check().unwrap(), State::NotInstalled);
}

#[test]
fn foreign_registration_is_never_replaced_or_removed() {
    let sandbox = Sandbox::new("foreign");
    sandbox.profile("chrome");
    let path = sandbox.installer.registration(browser_by_id("chrome"));
    fs::DirBuilder::new().recursive(true).mode(0o700).create(path.parent().unwrap()).unwrap();
    let foreign = b"{\"name\":\"other\"}";
    fs::write(&path, foreign).unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::RegistrationConflict));
    assert_eq!(sandbox.installer.check(), Err(SetupError::RegistrationConflict));
    assert_eq!(sandbox.installer.uninstall(), Err(SetupError::RegistrationConflict));
    assert_eq!(fs::read(&path).unwrap(), foreign);
    assert!(!sandbox.installer.root.exists());
}

#[test]
fn rejects_payload_mismatch_and_wrong_channel() {
    let sandbox = Sandbox::new("payload");
    sandbox.profile("chrome");
    let (mut payload, helper) = sandbox.release("0.2.0", b"helper");
    let good = payload.sha256.clone();
    payload.sha256 = "0".repeat(64);
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::InvalidPayload));
    payload.sha256 = good;
    payload.channel = if build_info::CHANNEL == "production" { "development".into() } else { "production".into() };
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::WrongChannel));
    for bad in [
        json!({"schemaVersion": 1, "version": "0.2", "channel": build_info::CHANNEL, "sha256": "0".repeat(64)}),
        json!({"schemaVersion": 2, "version": "0.2.0", "channel": build_info::CHANNEL, "sha256": "0".repeat(64)}),
        json!({"schemaVersion": 1, "version": "0.2.0", "channel": build_info::CHANNEL, "sha256": "A".repeat(64)}),
        json!({"schemaVersion": 1, "version": "0.2.0", "channel": build_info::CHANNEL, "sha256": "0".repeat(64), "path": "/bin/sh"}),
    ] {
        assert_eq!(Payload::from_json(&bad), Err(SetupError::InvalidPayload), "{bad}");
    }
    let symlinked = helper.with_file_name("linked-helper");
    symlink(&helper, &symlinked).unwrap();
    assert_eq!(
        sandbox.installer.install(
            &Payload::from_json(
                &json!({"schemaVersion": 1, "version": "0.2.0", "channel": build_info::CHANNEL, "sha256": digest(b"helper")})
            )
            .unwrap(),
            &symlinked
        ),
        Err(SetupError::InvalidPayload)
    );
}

#[test]
fn symlinked_or_shared_paths_are_unsafe() {
    let sandbox = Sandbox::new("unsafe");
    let elsewhere = sandbox.home.parent().unwrap().join("elsewhere");
    fs::DirBuilder::new().mode(0o700).create(&elsewhere).unwrap();
    fs::DirBuilder::new().mode(0o700).create(sandbox.home.join(".config")).unwrap();
    symlink(&elsewhere, sandbox.home.join(".config/google-chrome")).unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::UnsafePath));

    let shared = Sandbox::new("shared");
    shared.profile("chrome");
    fs::set_permissions(shared.home.join(".config"), fs::Permissions::from_mode(0o777)).unwrap();
    let (payload, helper) = shared.release("0.2.0", b"helper");
    assert_eq!(shared.installer.install(&payload, &helper), Err(SetupError::UnsafePath));
}

#[test]
fn unknown_files_block_uninstall_and_nothing_is_deleted() {
    let sandbox = Sandbox::new("unknown");
    sandbox.profile("chrome");
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    sandbox.installer.install(&payload, &helper).unwrap();
    let stray = sandbox.installer.executable(&payload).with_file_name("notes.txt");
    fs::write(&stray, b"user file").unwrap();
    assert_eq!(sandbox.installer.uninstall(), Err(SetupError::OwnershipConflict));
    assert!(stray.exists());
    assert!(sandbox.installer.registration(browser_by_id("chrome")).exists());
}

#[test]
fn unrecognized_receipt_fails_closed() {
    let sandbox = Sandbox::new("receipt");
    sandbox.profile("chrome");
    fs::DirBuilder::new().recursive(true).mode(0o700).create(&sandbox.installer.root).unwrap();
    fs::write(sandbox.installer.receipt_path(), b"{\"owner\":\"someone-else\"}").unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::OwnershipConflict));
    assert_eq!(sandbox.installer.check(), Err(SetupError::OwnershipConflict));
}

#[test]
fn held_lock_reports_busy() {
    let sandbox = Sandbox::new("busy");
    sandbox.profile("chrome");
    let name = format!("inc.anon.network-guard.setup.{}.lock", build_info::CHANNEL);
    let _held = lock::exclusive(&sandbox.installer.lock_directory, &name, (), ()).unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::InstallBusy));
}
