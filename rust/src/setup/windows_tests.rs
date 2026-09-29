use super::*;
use windows_sys::Win32::System::Registry::RegDeleteTreeW;

/// A temporary %LOCALAPPDATA% and a scratch HKCU prefix, removed on drop.
struct Sandbox {
    base: PathBuf,
    prefix: String,
    installer: Installer,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        let base = std::env::temp_dir().join(format!("network-guard-setup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let local = base.join("Local");
        fs::create_dir_all(&local).unwrap();
        let prefix = format!("Software\\AnonNetworkGuardTest\\{name}-{}\\", std::process::id());
        let installer = Installer::new(local, prefix.clone());
        Sandbox { base, prefix, installer }
    }
    fn profile(&self, id: &str) {
        let browser = BROWSERS.iter().find(|b| b.id == id).unwrap();
        fs::create_dir_all(self.installer.local.join(browser.profile)).unwrap();
    }
    fn release(&self, version: &str, contents: &[u8]) -> (Payload, PathBuf) {
        let directory = self.base.join(format!("release-{version}"));
        fs::create_dir_all(&directory).unwrap();
        let helper = directory.join(HELPER);
        fs::write(&helper, contents).unwrap();
        (Payload { version: version.into(), channel: build_info::CHANNEL.into(), sha256: digest(contents) }, helper)
    }
    fn key(&self, id: &str) -> Option<String> {
        self.installer.read_key(BROWSERS.iter().find(|b| b.id == id).unwrap()).unwrap()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let root = wide(self.prefix.trim_end_matches('\\'));
        unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, root.as_ptr()) };
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn installs_for_present_browsers_and_uninstalls() {
    let sandbox = Sandbox::new("present");
    sandbox.profile("chrome");
    sandbox.profile("edge");
    let (payload, helper) = sandbox.release("0.2.0", b"helper-one");
    assert_eq!(sandbox.installer.check().unwrap(), State::NotInstalled);
    assert_eq!(sandbox.installer.install(&payload, &helper).unwrap(), vec!["chrome", "edge"]);
    let manifest_path = sandbox.installer.manifest_path();
    assert_eq!(sandbox.key("chrome").as_deref(), manifest_path.to_str());
    assert_eq!(sandbox.key("edge").as_deref(), manifest_path.to_str());
    assert_eq!(sandbox.key("chromium"), None);
    // Brave reads Chrome's key on Windows, so it is already covered.
    assert_eq!(sandbox.key("brave").as_deref(), manifest_path.to_str());
    let manifest: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    assert_eq!(manifest["path"], json!(sandbox.installer.executable(&payload).to_str().unwrap()));
    assert_eq!(manifest["allowed_origins"], json!([format!("chrome-extension://{}/", build_info::EXTENSION_ID)]));
    assert_eq!(sandbox.installer.check().unwrap(), State::Installed { version: "0.2.0".into(), browsers: vec!["chrome", "edge"] });
    sandbox.profile("brave");
    assert_eq!(sandbox.installer.check().unwrap(), State::NeedsRepair);
    assert_eq!(sandbox.installer.install(&payload, &helper).unwrap(), vec!["chrome", "brave", "edge"]);
    sandbox.installer.uninstall().unwrap();
    assert_eq!(sandbox.key("chrome"), None);
    assert!(!sandbox.installer.local.join("Anon").exists());
    assert_eq!(sandbox.installer.check().unwrap(), State::NotInstalled);
}

#[test]
fn foreign_registration_is_left_alone() {
    let sandbox = Sandbox::new("foreign");
    sandbox.profile("chrome");
    let chrome = BROWSERS.iter().find(|b| b.id == "chrome").unwrap();
    sandbox.installer.write_key(chrome, "C:\\Somewhere\\else.json").unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::RegistrationConflict));
    assert_eq!(sandbox.installer.uninstall(), Err(SetupError::RegistrationConflict));
    assert_eq!(sandbox.key("chrome").as_deref(), Some("C:\\Somewhere\\else.json"));
}

#[test]
fn refuses_without_a_browser_or_with_a_bad_payload() {
    let sandbox = Sandbox::new("payload");
    let (mut payload, helper) = sandbox.release("0.2.0", b"helper");
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::NoBrowser));
    sandbox.profile("chrome");
    payload.sha256 = "0".repeat(64);
    assert_eq!(sandbox.installer.install(&payload, &helper), Err(SetupError::InvalidPayload));
    assert!(!sandbox.installer.root.exists());
}

#[test]
fn unknown_files_block_uninstall() {
    let sandbox = Sandbox::new("unknown");
    sandbox.profile("chrome");
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    sandbox.installer.install(&payload, &helper).unwrap();
    let stray = sandbox.installer.executable(&payload).with_file_name("notes.txt");
    fs::write(&stray, b"user file").unwrap();
    assert_eq!(sandbox.installer.uninstall(), Err(SetupError::OwnershipConflict));
    assert!(stray.exists());
    assert!(sandbox.key("chrome").is_some());
}

#[test]
fn held_lock_reports_busy() {
    let sandbox = Sandbox::new("busy");
    sandbox.profile("chrome");
    let _held = lock::exclusive(&format!("inc.anon.network-guard.setup.{}", build_info::CHANNEL), (), ()).unwrap();
    let (payload, helper) = sandbox.release("0.2.0", b"helper");
    // The mutex is re-entrant for the owning thread, so contend from another thread.
    let installer = Installer::new(sandbox.installer.local.clone(), sandbox.prefix.clone());
    let result = std::thread::spawn(move || installer.install(&payload, &helper)).join().unwrap();
    assert_eq!(result, Err(SetupError::InstallBusy));
}
