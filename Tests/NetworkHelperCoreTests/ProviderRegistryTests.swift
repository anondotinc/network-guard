import XCTest
@testable import NetworkHelperCore

final class FakeVPNAdapter: VPNAdapter {
    let provider: VPNProvider
    var state = "disconnected"
    var installed = true
    var failure: HelperError?
    var reads = 0
    var connects = 0
    var opens = 0
    init(_ provider: VPNProvider) { self.provider = provider }
    func validate() throws {
        if !installed { throw HelperError.notInstalled }
        if let failure { throw failure }
    }
    func status() throws -> ProviderSnapshot {
        try validate(); reads += 1
        return ProviderSnapshot(provider: provider.rawValue, providerVersion: provider == .ivpn ? "3.15.15" : "2026.4", tunnel: state)
    }
    func connect() throws -> ProviderSnapshot { connects += 1; state = "connecting"; return try status() }
    func openApp() throws { try validate(); opens += 1 }
}

final class ProviderRegistryTests: XCTestCase {
    let id = "00000000-0000-4000-8000-000000000001"
    func request(_ method: String, _ provider: String = "ivpn", extra: [String: Any] = [:]) throws -> Data {
        var object: [String: Any] = ["v": 3, "id": id, "method": method, "provider": provider]
        object.merge(extra) { _, right in right }
        return try JSONSerialization.data(withJSONObject: object)
    }
    func testCapabilitiesAreProviderSpecificAndDiscoveryNeverRunsStatusOrConnect() throws {
        let adapters = Dictionary(uniqueKeysWithValues: VPNProvider.allCases.map { ($0, FakeVPNAdapter($0)) })
        let registry = ProviderRegistry(enabled: true) { adapters[$0]! }
        for provider in VPNProvider.allCases {
            let result = registry.handle(try request("probe", provider.rawValue, extra: ["v": provider.protocolVersion]), version: provider.protocolVersion)
            XCTAssertTrue(result.ok)
            XCTAssertEqual(result.availability?.capabilities, provider.capabilities)
            XCTAssertEqual(adapters[provider]!.reads, 0)
            XCTAssertEqual(adapters[provider]!.connects, 0)
            XCTAssertEqual(adapters[provider]!.opens, 0)
        }
        adapters[.ivpn]!.installed = false
        let missing = registry.handle(try request("probe"))
        XCTAssertEqual(missing.availability?.available, false)
        XCTAssertEqual(missing.availability?.error, .notInstalled)
    }
    func testNordIsLaunchOnlyAndNeverReturnsAConnectionSnapshot() throws {
        let nord = FakeVPNAdapter(.nordvpn)
        let registry = ProviderRegistry(enabled: true) { _ in nord }
        XCTAssertEqual(registry.handle(try request("status", "nordvpn")).error, .unsupportedMethod)
        XCTAssertEqual(registry.handle(try request("connectSelected", "nordvpn")).error, .unsupportedMethod)
        let opened = registry.handle(try request("openApp", "nordvpn"))
        XCTAssertTrue(opened.ok)
        XCTAssertEqual(opened.opened, .nordvpn)
        XCTAssertNil(opened.snapshot)
        XCTAssertEqual(nord.reads, 0)
        XCTAssertEqual(nord.connects, 0)
        XCTAssertEqual(nord.opens, 1)
    }
    func testProtonV5IsLaunchOnlyAndKeepsLegacyV3Unchanged() throws {
        let proton = FakeVPNAdapter(.protonvpn)
        let registry = ProviderRegistry(enabled: true) { _ in proton }
        func v5(_ method: String, extra: [String: Any] = [:]) throws -> ProviderResponse {
            registry.handle(try request(method, "protonvpn", extra: ["v": 5].merging(extra) { _, new in new }), version: 5)
        }
        XCTAssertEqual(registry.handle(try request("openApp", "protonvpn")).error, .invalidRequest)
        XCTAssertEqual(try v5("status").error, .unsupportedMethod)
        XCTAssertEqual(try v5("connectSelected").error, .unsupportedMethod)
        XCTAssertEqual(try v5("disconnect").error, .unsupportedMethod)
        for extra: [String: Any] in [["path": "/tmp/fake.app"], ["args": ["connect"]], ["v": true], ["v": 5.5], ["v": 3]] {
            XCTAssertFalse(try v5("openApp", extra: extra).ok)
        }
        XCTAssertEqual(proton.opens, 0)
        let opened = try v5("openApp")
        XCTAssertEqual(opened.v, 5)
        XCTAssertTrue(opened.ok)
        XCTAssertEqual(opened.opened, .protonvpn)
        XCTAssertNil(opened.snapshot)
        XCTAssertEqual(proton.reads, 0)
        XCTAssertEqual(proton.connects, 0)
        XCTAssertEqual(proton.opens, 1)
        for failure in [HelperError.notInstalled, .untrustedInstallation, .providerTimeout] {
            proton.failure = failure
            XCTAssertEqual(try v5("probe").availability?.error, failure)
            XCTAssertEqual(try v5("openApp").error, failure)
        }
        XCTAssertEqual(proton.opens, 1)
        XCTAssertEqual(ProviderRegistry(enabled: false) { _ in proton }
            .handle(try request("openApp", "protonvpn", extra: ["v": 5]), version: 5).error, .unsupportedMethod)
    }

