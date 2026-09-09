import Foundation

public enum IVPNStatus {
    /// IVPN CLI 3.15.15 prints a single top-level `VPN : STATE` line.
    /// Everything else (account ID, IPs, servers, DNS) is discarded in-process.
    public static func parse(_ data: Data) throws -> ProviderSnapshot {
        guard data.count <= 65536, let text = String(data: data, encoding: .utf8)
        else { throw HelperError.unrecognizedStatus }
        let lines = text.components(separatedBy: .newlines)
        let states = lines.compactMap { line -> String? in
            guard line.hasPrefix("VPN"), let colon = line.firstIndex(of: ":"),
                  line[..<colon].trimmingCharacters(in: .whitespaces) == "VPN" else { return nil }
            return String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        guard states.count == 1 else { throw HelperError.unrecognizedStatus }
        let tunnel: String
        switch states[0] {
        case "CONNECTED": tunnel = text.contains("WARNING! Unhealthy Connection") ? "error" : "connected"
        case "DISCONNECTED": tunnel = "disconnected"
        case "CONNECTING", "WAIT", "AUTH", "GETCONFIG", "ASSIGNIP", "ADDROUTES", "RECONNECTING", "TCP_CONNECT", "INITIALISED": tunnel = "connecting"
        case "EXITING": tunnel = "disconnecting"
        default:
            // A paused VPN must not be green or silently resumed by auto-connect.
            guard states[0] == "PAUSED" || states[0].hasPrefix("PAUSED till ") else { throw HelperError.unrecognizedStatus }
            tunnel = "error"
        }
        return ProviderSnapshot(provider: "ivpn", providerVersion: "3.15.15", tunnel: tunnel)
    }
}

public struct IVPNAdapter: VPNAdapter {
    public static let appPath = "/Applications/IVPN.app"
    public static let cliPath = appPath + "/Contents/MacOS/cli/ivpn"
    private let validateInstallation: () throws -> Void
    private let run: ([String], TimeInterval) throws -> Data
    public init() {
        validateInstallation = Self.verifyInstallation
        run = { arguments, timeout in
            try MullvadReader.readBoundedOutput(executablePath: Self.cliPath, arguments: arguments, timeout: timeout)
        }
    }
    // Internal dependency seam for command-policy tests; never exposed to IPC.
    init(validateInstallation: @escaping () throws -> Void,
         run: @escaping ([String], TimeInterval) throws -> Data) {
        self.validateInstallation = validateInstallation
        self.run = run
    }
    private static func verifyInstallation() throws {
        try SignedVPNInstallation.validate(path: Self.appPath, identifier: "com.electron.ivpn-ui", team: "WQXXM75BYN")
        try SignedVPNInstallation.validate(path: Self.cliPath, identifier: "ivpn", team: "WQXXM75BYN")
        guard try SignedVPNInstallation.version(app: Self.appPath) == "3.15.15" else { throw HelperError.unsupportedProviderVersion }
    }
    public func validate() throws { try validateInstallation() }
    public func status() throws -> ProviderSnapshot {
        try validate()
        return try IVPNStatus.parse(run(["status"], 3))
    }
    public func connect() throws -> ProviderSnapshot {
        try SelectedConnection.ensure(status: status, connect: {
            try validate()
            // Official CLI reuses last parameters and enables IVPN's firewall
            // during this connection. UI consent explicitly describes both.
            // Never pick fastest/random, log in, or supply account credentials.
            _ = try run(["connect", "-last"], 18)
        })
    }
    public func openApp() throws { throw HelperError.unsupportedMethod }
}
