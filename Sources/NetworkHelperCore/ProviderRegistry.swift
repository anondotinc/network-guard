import Foundation
import Security
import Darwin

public enum VPNProvider: String, Codable, CaseIterable {
    case mullvad, ivpn, nordvpn
    public var capabilities: [String] {
        self == .nordvpn ? ["open-app"] : ["read-status", "connect-selected"]
    }
}

public struct ProviderAvailability: Codable, Equatable {
    public let provider: VPNProvider
    public let capabilities: [String]
    public let available: Bool
    public let error: HelperError?
}

public protocol VPNAdapter {
    func validate() throws
    func status() throws -> ProviderSnapshot
    func connect() throws -> ProviderSnapshot
    func openApp() throws
}

/// A caller can choose a registered provider, never an executable, URL or arguments.
/// v1 and v2 remain Mullvad-only. v3 cannot silently fall back to another provider.
public struct ProviderRegistry {
    private let adapter: (VPNProvider) -> VPNAdapter
    private let enabled: Bool
    public init(enabled: Bool, adapter: @escaping (VPNProvider) -> VPNAdapter = defaultVPNAdapter) {
        self.enabled = enabled
        self.adapter = adapter
    }
    public func handle(_ data: Data) -> ProviderResponse {
        var id: String?
        do {
            guard data.count <= NativeFrames.maxBytes,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == Set(["v", "id", "method", "provider"]),
                  let requestID = object["id"] as? String, requestID.count == 36,
                  UUID(uuidString: requestID) != nil,
                  let method = object["method"] as? String,
                  let rawProvider = object["provider"] as? String,
                  let provider = VPNProvider(rawValue: rawProvider)
            else { throw HelperError.invalidRequest }
            id = requestID.lowercased()
            guard let version = object["v"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), version == 3
            else { throw HelperError.unsupportedVersion }
            guard enabled else { throw HelperError.unsupportedMethod }
            let selected = adapter(provider)
            if method == "probe" {
                do {
                    try selected.validate()
                    return ProviderResponse(id: id, availability: ProviderAvailability(
                        provider: provider, capabilities: provider.capabilities, available: true, error: nil))
                } catch {
                    return ProviderResponse(id: id, availability: ProviderAvailability(
                        provider: provider, capabilities: provider.capabilities, available: false,
                        error: error as? HelperError ?? .providerUnavailable))
                }
            }
            if method == "status" && provider != .nordvpn {
                return ProviderResponse(id: id, snapshot: try selected.status())
            }
            if method == "connectSelected" && provider != .nordvpn {
                return try ConnectionLock.withLock {
                    let before = try selected.status()
                    if before.tunnel == "connected" || before.tunnel == "connecting" {
                        return ProviderResponse(id: id, snapshot: before)
                    }
                    guard before.tunnel == "disconnected" else { throw HelperError.providerUnavailable }
                    // Check known alternate adapters inside the cross-process lock.
                    // No generic utun/IP inference: unknown VPNs are not claimed detected.
                    for other in [VPNProvider.mullvad, .ivpn] where other != provider {
                        do {
                            try adapter(other).validate()
                        } catch HelperError.notInstalled { continue }
                          catch { throw HelperError.providerConflict }
                        // Do not start a second tunnel when the known app is active,
                        // or when its status cannot safely be determined.
                        guard let state = try? adapter(other).status() else { throw HelperError.providerConflict }
                        guard state.tunnel == "disconnected" else { throw HelperError.providerConflict }
                    }
                    return ProviderResponse(id: id, snapshot: try selected.connect())
                }
            }
            if method == "openApp" && provider == .nordvpn {
                try selected.openApp()
                return ProviderResponse(id: id, opened: provider)
            }
            throw HelperError.unsupportedMethod
        } catch {
            return ProviderResponse(id: id, error: error as? HelperError ?? .providerUnavailable)
        }
    }
}

public struct ProviderResponse: Encodable {
    public let v = 3
    public let id: String?
    public let ok: Bool
    public let error: HelperError?
    public let snapshot: ProviderSnapshot?
    public let availability: ProviderAvailability?
    public let opened: VPNProvider?
    init(id: String?, error: HelperError? = nil, snapshot: ProviderSnapshot? = nil,
         availability: ProviderAvailability? = nil, opened: VPNProvider? = nil) {
        self.id = id; self.ok = error == nil; self.error = error
        self.snapshot = snapshot; self.availability = availability; self.opened = opened
    }
}

public func defaultVPNAdapter(_ provider: VPNProvider) -> VPNAdapter {
    switch provider {
    case .mullvad: return MullvadAdapter()
    case .ivpn: return IVPNAdapter()
    case .nordvpn: return NordVPNAdapter()
    }
}

struct MullvadAdapter: VPNAdapter {
    func validate() throws { try MullvadReader().validateInstallation() }
    func status() throws -> ProviderSnapshot { try MullvadReader().status() }
    // Registry already holds the cross-provider lock.
    func connect() throws -> ProviderSnapshot {
        try SelectedConnection.ensure(status: status, connect: {
            try validate()
            _ = try MullvadReader.readBoundedOutput(executablePath: MullvadReader.cliPath, arguments: ["connect"])
        })
    }
    func openApp() throws { throw HelperError.unsupportedMethod }
}

enum ConnectionLock {
    static func withLock<T>(_ operation: () throws -> T) throws -> T {
        let path = NSTemporaryDirectory() + "inc.anon.network_helper.connect.lock"
        let fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw HelperError.providerUnavailable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw HelperError.controlBusy }
        defer { flock(fd, LOCK_UN) }
        return try operation()
    }
}

/// Fixed identities obtained from official signed distributions. No network
/// access during certificate verification, and no following caller-chosen paths.
enum SignedVPNInstallation {
    static func validate(path: String, identifier: String, team: String) throws {
        guard FileManager.default.fileExists(atPath: path) else { throw HelperError.notInstalled }
        let url = URL(fileURLWithPath: path)
        guard url.resolvingSymlinksInPath().path == path else { throw HelperError.untrustedInstallation }
        var code: SecStaticCode?
        var requirement: SecRequirement?
        let expression = "anchor apple generic and identifier \"\(identifier)\" and certificate leaf[subject.OU] = \"\(team)\""
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              let code,
              SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
              let requirement,
              SecStaticCodeCheckValidity(code, SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures).union(.noNetworkAccess), requirement) == errSecSuccess
        else { throw HelperError.untrustedInstallation }
    }
    static func version(app: String) throws -> String {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: app + "/Contents/Info.plist")),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let version = plist["CFBundleShortVersionString"] as? String
        else { throw HelperError.unsupportedProviderVersion }
        return version
    }
}
