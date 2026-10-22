import Foundation
import CryptoKit
import Darwin
import NetworkHelperCore

public enum SetupError: String, Error, LocalizedError {
    case invalidPayload, wrongChannel, unsafePath, registrationConflict, managedByApp, ownershipConflict
    case installationDamaged, installBusy, ioFailure
    public var errorDescription: String? {
        switch self {
        case .invalidPayload: return "The bundled Network Guard could not be verified. Download the setup app again."
        case .wrongChannel: return "This setup app and Network Guard target different extension channels."
        case .unsafePath: return "An installation path is redirected or not owned by this user. No change was made."
        case .registrationConflict: return "Chrome already has a different registration for this channel. It was not replaced."
        case .managedByApp: return "Network Guard is managed by the \(DeviceGuardApp.appName) app. Use Remove in that app first. Nothing was changed."
        case .ownershipConflict: return "Existing files are not recognized as this installer's files. They were not removed."
        case .installationDamaged: return "The installation is incomplete or changed. Use Install / Repair."
        case .installBusy: return "Another setup operation is running. Try again when it finishes."
        case .ioFailure: return "Setup could not finish. Check your user folder permissions, then retry."
        }
    }
}

/// The Device Guard app's identity on macOS, as `scripts/device-bundle.mjs` and
/// `device/src/identity.rs` define it. The app's bundle is `<app name>.app`, and
/// the host Chrome starts is its nested shim, `Contents/MacOS/anon-guard-host`.
/// Setup never starts, reads or changes the app; it only recognizes the
/// registration the app writes so it can leave it alone.
public enum DeviceGuardApp {
    /// The app's name for an extension channel, or nil for any other channel.
    static func appName(for channel: String) -> String? {
        switch channel {
        case "development": return "Anon Network Guard Dev"
        case "production": return "Anon Network Guard"
        default: return nil
        }
    }
    /// This build's app name.
    public static var appName: String { appName(for: NativeEnrollment.channel) ?? "Anon Network Guard" }

    /// True only for `<dir>/<app name>.app/Contents/MacOS/anon-guard-host`: an
    /// absolute path in which every component is a plain name (no empty, `.` or
    /// `..` component, no trailing slash), whose last four components are
    /// exactly the channel's bundle and the shim. Names that merely contain the
    /// app's words, the other channel's bundle and any other file in the bundle
    /// do not match. Case counts.
    static func isShim(path: String, channel: String) -> Bool {
        guard let name = appName(for: channel), path.hasPrefix("/"),
              !path.contains("\0"), !path.contains("\n") else { return false }
        let components = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        // "", at least one directory, then the four fixed components.
        guard components.count >= 6, components[0].isEmpty,
              components.dropFirst().allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." })
        else { return false }
        return Array(components.suffix(4)) == ["\(name).app", "Contents", "MacOS", "anon-guard-host"]
    }
}

public struct SetupPayload: Codable, Equatable {
    public let schemaVersion: Int
    public let version: String
    public let channel: String
    public let sha256: String
    public init(schemaVersion: Int = 1, version: String, channel: String, sha256: String) {
        self.schemaVersion = schemaVersion; self.version = version
        self.channel = channel; self.sha256 = sha256
    }
    public static func load(from resources: URL) throws -> SetupPayload {
        let metadataURL = resources.appendingPathComponent("payload.json")
        let values = try metadataURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size < 4096
        else { throw SetupError.invalidPayload }
        let data = try Data(contentsOf: metadataURL)
        guard data.count < 4096,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["schemaVersion", "version", "channel", "sha256"],
              let payload = try? JSONDecoder().decode(Self.self, from: data)
        else { throw SetupError.invalidPayload }
        try payload.validate()
        return payload
    }
    func validate() throws {
        guard schemaVersion == 1, version.utf8.count <= 32, sha256.utf8.count == 64,
              version.range(of: #"\A[0-9]+\.[0-9]+\.[0-9]+\z"#, options: .regularExpression) != nil,
              sha256.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil
        else { throw SetupError.invalidPayload }
        guard channel == NativeEnrollment.channel else { throw SetupError.wrongChannel }
    }
    public var directoryName: String { "\(version)-\(sha256)" }
}

public struct InstallationReceipt: Codable, Equatable {
    public let schemaVersion: Int
    public let owner: String
    public let channel: String
    public var versions: [SetupPayload]
    static let ownerID = "inc.anon.network-helper.setup.v1"
}

public enum InstallationState: Equatable {
    case notInstalled, installed(version: String), needsRepair
}

/// What the receipt records and which version Chrome's registration points at.
/// `registration` is `none`, `owned` (one of the receipt's versions), `app` (the
/// Device Guard app's shim, which is installed), `staleApp` (that shim's path,
/// but the app is gone) or `foreign` (another program's manifest, such as a
/// development bridge).
public struct InstallationInventory: Equatable {
    public let versions: [SetupPayload]
    public let active: SetupPayload?
    public let registration: String
}

/// User-only filesystem operations. No Process, VPN API, permission request, or network client.
/// Callers cannot supply an origin, native host name, executable arguments, or registration path.
public final class UserInstaller {
    public let root: URL
    public let registration: URL
    private let home: URL
    private let fm = FileManager.default
    // Test-only interruption seam: never configurable from the app or native protocol.
    var beforeRegistration: (() throws -> Void)?

