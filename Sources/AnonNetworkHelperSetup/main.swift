import AppKit
import Foundation
import NetworkHelperSetupCore
import NetworkHelperCore

final class SetupDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let status = NSTextField(wrappingLabelWithString: "Ready to install for this macOS user.")
    private let installer = UserInstaller()
    private var controls: [NSButton] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        let frame = NSRect(x: 0, y: 0, width: 540, height: 580)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable],
                          backing: .buffered, defer: false)
        window.title = "Anon Network Guard Setup"
        let content = NSStackView()
        content.orientation = .vertical; content.alignment = .leading; content.spacing = 12
        content.translatesAutoresizingMaskIntoConstraints = false
        let title = NSTextField(labelWithString: "Anon Network Guard")
        title.font = .systemFont(ofSize: 23, weight: .semibold)
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 12
        let icon = NSImageView(image: NSImage(named: NSImage.applicationIconName) ?? NSImage())
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 48).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 48).isActive = true
        icon.setAccessibilityElement(false)
        heading.addArrangedSubview(icon); heading.addArrangedSubview(title)
        let payload = Bundle.main.resourceURL.flatMap { try? SetupPayload.load(from: $0) }
        let channel = payload?.channel == "development" ? "Development extension only" : "Production extension only"
        let subtitle = NSTextField(labelWithString: "v\(NetworkGuardBuild.version) (\(NetworkGuardBuild.build)) · \(channel) · macOS 13+ · Chrome")
        subtitle.font = .systemFont(ofSize: 12); subtitle.textColor = .secondaryLabelColor
        let detail = NSTextField(wrappingLabelWithString: "Install Network Guard for your user account. No administrator access, VPN login, or wallet access is requested. Installation does not connect a VPN or grant Chrome permission.")
        detail.font = .systemFont(ofSize: 13)
        status.font = .systemFont(ofSize: 13, weight: .medium)
        status.setAccessibilityRole(.staticText)
        let row = NSStackView(); row.orientation = .horizontal; row.spacing = 8
        for (name, action) in [("Install / Repair", #selector(install)), ("Check installation", #selector(check)), ("Uninstall", #selector(uninstall))] {
            let button = NSButton(title: name, target: self, action: action)
            button.bezelStyle = .rounded; controls.append(button); row.addArrangedSubview(button)
        }
        controls[0].keyEquivalent = "\r"
        let note = NSTextField(wrappingLabelWithString: "Next: open Anon → Settings → Connection privacy → Allow local access → Verify Network Guard. Auto-connect remains a separate choice. Network Guard does not verify routing or block traffic in this preview.")
        note.font = .systemFont(ofSize: 12); note.textColor = .secondaryLabelColor
        let verification = NSTextField(wrappingLabelWithString: "Use a signed Anon release for everyday use. Unsigned local builds are for testing only.")
        verification.font = .systemFont(ofSize: 11); verification.textColor = .secondaryLabelColor
        let links = NSStackView(); links.orientation = .horizontal; links.spacing = 12
        for (name, action) in [("Setup guide", #selector(openGuide)), ("Releases & verification", #selector(openReleases))] {
            let button = NSButton(title: name, target: self, action: action)
            button.bezelStyle = .inline; links.addArrangedSubview(button)
        }
        let linkNotice = NSTextField(wrappingLabelWithString: "Links open in your browser using your current connection. Nothing opens until you click.")
        linkNotice.font = .systemFont(ofSize: 11); linkNotice.textColor = .secondaryLabelColor
        for view in [heading, subtitle, detail, row, status, note, verification, links, linkNotice] { content.addArrangedSubview(view) }
        // Explicit wrapping widths prevent long status/troubleshooting text from
        // expanding beyond the compact window under a leading-aligned stack.
        for label in [detail, status, note, verification, linkNotice] {
            label.widthAnchor.constraint(equalTo: content.widthAnchor).isActive = true
        }
        window.contentView!.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            content.bottomAnchor.constraint(lessThanOrEqualTo: window.contentView!.bottomAnchor, constant: -24),
        ])
        window.center(); window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }
    @objc private func openGuide() {
        NSWorkspace.shared.open(URL(string: "https://anon.inc/setup/vpn")!)
    }
    @objc private func openReleases() {
        NSWorkspace.shared.open(URL(string: "https://anon.inc/releases")!)
    }
    private func perform(_ operation: @escaping () throws -> String) {
        controls.forEach { $0.isEnabled = false }; status.stringValue = "Working locally…"
        DispatchQueue.global(qos: .userInitiated).async {
            let message: String
            do { message = try operation() }
            catch { message = (error as? SetupError)?.errorDescription ?? SetupError.ioFailure.errorDescription! }
            DispatchQueue.main.async {
                self.status.stringValue = message
                self.controls.forEach { $0.isEnabled = true }
                NSAccessibility.post(element: self.status, notification: .valueChanged)
            }
        }
    }
    @objc private func install() {
        perform {
            guard let resources = Bundle.main.resourceURL else { throw SetupError.invalidPayload }
            try self.installer.install(payload: SetupPayload.load(from: resources),
                                       bundledHelper: resources.appendingPathComponent("anon-network-helper"))
            return "Network Guard \(NetworkGuardBuild.version) installed. Return to Anon and verify Network Guard again. Allow local access if prompted. No VPN settings were changed."
        }
    }
    @objc private func check() {
        perform {
            switch try self.installer.check() {
            case .notInstalled: return "Not installed for this extension channel. Choose Install / Repair."
            case .needsRepair: return "Installation needs repair. Choose Install / Repair."
            case .installed(let version):
                if version != NetworkGuardBuild.version {
                    return "Installed: Network Guard \(version). This setup contains \(NetworkGuardBuild.version). Review the release notes before using Install / Repair to change versions."
                }
                return "Network Guard \(version) and Chrome registration verified locally. Check provider status in Anon."
            }
        }
    }
    @objc private func uninstall() {
        let alert = NSAlert()
        alert.messageText = "Remove this channel's Network Guard?"
        alert.informativeText = "Only this setup app's Network Guard files and matching Chrome registration are removed. Your VPN, other extension channel, wallet, and Chrome permissions stay unchanged."
        alert.addButton(withTitle: "Cancel"); alert.addButton(withTitle: "Remove Network Guard")
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        perform {
            try self.installer.uninstall()
            return "Network Guard removed. Your VPN and wallet were not changed. To reinstall, use Install / Repair."
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = SetupDelegate()
app.delegate = delegate
let menu = NSMenu()
let item = NSMenuItem(); menu.addItem(item)
let appMenu = NSMenu(); appMenu.addItem(withTitle: "Quit Anon Network Guard Setup", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
item.submenu = appMenu; app.mainMenu = menu
app.run()
