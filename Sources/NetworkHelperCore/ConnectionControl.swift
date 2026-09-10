import Foundation
import Darwin

public protocol ProviderConnecting {
    func connectSelected() throws -> ProviderSnapshot
}

/// A separate version/capability handshake prevents read-only v1 clients from
/// gaining control accidentally. No caller-selected CLI arguments or settings.
public struct ConnectionControlService {
    private let provider: ProviderConnecting
    private let enabled: Bool
    public init(provider: ProviderConnecting, enabled: Bool) {
        self.provider = provider
        self.enabled = enabled
    }
    public func handle(_ data: Data) -> HelperResponse {
        var id: String?
        do {
            guard data.count <= NativeFrames.maxBytes,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == Set(["v", "id", "method"]),
                  let requestID = object["id"] as? String, requestID.count == 36,
                  UUID(uuidString: requestID) != nil,
                  let method = object["method"] as? String else { throw HelperError.invalidRequest }
            id = requestID.lowercased()
            guard let version = object["v"] as? Int, version == 2 else { throw HelperError.unsupportedVersion }
            guard enabled else { throw HelperError.unsupportedMethod }
            if method == "capabilities" {
                return HelperResponse(v: 2, id: id, ok: true, error: nil, snapshot: nil,
                                      capabilities: ["connect-selected", "development-control-pilot"])
            }
            guard method == "connectSelected" else { throw HelperError.unsupportedMethod }
            return HelperResponse(v: 2, id: id, ok: true, error: nil,
                                  snapshot: try provider.connectSelected(), capabilities: nil)
        } catch {
            return HelperResponse(v: 2, id: id, ok: false,
                                  error: error as? HelperError ?? .providerUnavailable, snapshot: nil, capabilities: nil)
        }
    }
}

/// Testable policy: never interrupt an existing connection or fight a user who
/// is disconnecting. A command timeout is an uncertain result, not a rollback.
public enum SelectedConnection {
    public static func ensure(status: () throws -> ProviderSnapshot,
                              connect: () throws -> Void) throws -> ProviderSnapshot {
        let before = try status()
        if before.tunnel == "connected" || before.tunnel == "connecting" { return before }
        guard before.tunnel == "disconnected" else { throw HelperError.providerUnavailable }
        try connect()
        return try status()
    }
}

extension MullvadReader: ProviderConnecting {
    public func connectSelected() throws -> ProviderSnapshot {
        // Serialize native mutations across Chrome surfaces AND worker restarts.
        // This user-owned lock has no payload and is never used as authorization.
        let lockPath = NSTemporaryDirectory() + "inc.anon.network_helper.connect.lock"
        let fd = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw HelperError.providerUnavailable }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_uid == getuid(),
              info.st_mode & S_IFMT == S_IFREG, info.st_mode & 0o077 == 0,
              flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw HelperError.controlBusy }
        defer { flock(fd, LOCK_UN) }
        return try SelectedConnection.ensure(status: { try status() }, connect: {
            // Legacy Mullvad consent did not include querying IVPN's daemon.
            // If IVPN is installed, require the new provider-aware consent
            // instead of starting a potentially conflicting second tunnel.
            if FileManager.default.fileExists(atPath: IVPNAdapter.appPath) {
                throw HelperError.providerConflict
            }
            // Revalidate the pinned provider immediately before the only mutation.
            try validateInstallation()
            _ = try Self.readBoundedOutput(executablePath: Self.cliPath, arguments: ["connect"])
        })
    }
}
