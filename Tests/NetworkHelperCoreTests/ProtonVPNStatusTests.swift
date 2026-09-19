import XCTest
@testable import NetworkHelperCore

final class ProtonVPNStatusTests: XCTestCase {
    let id = "00000000-0000-4000-8000-000000000001"
    func service(id: String = "00000000-0000-4000-8000-000000000001", subtype: String = "ch.protonvpn.mac",
                 bundle: String = "ch.protonvpn.mac.WireGuard-Extension", enabled: Bool = true) -> ProtonVPNService {
        ProtonVPNService(id: id, type: "VPN", subtype: subtype, providerBundle: bundle, enabled: enabled)
    }
    func testExactServiceIdentityAndAmbiguityFailClosed() throws {
        XCTAssertEqual(try ProtonVPNService.select([service(), service(subtype: "another.vendor")]).id, id)
        for candidates in [[], [service(subtype: "another.vendor")], [service(bundle: "another.extension")],
                           [service(enabled: false)], [service(id: "--start")], [service(), service()],
                           [service(), service(enabled: false)]] {
            XCTAssertThrowsError(try ProtonVPNService.select(candidates)) {
                XCTAssertEqual($0 as? HelperError, .providerUnavailable)
            }
        }
    }
    func testStateNormalizationDiscardsExtendedStatus() throws {
        for state in ["Connected", "Disconnected", "Connecting", "Disconnecting"] {
            let result = try ProtonVPNStatus.parse(Data("\(state)\nExtended Status { account = private-account; address = private-address; }\n".utf8))
            XCTAssertEqual(result.provider, "protonvpn")
            XCTAssertEqual(result.providerVersion, "6.5.1")
            XCTAssertEqual(result.tunnel, state.lowercased())
            XCTAssertEqual(result.protection, "unknown")
            let json = String(data: try JSONEncoder().encode(result), encoding: .utf8)!
            XCTAssertFalse(json.contains("private"))
        }
        for bad in ["", "\nConnected", "Invalid: access denied", "Connected extra", "connected", "Unknown", " Connected"] {
            XCTAssertThrowsError(try ProtonVPNStatus.parse(Data(bad.utf8)))
        }
        XCTAssertThrowsError(try ProtonVPNStatus.parse(Data([0xff])))
        XCTAssertThrowsError(try ProtonVPNStatus.parse(Data(repeating: 65, count: 65537)))
    }
    func testStatusVerifiesAppVersionAndUsesOnlyBoundedReadCommand() throws {
        var calls = 0
        var verified = false
        let adapter = ProtonVPNAdapter(validateInstallation: { verified = true }, run: { _, _ in
            XCTFail("Status must not open an app"); return Data()
        }, services: { [self.service()] }, readStatus: { args, timeout in
            XCTAssertTrue(verified)
            XCTAssertEqual(args, ["--nc", "status", self.id])
            XCTAssertEqual(timeout, 3)
            calls += 1
            return Data("Connected\n".utf8)
        })
        XCTAssertEqual(try adapter.status().tunnel, "connected")
        XCTAssertEqual(calls, 1)
        XCTAssertThrowsError(try adapter.connect())
        XCTAssertEqual(calls, 1)
    }
    func testUntrustedUnsupportedAndMissingProfilesNeverRunStatus() throws {
        for mode in ["untrusted", "version", "profile"] {
            let adapter = ProtonVPNAdapter(validateInstallation: {
                if mode == "untrusted" { throw HelperError.untrustedInstallation }
            }, run: { _, _ in XCTFail("Must not open"); return Data() },
            readVersion: { mode == "version" ? "6.5.2" : "6.5.1" },
            services: { [] }, readStatus: { _, _ in XCTFail("Must not run status"); return Data() })
            XCTAssertThrowsError(try adapter.status())
        }
        for error in [HelperError.providerTimeout, .oversizedOutput, .providerUnavailable] {
            let adapter = ProtonVPNAdapter(validateInstallation: {}, run: { _, _ in Data() },
                services: { [self.service()] }, readStatus: { _, _ in throw error })
            XCTAssertThrowsError(try adapter.status()) { XCTAssertEqual($0 as? HelperError, error) }
        }
    }
    func testV6OnlyAcceptsProtonStatusAndPreservesV5() throws {
        let proton = FakeVPNAdapter(.protonvpn)
        let registry = ProviderRegistry(enabled: true) { _ in proton }
        func request(_ method: String, _ overrides: [String: Any] = [:]) throws -> Data {
            try JSONSerialization.data(withJSONObject: ["v": 6, "id": id, "provider": "protonvpn", "method": method]
                .merging(overrides) { _, new in new })
        }
        let result = registry.handle(try request("status"), version: 6)
        XCTAssertEqual(result.v, 6)
        XCTAssertEqual(result.snapshot?.provider, "protonvpn")
        for method in ["probe", "connectSelected", "openApp", "disconnect"] {
            XCTAssertEqual(registry.handle(try request(method), version: 6).error, .unsupportedMethod)
        }
        for override: [String: Any] in [["provider": "mullvad"], ["v": true], ["v": 6.5], ["service": id], ["path": "/bin/sh"]] {
            XCTAssertFalse(registry.handle(try request("status", override), version: 6).ok)
        }
        XCTAssertEqual(registry.handle(try request("status", ["v": 5]), version: 5).error, .unsupportedMethod)
        XCTAssertEqual(registry.handle(try request("probe", ["v": 5]), version: 5).availability?.capabilities, ["open-app"])
        XCTAssertEqual(proton.reads, 1)
        XCTAssertEqual(proton.connects, 0)
        XCTAssertEqual(proton.opens, 0)
    }
}
