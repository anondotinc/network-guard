import Foundation
import SystemConfiguration

/// Explicit launch plus read-only macOS WireGuard status. No connection command,
/// process-presence inference, public-IP lookup or caller-chosen service is used.
public struct ProtonVPNAdapter: VPNAdapter {
    public static let appPath = "/Applications/ProtonVPN.app"
    public static let statusVersion = "6.5.1"
    private let validateInstallation: () throws -> Void
    private let run: ([String], TimeInterval) throws -> Data
    private let readVersion: () throws -> String
    private let services: () throws -> [ProtonVPNService]
    private let readStatus: ([String], TimeInterval) throws -> Data

    public init() {
        validateInstallation = {
            // Independently confirmed in Proton's macOS project; see docs/provenance.md.
            try SignedVPNInstallation.validate(path: Self.appPath, identifier: "ch.protonvpn.mac", team: "J6S6Q257EK")
        }
        run = { arguments, timeout in
            try MullvadReader.readBoundedOutput(executablePath: "/usr/bin/open", arguments: arguments, timeout: timeout)
        }
        readVersion = { try SignedVPNInstallation.version(app: Self.appPath) }
        services = ProtonVPNService.discover
        readStatus = { arguments, timeout in
            try MullvadReader.readBoundedOutput(executablePath: "/usr/sbin/scutil", arguments: arguments,
                                               timeout: timeout, limit: 65536)
        }
    }

    // Internal test seam; executable, app path and arguments are never caller-controlled.
    init(validateInstallation: @escaping () throws -> Void,
         run: @escaping ([String], TimeInterval) throws -> Data,
         readVersion: @escaping () throws -> String = { ProtonVPNAdapter.statusVersion },
         services: @escaping () throws -> [ProtonVPNService] = { [] },
         readStatus: @escaping ([String], TimeInterval) throws -> Data = { _, _ in throw HelperError.providerUnavailable }) {
        self.validateInstallation = validateInstallation
        self.run = run
        self.readVersion = readVersion
        self.services = services
        self.readStatus = readStatus
    }

    public func validate() throws { try validateInstallation() }
    public func status() throws -> ProviderSnapshot {
        try validate()
        guard try readVersion() == Self.statusVersion else { throw HelperError.unsupportedProviderVersion }
        let service = try ProtonVPNService.select(services())
        return try ProtonVPNStatus.parse(readStatus(["--nc", "status", service.id], 3))
    }
    public func connect() throws -> ProviderSnapshot { throw HelperError.unsupportedMethod }
    public func openApp() throws {
        try validate()
        // Success means only that Launch Services accepted the request. Proton's
        // own startup settings may connect it; no connection state is returned.
        _ = try run(["-a", Self.appPath], 3)
    }
}

/// Only these identity fields are retained from the macOS preferences. Never
/// read provider credentials or use a profile's editable display name as identity.
struct ProtonVPNService {
    let id: String
    let type: String
    let subtype: String
    let providerBundle: String
    let enabled: Bool

    static func discover() throws -> [Self] {
        guard let preferences = SCPreferencesCreate(nil, "Anon Network Guard" as CFString, nil),
              let services = SCNetworkServiceCopyAll(preferences) as? [SCNetworkService]
        else { throw HelperError.providerUnavailable }
        return services.compactMap { service in
            guard let id = SCNetworkServiceGetServiceID(service) as String?,
                  let interface = SCPreferencesPathGetValue(preferences, "/NetworkServices/\(id)/Interface" as CFString) as? [String: Any],
                  interface["Type"] as? String == "VPN", interface["SubType"] as? String == "ch.protonvpn.mac"
            else { return nil }
            let vpn = SCPreferencesPathGetValue(preferences, "/NetworkServices/\(id)/VPN" as CFString) as? [String: Any]
            return Self(id: id, type: "VPN", subtype: "ch.protonvpn.mac",
                        providerBundle: vpn?["NEProviderBundleIdentifier"] as? String ?? "",
                        enabled: SCNetworkServiceGetEnabled(service))
        }
    }

    static func select(_ services: [Self]) throws -> Self {
        let proton = services.filter { $0.type == "VPN" && $0.subtype == "ch.protonvpn.mac" }
        guard proton.count == 1, let service = proton.first, service.enabled,
              service.providerBundle == "ch.protonvpn.mac.WireGuard-Extension",
              service.id.count == 36, UUID(uuidString: service.id) != nil
        else { throw HelperError.providerUnavailable }
        return service
    }
}

enum ProtonVPNStatus {
    static func parse(_ output: Data) throws -> ProviderSnapshot {
        guard !output.isEmpty, output.count <= 65536,
              let text = String(data: output, encoding: .utf8),
              let first = text.split(separator: "\n", omittingEmptySubsequences: false).first
        else { throw HelperError.unrecognizedStatus }
        let states = ["Connected": "connected", "Disconnected": "disconnected",
                      "Connecting": "connecting", "Disconnecting": "disconnecting"]
        guard let tunnel = states[String(first)] else { throw HelperError.unrecognizedStatus }
        // scutil's remaining extended status may contain addresses/account data;
        // it is discarded and never persisted, logged or sent across the bridge.
        return ProviderSnapshot(provider: "protonvpn", providerVersion: ProtonVPNAdapter.statusVersion, tunnel: tunnel)
    }
}
