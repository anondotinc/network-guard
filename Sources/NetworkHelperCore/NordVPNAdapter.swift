import Foundation

/// Launch-only adapter for NordVPN's signed website distribution. No CLI,
/// UI scripting, connection inference, account access or automatic launch.
public struct NordVPNAdapter: VPNAdapter {
    public static let appPath = "/Applications/NordVPN.app"
    public init() {}
    public func validate() throws {
        try SignedVPNInstallation.validate(path: Self.appPath, identifier: "com.nordvpn.macos", team: "W5W395V82Y")
    }
    public func status() throws -> ProviderSnapshot { throw HelperError.unsupportedMethod }
    public func connect() throws -> ProviderSnapshot { throw HelperError.unsupportedMethod }
    public func openApp() throws {
        try validate()
        // Success means Launch Services accepted the open request, not that a
        // tunnel is connected. Nord's own startup preferences may connect it.
        _ = try MullvadReader.readBoundedOutput(executablePath: "/usr/bin/open", arguments: ["-a", Self.appPath])
    }
}
