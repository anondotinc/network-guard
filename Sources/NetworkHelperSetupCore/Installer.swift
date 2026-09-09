import Foundation
import CryptoKit
import Darwin
import NetworkHelperCore

public enum SetupError: String, Error, LocalizedError {
    case invalidPayload, wrongChannel, unsafePath, registrationConflict, ownershipConflict
    case installationDamaged, installBusy, ioFailure
    public var errorDescription: String? {
        switch self {
        case .invalidPayload: return "The bundled Network Guard could not be verified. Download the setup app again."
        case .wrongChannel: return "This setup app and Network Guard target different extension channels."
        case .unsafePath: return "An installation path is redirected or not owned by this user. No change was made."
        case .registrationConflict: return "Chrome already has a different registration for this channel. It was not replaced."
        case .ownershipConflict: return "Existing files are not recognized as this installer's files. They were not removed."
        case .installationDamaged: return "The installation is incomplete or changed. Use Install / Repair."
        case .installBusy: return "Another setup operation is running. Try again when it finishes."
        case .ioFailure: return "Setup could not finish. Check your user folder permissions, then retry."
        }
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
    var directoryName: String { "\(version)-\(sha256)" }
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
    private func registeredVersion(_ receipt: InstallationReceipt?) throws -> SetupPayload? {
        try safe(registration)
        guard fm.fileExists(atPath: registration.path) else { return nil }
        let data = try bytes(registration, limit: 16384)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == ["name", "description", "path", "type", "allowed_origins"],
              let manifest = try? JSONDecoder().decode(NativeEnrollment.Manifest.self, from: data),
              let receipt,
              let payload = receipt.versions.first(where: { executable($0).path == manifest.path }),
              manifest.name == NativeEnrollment.hostName,
              manifest.type == "stdio",
              manifest.allowed_origins == NativeEnrollment.allowedExtensionIDs.sorted().map({ "chrome-extension://\($0)/" })
        else { throw SetupError.registrationConflict }
        // Description is display copy, not identity. Branding changes must not
        // strand a receipt-owned installation or relax path/origin validation.
        return payload
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
    public func uninstall() throws {
        guard let initial = try receipt() else {
            _ = try registeredVersion(nil)
            return
        }
        _ = try registeredVersion(initial)
        try withLock {
            guard let record = try receipt() else { return }
            _ = try registeredVersion(record)
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
            if fm.fileExists(atPath: registration.path) { try fm.removeItem(at: registration) }
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
