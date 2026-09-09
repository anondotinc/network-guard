import Foundation
import CoreFoundation

public enum HelperError: String, Error, Codable {
    case invalidRequest, unsupportedVersion, unsupportedMethod, invalidFrame
    case notInstalled, untrustedInstallation, unsupportedProviderVersion
    case providerUnavailable, providerTimeout, oversizedOutput, unrecognizedStatus
    case controlBusy, providerConflict
}

public struct HelperRequest {
    public let id: String
    public let method: String

    public static func parse(_ data: Data) throws -> HelperRequest {
        guard data.count <= NativeFrames.maxBytes,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(object.keys) == Set(["v", "id", "method"]),
              let id = object["id"] as? String, id.count == 36,
              UUID(uuidString: id) != nil,
              let method = object["method"] as? String else { throw HelperError.invalidRequest }
        // NSNumber bridges booleans to integers; reject true instead of treating it as version 1.
        guard let version = object["v"] as? NSNumber,
              CFGetTypeID(version) != CFBooleanGetTypeID(), version == 1 else {
            throw HelperError.unsupportedVersion
        }
        guard ["capabilities", "status"].contains(method) else { throw HelperError.unsupportedMethod }
        return HelperRequest(id: id.lowercased(), method: method)
    }
}

public struct ProviderSnapshot: Codable, Equatable {
    public let provider: String
    public let installation: String
    public let providerVersion: String?
    public let tunnel: String
    public let protection: String
    public let reason: String

    public init(provider: String = "mullvad", installation: String = "verified-local-signature", providerVersion: String? = nil,
                tunnel: String = "unknown", reason: String = "route-not-verified") {
        self.provider = provider
        self.installation = installation
        self.providerVersion = providerVersion
        self.tunnel = tunnel
        self.protection = "unknown"
        self.reason = reason
    }
}

public protocol ProviderReading {
    func status() throws -> ProviderSnapshot
}

public struct HelperResponse: Encodable {
    public var v: Int = 1
    public let id: String?
    public let ok: Bool
    public let error: HelperError?
    public let snapshot: ProviderSnapshot?
    public let capabilities: [String]?
}

public struct HelperService {
    private let provider: ProviderReading
    public init(provider: ProviderReading) { self.provider = provider }

    public func handle(_ data: Data) -> HelperResponse {
        var id: String?
        do {
            let request = try HelperRequest.parse(data)
            id = request.id
            if request.method == "capabilities" {
                return HelperResponse(id: id, ok: true, error: nil, snapshot: nil,
                                      capabilities: ["read-status", "read-only-prototype"])
            }
            return HelperResponse(id: id, ok: true, error: nil, snapshot: try provider.status(), capabilities: nil)
        } catch {
            // Never forward CLI stdout/stderr, account IDs, network addresses or raw exceptions.
            return HelperResponse(id: id, ok: false, error: error as? HelperError ?? .providerUnavailable,
                                  snapshot: nil, capabilities: nil)
        }
    }
}
