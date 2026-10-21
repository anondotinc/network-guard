import Foundation
import NetworkHelperCore

/// Headless install, check, list, rollback and uninstall for development
/// tooling (`scripts/dev.mjs`). It runs the same `UserInstaller` as the Setup
/// window, with the same checks; only debug (development channel) builds of
/// the Setup app expose it, and the window flow is unchanged.
///
///     AnonNetworkHelperSetup --install | --check | --list | --uninstall [--home <dir>]
///     AnonNetworkHelperSetup --activate <version>-<sha256> [--home <dir>]
///
/// Prints one JSON object. Exit status 0 on success, 1 for a setup error and
/// 64 for a usage error. `--home` replaces the user's home for every path the
/// installer manages, so tests never touch the real installation.
public enum SetupCommandLine {
    static let commands: Set<String> = ["--install", "--check", "--list", "--uninstall", "--activate"]

    public static func handles(_ arguments: [String]) -> Bool {
        arguments.first.map(commands.contains) ?? false
    }

    public static func run(_ arguments: [String], resources: URL?, home defaultHome: URL) -> (status: Int32, output: String) {
        guard let command = arguments.first, commands.contains(command) else { return usage() }
        var rest = Array(arguments.dropFirst())
        var directory: String?
        if command == "--activate" {
            guard let value = rest.first, !value.hasPrefix("--") else { return usage() }
            directory = value
            rest.removeFirst()
        }
        var home = defaultHome
        if rest.count == 2, rest[0] == "--home" {
            guard rest[1].hasPrefix("/") else { return usage() }
            home = URL(fileURLWithPath: rest[1], isDirectory: true)
        } else if !rest.isEmpty {
            return usage()
        }
        let name = String(command.dropFirst(2))
        let installer = UserInstaller(home: home)
        do {
            var result: [String: Any] = ["ok": true, "command": name, "channel": NativeEnrollment.channel]
            switch command {
            case "--install":
                guard let resources else { throw SetupError.invalidPayload }
                let payload = try SetupPayload.load(from: resources)
                try installer.install(payload: payload, bundledHelper: resources.appendingPathComponent("anon-network-helper"))
                result["active"] = describe(payload, installer)
            case "--check":
                switch try installer.check() {
                case .notInstalled: result["state"] = "notInstalled"
                case .needsRepair: result["state"] = "needsRepair"
                case .installed(let version): result["state"] = "installed"; result["version"] = version
                }
            case "--list":
                let inventory = try installer.inventory()
                result["versions"] = inventory.versions.map { describe($0, installer) }
                result["active"] = inventory.active.map { describe($0, installer) } ?? NSNull()
                result["registration"] = inventory.registration
            case "--activate":
                result["active"] = describe(try installer.activate(directory: directory ?? ""), installer)
            default:
                try installer.uninstall()
            }
            result["registrationPath"] = installer.registration.path
            return (0, encode(result))
        } catch {
            let setupError = error as? SetupError ?? .ioFailure
            return (1, encode(["ok": false, "command": name, "error": setupError.rawValue,
                               "message": setupError.errorDescription ?? ""]))
        }
    }

    private static func describe(_ payload: SetupPayload, _ installer: UserInstaller) -> [String: Any] {
        ["version": payload.version, "sha256": payload.sha256, "directory": payload.directoryName,
         "helper": installer.helperURL(payload).path]
    }

    private static func usage() -> (status: Int32, output: String) {
        (64, encode(["ok": false, "error": "usage",
                     "message": "--install | --check | --list | --uninstall | --activate <version>-<sha256>, then optionally --home <absolute dir>"]))
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "{\"ok\":false}" }
        return text
    }
}
