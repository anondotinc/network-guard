import XCTest
@testable import NetworkHelperCore

final class ConnectionControlTests: XCTestCase {
    final class Fake: ProviderConnecting {
        var calls = 0
        func connectSelected() throws -> ProviderSnapshot {
            calls += 1
            return ProviderSnapshot(providerVersion: "2026.4", tunnel: "connecting")
        }
    }
    let id = "01234567-89ab-4def-8123-456789abcdef"
    func request(_ method: String, extra: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 2, "id": id, "method": method].merging(extra) { _, new in new })
    }
    func testControlNeedsSeparateVersionAndExplicitCapability() throws {
        let fake = Fake()
        let service = ConnectionControlService(provider: fake, enabled: true)
        let capability = service.handle(try request("capabilities"))
        XCTAssertEqual(capability.v, 2)
        XCTAssertEqual(capability.capabilities, ["connect-selected", "development-control-pilot"])
        XCTAssertEqual(fake.calls, 0)
        let response = service.handle(try request("connectSelected"))
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.snapshot?.protection, "unknown")
        XCTAssertEqual(fake.calls, 1)
    }
    func testOtherMutationsArgumentsAndReadOnlyVersionCannotConnect() throws {
        let fake = Fake()
        let service = ConnectionControlService(provider: fake, enabled: true)
        for method in ["connect", "disconnect", "exec", "setLocation", "login", "lockdown"] {
            XCTAssertFalse(service.handle(try request(method)).ok)
        }
        for extra: [String: Any] in [["v": 1], ["v": true], ["path": "/bin/sh"], ["args": ["disconnect"]], ["location": "elsewhere"]] {
            XCTAssertFalse(service.handle(try request("connectSelected", extra: extra)).ok)
        }
        XCTAssertEqual(fake.calls, 0)
    }
    func testDisabledControlCannotConnect() throws {
        let fake = Fake()
        XCTAssertFalse(ConnectionControlService(provider: fake, enabled: false).handle(try request("connectSelected")).ok)
        XCTAssertEqual(fake.calls, 0)
    }
    func testEnrolledBuildSupportsExplicitConnectionControl() throws {
        let fake = Fake()
        XCTAssertTrue(NativeEnrollment.supportsConnectionControl)
        let service = ConnectionControlService(provider: fake, enabled: NativeEnrollment.supportsConnectionControl)
        XCTAssertTrue(service.handle(try request("capabilities")).ok)
        XCTAssertEqual(fake.calls, 0)
        XCTAssertTrue(service.handle(try request("connectSelected")).ok)
        XCTAssertEqual(fake.calls, 1)
    }
    func testAlreadyConnectedOrConnectingIsNotInterrupted() throws {
        for state in ["connected", "connecting"] {
            var commands = 0
            let snapshot = try SelectedConnection.ensure(status: { ProviderSnapshot(providerVersion: "2026.4", tunnel: state) }, connect: { commands += 1 })
            XCTAssertEqual(snapshot.tunnel, state)
            XCTAssertEqual(commands, 0)
        }
    }
    func testDisconnectedConnectsOnceAndRereadsRealStatus() throws {
        var commands = 0
        let result = try SelectedConnection.ensure(status: { ProviderSnapshot(providerVersion: "2026.4", tunnel: commands == 0 ? "disconnected" : "connecting") }, connect: { commands += 1 })
        XCTAssertEqual(commands, 1)
        XCTAssertEqual(result.tunnel, "connecting")
        XCTAssertEqual(result.protection, "unknown")
    }
    func testFailureAndUserDisconnectAreNeverOverridden() {
        for state in ["disconnecting", "error", "unknown"] {
            var commands = 0
            XCTAssertThrowsError(try SelectedConnection.ensure(status: { ProviderSnapshot(providerVersion: "2026.4", tunnel: state) }, connect: { commands += 1 }))
            XCTAssertEqual(commands, 0)
        }
        var commands = 0
        XCTAssertThrowsError(try SelectedConnection.ensure(status: { throw HelperError.untrustedInstallation }, connect: { commands += 1 }))
        XCTAssertEqual(commands, 0)
    }
}