    func testProtonOnlyValidatesAndOpensItsFixedAppWithABoundedCommand() throws {
        var validations = 0
        var calls = 0
        let adapter = ProtonVPNAdapter(validateInstallation: { validations += 1 }, run: { args, timeout in
            calls += 1
            XCTAssertEqual(validations, 2) // Probe, then fresh verification before open.
            XCTAssertEqual(args, ["-a", "/Applications/ProtonVPN.app"])
            XCTAssertEqual(timeout, 3)
            return Data("not returned to the extension".utf8)
        })
        try adapter.validate()
        XCTAssertEqual(calls, 0)
        XCTAssertThrowsError(try adapter.connect())
        try adapter.openApp()
        XCTAssertEqual(calls, 1)
        let untrusted = ProtonVPNAdapter(validateInstallation: { throw HelperError.untrustedInstallation }, run: { _, _ in
            XCTFail("Must not open an untrusted app"); return Data()
        })
        XCTAssertThrowsError(try untrusted.openApp())
        let timeout = ProtonVPNAdapter(validateInstallation: {}, run: { _, _ in throw HelperError.providerTimeout })
        XCTAssertThrowsError(try timeout.openApp()) { XCTAssertEqual($0 as? HelperError, .providerTimeout) }
    }
    func testConflictingOrUnknownKnownProviderDoesNotStartAnotherTunnel() throws {
        let ivpn = FakeVPNAdapter(.ivpn)
        let mullvad = FakeVPNAdapter(.mullvad)
        let registry = ProviderRegistry(enabled: true) { $0 == .ivpn ? ivpn : mullvad }
        for state in ["connected", "connecting", "error", "disconnecting"] {
            mullvad.state = state
            XCTAssertEqual(registry.handle(try request("connectSelected")).error, .providerConflict)
        }
        XCTAssertEqual(ivpn.connects, 0)
        mullvad.installed = false
        let connected = registry.handle(try request("connectSelected"))
        XCTAssertEqual(connected.snapshot?.provider, "ivpn")
        XCTAssertEqual(connected.snapshot?.tunnel, "connecting")
        XCTAssertEqual(connected.snapshot?.protection, "unknown")
        XCTAssertEqual(ivpn.connects, 1)
        ivpn.state = "connected"
        XCTAssertTrue(registry.handle(try request("connectSelected")).ok)
        XCTAssertEqual(ivpn.connects, 1)
    }
    func testStrictProtocolAndReleaseGating() throws {
        let adapter = FakeVPNAdapter(.ivpn)
        let registry = ProviderRegistry(enabled: true) { _ in adapter }
        for extra: [String: Any] in [["args": ["disconnect"]], ["path": "/tmp/untrusted"], ["v": true]] {
            XCTAssertFalse(registry.handle(try request("connectSelected", extra: extra)).ok)
        }
        for method in ["disconnect", "login", "openApp", "shell"] {
            XCTAssertFalse(registry.handle(try request(method)).ok)
        }
        XCTAssertFalse(registry.handle(try request("probe", "unknown")).ok)
        XCTAssertFalse(ProviderRegistry(enabled: false) { _ in adapter }.handle(try request("connectSelected")).ok)
        XCTAssertEqual(adapter.connects, 0)
        XCTAssertEqual(adapter.opens, 0)
    }
    func testIVPNStatusParsingDiscardsSensitiveFieldsAndDoesNotOverstatePausedOrUnhealthy() throws {
        let expected = ["CONNECTED": "connected", "DISCONNECTED": "disconnected", "CONNECTING": "connecting", "RECONNECTING": "connecting", "INITIALISED": "connecting", "EXITING": "disconnecting", "PAUSED till tomorrow": "error"]
        for (raw, normalized) in expected {
            let status = try IVPNStatus.parse(Data("Account : secret-account\nVPN   :   \(raw)\n    Local IP : secret-ip\n    Server IP : secret-server\n".utf8))
            XCTAssertEqual(status.tunnel, normalized)
            let json = String(data: try JSONEncoder().encode(status), encoding: .utf8)!
            XCTAssertFalse(json.contains("secret"))
            XCTAssertEqual(status.provider, "ivpn")
            XCTAssertEqual(status.protection, "unknown")
        }
        XCTAssertEqual(try IVPNStatus.parse(Data("VPN : CONNECTED\n WARNING! Unhealthy Connection (no traffic detected for a while)".utf8)).tunnel, "error")
        for bad in ["", "VPN : MAYBE", "VPN : CONNECTED\nVPN : DISCONNECTED", "Account : CONNECTED", "VPN : CONNECTED with extra"] {
            XCTAssertThrowsError(try IVPNStatus.parse(Data(bad.utf8)))
        }
    }
    func testIVPNRunsOnlyValidatedBoundedLastConnectionCommands() throws {
        var commands: [[String]] = []
        var deadlines: [TimeInterval] = []
        var validations = 0
        var states = ["DISCONNECTED", "CONNECTING"]
        let adapter = IVPNAdapter(validateInstallation: { validations += 1 }, run: { arguments, timeout in
            // Validate immediately before every execution, not just discovery.
            XCTAssertEqual(validations, commands.count + 1)
            commands.append(arguments); deadlines.append(timeout)
            return arguments == ["status"] ? Data("VPN : \(states.removeFirst())\n".utf8) : Data()
        })
        XCTAssertEqual(try adapter.connect().tunnel, "connecting")
        XCTAssertEqual(commands, [["status"], ["connect", "-last"], ["status"]])
        XCTAssertEqual(deadlines, [3, 18, 3])
    }
    func testIVPNDoesNotMutateActivePausedOrUntrustedInstallations() throws {
        for state in ["CONNECTED", "CONNECTING", "EXITING", "PAUSED till tomorrow"] {
            var commands: [[String]] = []
            let adapter = IVPNAdapter(validateInstallation: {}, run: { arguments, _ in
                commands.append(arguments)
                return Data("VPN : \(state)\n".utf8)
            })
            if state == "CONNECTED" || state == "CONNECTING" { _ = try adapter.connect() }
            else { XCTAssertThrowsError(try adapter.connect()) }
            XCTAssertEqual(commands, [["status"]])
        }
        let untrusted = IVPNAdapter(validateInstallation: { throw HelperError.untrustedInstallation }, run: { _, _ in
            XCTFail("Never execute an untrusted provider"); return Data()
        })
        XCTAssertThrowsError(try untrusted.connect())
    }
}