    public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
        self.home = home.standardizedFileURL.resolvingSymlinksInPath()
        root = self.home.appendingPathComponent("Library/Application Support/Anon/NetworkHelper/\(NativeEnrollment.channel)")
        registration = self.home.appendingPathComponent("Library/Application Support/Google/Chrome/NativeMessagingHosts/\(NativeEnrollment.hostName).json")
    }
    private var receiptURL: URL { root.appendingPathComponent("installation.json") }
    private var versionsURL: URL { root.appendingPathComponent("versions") }
    private func executable(_ payload: SetupPayload) -> URL {
        versionsURL.appendingPathComponent(payload.directoryName).appendingPathComponent("anon-network-helper")
    }
    /// Where a receipt version's helper lives. Reporting only; it is not validated here.
    public func helperURL(_ payload: SetupPayload) -> URL { executable(payload) }
    public static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
    private func bytes(_ url: URL, limit: Int = 64 * 1024 * 1024) throws -> Data {
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= limit
        else { throw SetupError.invalidPayload }
        return try Data(contentsOf: url)
    }
    /// Reject symlinks in every managed path component and group/world-writable destinations.
    private func safe(_ url: URL) throws {
        let path = url.standardizedFileURL.path
        guard path.hasPrefix(home.path + "/") else { throw SetupError.unsafePath }
        var cursor = home
        for component in path.dropFirst(home.path.count + 1).split(separator: "/") {
            cursor.appendPathComponent(String(component))
            var info = stat()
            if lstat(cursor.path, &info) != 0 {
                guard errno == ENOENT else { throw SetupError.unsafePath }
                continue
            }
            guard info.st_uid == getuid(), info.st_mode & S_IFMT != S_IFLNK,
                  info.st_mode & 0o022 == 0 else { throw SetupError.unsafePath }
        }
    }
    private func makeDirectory(_ url: URL) throws {
        try safe(url)
        try fm.createDirectory(at: url, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try safe(url)
    }
    private func write<T: Encodable>(_ object: T, to url: URL) throws {
        try safe(url)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(object).write(to: url, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    private func receipt() throws -> InstallationReceipt? {
        try safe(root); try safe(receiptURL)
        guard fm.fileExists(atPath: receiptURL.path) else {
            if fm.fileExists(atPath: root.path), !(try fm.contentsOfDirectory(atPath: root.path)).isEmpty {
                throw SetupError.ownershipConflict
            }
            return nil
        }
        guard let value = try? JSONDecoder().decode(InstallationReceipt.self, from: bytes(receiptURL, limit: 65536)),
              value.schemaVersion == 1, value.owner == InstallationReceipt.ownerID,
              value.channel == NativeEnrollment.channel, value.versions.count <= 128,
              Set(value.versions.map(\.directoryName)).count == value.versions.count
        else { throw SetupError.ownershipConflict }
        for payload in value.versions { try payload.validate() }
        return value
    }
    /// Who owns Chrome's registration for this channel's host.
    private enum Registration {
        case none
        case owned(SetupPayload)
        case app
        case staleApp
    }
    /// Whether anything is at `path`, without following a final symlink. Only a
    /// definite "no such entry" counts as gone, so a doubt keeps the app's claim.
    private func entryExists(_ path: String) -> Bool {
        var info = stat()
        if lstat(path, &info) == 0 { return true }
        return errno != ENOENT && errno != ENOTDIR
    }
    /// Any manifest that is not exactly this channel's host (name, type, origins
    /// and the five keys) is foreign. A matching one is owned when it points at a
    /// receipt version, the Device Guard app's when it points at that app's shim
    /// for this channel, and foreign otherwise.
    private func classifyRegistration(_ receipt: InstallationReceipt?) throws -> Registration {
        try safe(registration)
        guard fm.fileExists(atPath: registration.path) else { return .none }
        let data = try bytes(registration, limit: 16384)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["name", "description", "path", "type", "allowed_origins"],
              let manifest = try? JSONDecoder().decode(NativeEnrollment.Manifest.self, from: data),
              manifest.name == NativeEnrollment.hostName,
              manifest.type == "stdio",
              manifest.allowed_origins == NativeEnrollment.allowedExtensionIDs.sorted().map({ "chrome-extension://\($0)/" })
        else { throw SetupError.registrationConflict }
        // Description is display copy, not identity. Branding changes must not
        // strand a receipt-owned installation or relax path/origin validation.
        if let payload = receipt?.versions.first(where: { executable($0).path == manifest.path }) {
            return .owned(payload)
        }
        if DeviceGuardApp.isShim(path: manifest.path, channel: NativeEnrollment.channel) {
            return entryExists(manifest.path) ? .app : .staleApp
        }
        throw SetupError.registrationConflict
    }
    /// The receipt version Chrome's registration points at. Nil means there is no
    /// registration for Setup to keep: none, or the leftover of a Device Guard app
    /// that is gone. Install, repair and activate may replace that leftover;
    /// uninstall never removes it, because only a non-nil result is Setup's own.
    /// Throws `managedByApp` while the app is installed, and `registrationConflict`
    /// for any other registration.
    private func registeredVersion(_ receipt: InstallationReceipt?) throws -> SetupPayload? {
        switch try classifyRegistration(receipt) {
        case .owned(let payload): return payload
        case .none, .staleApp: return nil
        case .app: throw SetupError.managedByApp
        }
    }
    public func check() throws -> InstallationState {
        let record = try receipt()
        let active = try registeredVersion(record)
        guard let record else { return .notInstalled }
        guard let active else { return .needsRepair }
        let binary = executable(active)
        try safe(binary)
        guard let data = try? bytes(binary), Self.digest(data) == active.sha256,
              fm.isExecutableFile(atPath: binary.path), record.versions.contains(active)
        else { return .needsRepair }
        return .installed(version: active.version)
    }
    public func install(payload: SetupPayload, bundledHelper: URL) throws {
        try payload.validate()
        guard bundledHelper.resolvingSymlinksInPath() == bundledHelper.standardizedFileURL
        else { throw SetupError.invalidPayload }
        let data = try bytes(bundledHelper)
        guard Self.digest(data) == payload.sha256 else { throw SetupError.invalidPayload }
        // Conflict checks precede even directory creation.
        _ = try registeredVersion(try receipt())
        try withLock {
            var record = try receipt() ?? InstallationReceipt(schemaVersion: 1,
                owner: InstallationReceipt.ownerID, channel: NativeEnrollment.channel, versions: [])
            _ = try registeredVersion(record)
            let binary = executable(payload)
            try safe(binary)
            if fm.fileExists(atPath: binary.deletingLastPathComponent().path) {
                guard record.versions.contains(payload),
                      Set(try fm.contentsOfDirectory(atPath: binary.deletingLastPathComponent().path)).isSubset(of: ["anon-network-helper"])
                else { throw SetupError.ownershipConflict }
            }
            try makeDirectory(root)
            if !record.versions.contains(payload) {
                guard record.versions.count < 128 else { throw SetupError.ownershipConflict }
                record.versions.append(payload)
            }
            // Journal ownership before materializing a version. An interrupted copy is repairable;
            // the existing manifest still points to the previously complete version.
            try write(record, to: receiptURL)
            try makeDirectory(binary.deletingLastPathComponent())
            try data.write(to: binary, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
            guard Self.digest(try bytes(binary)) == payload.sha256 else { throw SetupError.invalidPayload }
            try beforeRegistration?()
            try makeDirectory(registration.deletingLastPathComponent())
            _ = try registeredVersion(record)
            try write(NativeEnrollment.manifest(executablePath: binary.path), to: registration)
        }
    }
    /// Lists the receipt's versions (oldest first) without changing anything.
    /// A foreign registration, or the Device Guard app's, is reported rather
    /// than thrown, so tooling can show what is installed while another program
    /// owns Chrome's registration.
    public func inventory() throws -> InstallationInventory {
        let record = try receipt()
        let versions = record?.versions ?? []
        do {
            switch try classifyRegistration(record) {
            case .none: return InstallationInventory(versions: versions, active: nil, registration: "none")
            case .owned(let active): return InstallationInventory(versions: versions, active: active, registration: "owned")
            case .app: return InstallationInventory(versions: versions, active: nil, registration: "app")
            case .staleApp: return InstallationInventory(versions: versions, active: nil, registration: "staleApp")
            }
        } catch SetupError.registrationConflict {
            return InstallationInventory(versions: versions, active: nil, registration: "foreign")
        }
    }
    /// Points Chrome's registration at an already installed, intact version, for
    /// rollback. Like install, it never replaces a registration it does not own.
    public func activate(directory: String) throws -> SetupPayload {
        try withLock {
            guard let record = try receipt(),
                  let payload = record.versions.first(where: { $0.directoryName == directory })
            else { throw SetupError.installationDamaged }
            _ = try registeredVersion(record)
            let binary = executable(payload)
            try safe(binary)
            guard let data = try? bytes(binary), Self.digest(data) == payload.sha256,
                  fm.isExecutableFile(atPath: binary.path)
            else { throw SetupError.installationDamaged }
            try makeDirectory(registration.deletingLastPathComponent())
            try write(NativeEnrollment.manifest(executablePath: binary.path), to: registration)
            return payload
        }
    }
    public func uninstall() throws {
        guard let initial = try receipt() else {
            _ = try registeredVersion(nil)
            return
        }
        _ = try registeredVersion(initial)
        try withLock {
            guard let record = try receipt() else { return }
            let ownedRegistration = try registeredVersion(record)
            // Validate all targets before deleting anything. Never recursively delete an owned root.
            for payload in record.versions {
                let binary = executable(payload)
                try safe(binary)
                var binaryInfo = stat()
                if lstat(binary.path, &binaryInfo) == 0 {
                    guard binaryInfo.st_mode & S_IFMT == S_IFREG else { throw SetupError.ownershipConflict }
                } else if errno != ENOENT {
                    throw SetupError.unsafePath
                }
                if fm.fileExists(atPath: binary.deletingLastPathComponent().path) {
                    guard Set(try fm.contentsOfDirectory(atPath: binary.deletingLastPathComponent().path)).isSubset(of: ["anon-network-helper"])
                    else { throw SetupError.ownershipConflict }
                }
            }
            // Only a manifest that points at a receipt version is this installer's to
            // remove. A stale Device Guard app registration stays as it is.
            if ownedRegistration != nil, fm.fileExists(atPath: registration.path) { try fm.removeItem(at: registration) }
            for payload in record.versions {
                let binary = executable(payload)
                if fm.fileExists(atPath: binary.path) { try fm.removeItem(at: binary) }
                try removeEmpty(binary.deletingLastPathComponent())
            }
            try fm.removeItem(at: receiptURL)
            try removeEmpty(versionsURL)
            try removeEmpty(root)
        }
    }
    private func removeEmpty(_ url: URL) throws {
        try safe(url)
        if fm.fileExists(atPath: url.path), try fm.contentsOfDirectory(atPath: url.path).isEmpty {
            try fm.removeItem(at: url)
        }
    }
    private func withLock<T>(_ operation: () throws -> T) throws -> T {
        // A per-user, no-follow advisory lock is not an authorization boundary.
        let lockPath = NSTemporaryDirectory() + "inc.anon.network-helper.setup.\(NativeEnrollment.channel).lock"
        let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw SetupError.installBusy }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
              info.st_mode & 0o077 == 0, flock(fd, LOCK_EX | LOCK_NB) == 0
        else { throw SetupError.installBusy }
        defer { flock(fd, LOCK_UN) }
        return try operation()
    }
}
