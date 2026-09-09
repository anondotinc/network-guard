import Foundation
import Security
import Darwin

public enum MullvadStatus {
    /// Parse only the state discriminant, never expose the details (IPs, locations, keys).
    /// Warnings before JSON, future shapes, and unknown states fail closed.
    public static func parse(_ data: Data, version: String) throws -> ProviderSnapshot {
        guard data.count <= 65536,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let state = object["state"] as? String,
              ["connected", "connecting", "disconnected", "disconnecting", "error"].contains(state)
        else { throw HelperError.unrecognizedStatus }
        return ProviderSnapshot(providerVersion: version, tunnel: state)
    }
}

/// Read-only macOS spike. No subprocess arguments or paths come from a request.
public struct MullvadReader: ProviderReading {
    public static let appPath = "/Applications/Mullvad VPN.app"
    public static let cliPath = appPath + "/Contents/Resources/mullvad"
    // Locally observed signed 2026.4 installation. Independently confirm vendor identity
    // before release; do not learn a replacement pin from an arbitrary installed app.
    private static let requirement = "anchor apple generic and identifier \"mullvad\" and certificate leaf[subject.OU] = \"CKG9MXH72F\""
    public init() {}

    public func status() throws -> ProviderSnapshot {
        try validateInstallation()
        let output = try Self.readBoundedOutput(executablePath: Self.cliPath, arguments: ["status", "--json"])
        return try MullvadStatus.parse(output, version: "2026.4")
    }

    func validateInstallation() throws {
        guard FileManager.default.isExecutableFile(atPath: Self.cliPath) else { throw HelperError.notInstalled }
        let original = URL(fileURLWithPath: Self.cliPath)
        guard original.resolvingSymlinksInPath().path == Self.cliPath else { throw HelperError.untrustedInstallation }
        try validateSignature(original)
        let plistURL = URL(fileURLWithPath: Self.appPath + "/Contents/Info.plist")
        guard let data = try? Data(contentsOf: plistURL),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let version = plist["CFBundleShortVersionString"] as? String,
              version == "2026.4" else { throw HelperError.unsupportedProviderVersion }
    }

    private func validateSignature(_ url: URL) throws {
        var code: SecStaticCode?
        var requirement: SecRequirement?
        guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess,
              let code,
              SecRequirementCreateWithString(Self.requirement as CFString, [], &requirement) == errSecSuccess,
              let requirement else { throw HelperError.untrustedInstallation }
        // Explicitly forbid certificate validation network access in this read-only probe.
        let flags = SecCSFlags(rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures).union(.noNetworkAccess)
        guard SecStaticCodeCheckValidity(code, flags, requirement) == errSecSuccess else {
            throw HelperError.untrustedInstallation
        }
    }

    // Internal seam for local synthetic subprocess tests, never exposed by the host protocol.
    static func readBoundedOutput(executablePath: String, arguments: [String], timeout: TimeInterval = 3, limit: Int = 65536) throws -> Data {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: executablePath)
        child.arguments = arguments
        child.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        child.standardInput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        let pipe = Pipe()
        child.standardOutput = pipe
        do { try child.run() } catch { throw HelperError.providerUnavailable }
        // Read the pipe without an unbounded wait or buffer. Never persist the raw output.
        let fd = pipe.fileHandleForReading.fileDescriptor
        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        var output = Data()
        defer {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
            try? pipe.fileHandleForReading.close()
        }
        while true {
            if ProcessInfo.processInfo.systemUptime >= deadline { throw HelperError.providerTimeout }
            var descriptor = pollfd(fd: fd, events: Int16(POLLIN | POLLHUP), revents: 0)
            let ready = poll(&descriptor, 1, 50)
            if ready < 0 {
                if errno == EINTR { continue }
                throw HelperError.providerUnavailable
            }
            if ready == 0 { continue }
            if descriptor.revents & Int16(POLLERR | POLLNVAL) != 0 { throw HelperError.providerUnavailable }
            var bytes = [UInt8](repeating: 0, count: 4096)
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR { continue }
                throw HelperError.providerUnavailable
            }
            guard output.count + count <= limit else { throw HelperError.oversizedOutput }
            output.append(contentsOf: bytes.prefix(count))
        }
        // A process could close stdout but remain hung. Still respect the same deadline.
        while child.isRunning {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw HelperError.providerTimeout }
            usleep(10_000)
        }
        guard child.terminationStatus == 0 else { throw HelperError.providerUnavailable }
        return output
    }
}
