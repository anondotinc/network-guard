import Foundation
import CoreFoundation

/// Local build information only. Discovery never constructs or invokes a VPN adapter.
public struct HelperDescription: Codable, Equatable {
    public let version: String
    public let channel: String
    public let protocols: [Int]
    public let providers: [String]
    public let capabilities: [String]
    public static let current = HelperDescription(
        version: NetworkGuardBuild.version, channel: NativeEnrollment.channel,
        protocols: [1, 2, 3, 4], providers: ["mullvad", "ivpn", "nordvpn"],
        capabilities: ["describe", "read-status", "connect-selected", "open-provider-app"])
}

public struct DiscoveryResponse: Encodable {
    public let v = 4
    public let id: String?
    public let ok: Bool
    public let helper: HelperDescription?
    public let error: HelperError?
}

public struct DiscoveryService {
    public init() {}
    public func handle(_ data: Data) -> DiscoveryResponse {
        var id: String?
        do {
            guard data.count <= NativeFrames.maxBytes,
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == ["v", "id", "method"],
                  let requestID = object["id"] as? String, requestID.count == 36,
                  UUID(uuidString: requestID) != nil,
                  let method = object["method"] as? String else { throw HelperError.invalidRequest }
            id = requestID.lowercased()
            guard let version = object["v"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), version == 4
            else { throw HelperError.unsupportedVersion }
            guard method == "describe" else { throw HelperError.unsupportedMethod }
            return DiscoveryResponse(id: id, ok: true, helper: .current, error: nil)
        } catch {
            return DiscoveryResponse(id: id, ok: false, helper: nil,
                                     error: error as? HelperError ?? .invalidRequest)
        }
    }
}
