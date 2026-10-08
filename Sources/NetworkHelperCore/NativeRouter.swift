import Foundation
import CoreFoundation

/// What this build can do per provider. v8 discovery reports it; the frozen v4
/// inventory and the legacy `VPNProvider.capabilities` probe list stay unchanged.
/// Keep in step with `conformance/README.md` and the Rust helper's table.
public enum PlatformCapabilities {
    public static let platform = "macos"
    public static var arch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x86_64"
        #endif
    }
    public static let protocols = [1, 2, 3, 4, 5, 6, 8]
    public static func capabilities(_ provider: VPNProvider) -> [String] {
        switch provider {
        case .mullvad, .ivpn: return ["read-status", "connect-selected"]
        case .nordvpn: return ["open-app"]
        case .protonvpn: return ["open-app", "read-status"]
        }
    }
}

/// v8 discovery: the same static, provider-free read as v4, plus the platform
/// and a per-provider capability map, because capabilities now differ by OS.
public struct PlatformDescription: Codable, Equatable {
    public let version: String
    public let build: Int
    public let channel: String
    public let platform: String
    public let arch: String
    public let protocols: [Int]
    public let providers: [String: [String]]
    public static let current = PlatformDescription(
        version: NetworkGuardBuild.version, build: NetworkGuardBuild.build, channel: NativeEnrollment.channel,
        platform: PlatformCapabilities.platform, arch: PlatformCapabilities.arch,
        protocols: PlatformCapabilities.protocols,
        providers: Dictionary(uniqueKeysWithValues: VPNProvider.allCases.map {
            ($0.rawValue, PlatformCapabilities.capabilities($0))
        }))
}

public struct PlatformDiscoveryResponse: Encodable {
    public let v = 8
    public let id: String?
    public let ok: Bool
    public let helper: PlatformDescription?
    public let error: HelperError?
}

public struct PlatformDiscoveryService {
    public init() {}
    public func handle(_ data: Data) -> PlatformDiscoveryResponse {
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
                  CFGetTypeID(version) != CFBooleanGetTypeID(), version == 8
            else { throw HelperError.unsupportedVersion }
            guard method == "describe" else { throw HelperError.unsupportedMethod }
            return PlatformDiscoveryResponse(id: id, ok: true, helper: .current, error: nil)
        } catch {
            return PlatformDiscoveryResponse(id: id, ok: false, helper: nil,
                                             error: error as? HelperError ?? .invalidRequest)
        }
    }
}

/// One request frame in, one encoded response frame body out. Any version not
/// routed here (including the retired v7) reaches the v1 service, which answers
/// `unsupportedVersion`.
public struct NativeRouter {
    private let service: HelperService
    private let controls: ConnectionControlService
    private let providers: ProviderRegistry
    public init(service: HelperService, controls: ConnectionControlService, providers: ProviderRegistry) {
        self.service = service
        self.controls = controls
        self.providers = providers
    }
    public static func live() -> NativeRouter {
        NativeRouter(service: HelperService(provider: MullvadReader()),
                     controls: ConnectionControlService(provider: MullvadReader(),
                                                        enabled: NativeEnrollment.supportsConnectionControl),
                     providers: ProviderRegistry(enabled: NativeEnrollment.supportsConnectionControl))
    }
    public func respond(_ payload: Data) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        switch object?["v"] as? Int {
        case 8: return try encoder.encode(PlatformDiscoveryService().handle(payload))
        case 6: return try encoder.encode(providers.handle(payload, version: 6))
        case 5: return try encoder.encode(providers.handle(payload, version: 5))
        case 4: return try encoder.encode(DiscoveryService().handle(payload))
        case 3: return try encoder.encode(providers.handle(payload))
        case 2: return try encoder.encode(controls.handle(payload))
        default: return try encoder.encode(service.handle(payload))
        }
    }
}
