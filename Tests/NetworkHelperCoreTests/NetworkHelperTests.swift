import XCTest
@testable import NetworkHelperCore

final class NetworkHelperTests: XCTestCase {
    let id = "01234567-89ab-4def-8123-456789abcdef"
    struct FakeProvider: ProviderReading {
        let error: Error?
        init(error: Error? = nil) { self.error = error }
        func status() throws -> ProviderSnapshot {
            if let error { throw error }
            return ProviderSnapshot(providerVersion: "2026.4", tunnel: "connected")
        }
    }
    func request(_ method: String = "status", extra: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 1, "id": id, "method": method].merging(extra) { _, new in new })
    }
    func testKnownStatusNeverMeansProtected() throws {
        for state in ["connected", "disconnected", "connecting", "disconnecting", "error"] {
            let data = try JSONSerialization.data(withJSONObject: ["state": state, "details": ["ip": "sensitive", "account": "secret"]])
            let value = try MullvadStatus.parse(data, version: "2026.4")
            XCTAssertEqual(value.tunnel, state)
            XCTAssertEqual(value.protection, "unknown")
            XCTAssertEqual(value.reason, "route-not-verified")
            let json = String(data: try JSONEncoder().encode(value), encoding: .utf8)!
            XCTAssertFalse(json.contains("sensitive"))
            XCTAssertFalse(json.contains("secret"))
            XCTAssertFalse(json.contains("details"))
        }
    }
    func testMalformedStatusFailsClosed() {
        for input in ["connected", "[]", "{}", "{\"state\":true}", "{\"state\":\"new_state\"}", "Warning\n{\"state\":\"connected\"}"] {
            XCTAssertThrowsError(try MullvadStatus.parse(Data(input.utf8), version: "2026.4"))
        }
    }
    func testRequestStrictSchema() throws {
        XCTAssertEqual(try HelperRequest.parse(request()).id, id)
        for extra: [String: Any] in [["path": "/bin/sh"], ["args": ["connect"]], ["profile": "private"], ["v": true], ["v": 2], ["id": "account-id"]] {
            XCTAssertThrowsError(try HelperRequest.parse(request(extra: extra)))
        }
    }
    func testRejectsAllMutationCommands() throws {
        for method in ["connect", "disconnect", "login", "setLocation", "exec", "status;connect"] {
            XCTAssertThrowsError(try HelperRequest.parse(request(method)))
        }
    }
    func testCapabilitiesAreExplicitlyReadOnly() throws {
        let response = HelperService(provider: FakeProvider()).handle(try request("capabilities"))
        XCTAssertEqual(response.capabilities, ["read-status", "read-only-prototype"])
        XCTAssertNil(response.snapshot)
    }
    func testResponseRedactsUnexpectedProviderErrors() throws {
        let provider = FakeProvider(error: NSError(domain: "secret-account-and-IP", code: 1))
        let response = HelperService(provider: provider).handle(try request())
        XCTAssertFalse(response.ok)
        XCTAssertEqual(response.error, .providerUnavailable)
        let json = String(data: try JSONEncoder().encode(response), encoding: .utf8)!
        XCTAssertFalse(json.contains("secret"))
    }
    func testStatusAndTypedFailures() throws {
        let ok = HelperService(provider: FakeProvider()).handle(try request())
        XCTAssertEqual(ok.id, id)
        XCTAssertEqual(ok.snapshot?.tunnel, "connected")
        for error: HelperError in [.notInstalled, .untrustedInstallation, .unsupportedProviderVersion, .providerTimeout] {
            XCTAssertEqual(HelperService(provider: FakeProvider(error: error)).handle(try request()).error, error)
        }
    }
    func testOriginExactMatchAndNoWildcard() {
        let extensionID = String(repeating: "a", count: 32)
        let ids: Set<String> = [extensionID]
        XCTAssertTrue(NativeOrigin.accepts("chrome-extension://\(extensionID)/", extensionIDs: ids))
        for origin in ["https://app.hyperliquid.xyz", "chrome-extension://\(extensionID)/page", "chrome-extension://\(extensionID).evil/", "chrome-extension://\(extensionID)/?x=1"] {
            XCTAssertFalse(NativeOrigin.accepts(origin, extensionIDs: ids))
        }
        XCTAssertFalse(NativeOrigin.accepts("chrome-extension://\(extensionID)/", extensionIDs: []))
        XCTAssertFalse(NativeOrigin.accepts("chrome-extension://*/", extensionIDs: ["*"]))
    }
    func testBuildEnrollmentAndManifestAgree() throws {
        #if DEBUG
        let origin = "chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/"
        let otherOrigin = "chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/"
        let hostName = "inc.anon.network_helper.dev"
        XCTAssertEqual(NativeEnrollment.allowedExtensionIDs, [NativeEnrollment.developmentExtensionID])
        #else
        let origin = "chrome-extension://gnkbgepgknkbhnnbaihklcfkjhbclajk/"
        let otherOrigin = "chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdac/"
        let hostName = "inc.anon.network_helper"
        XCTAssertEqual(NativeEnrollment.allowedExtensionIDs, [NativeEnrollment.productionExtensionID])
        #endif
        XCTAssertTrue(NativeOrigin.accepts(origin, extensionIDs: NativeEnrollment.allowedExtensionIDs))
        XCTAssertFalse(NativeOrigin.accepts(otherOrigin, extensionIDs: NativeEnrollment.allowedExtensionIDs))
        XCTAssertFalse(NativeOrigin.accepts("chrome-extension://foghepoakbdbpbjknofnhbhpiehpmdab/", extensionIDs: NativeEnrollment.allowedExtensionIDs))
        let manifest = try NativeEnrollment.manifest(executablePath: "/test path/anon-network-helper")
        XCTAssertEqual(manifest.allowed_origins, [origin])
        XCTAssertEqual(manifest.name, hostName)
        XCTAssertEqual(manifest.type, "stdio")
        XCTAssertEqual(manifest.path, "/test path/anon-network-helper")
    }
    func testManifestRejectsRelativeOrUnsafePath() {
        for path in ["helper", "", "/bad\0path", "/bad\npath"] {
            XCTAssertThrowsError(try NativeEnrollment.manifest(executablePath: path))
        }
    }
    func testFrameLimitsAndLittleEndian() throws {
        let body = try request()
        let encoded = try NativeFrames.encode(body)
        XCTAssertEqual(try NativeFrames.length(encoded.prefix(4)), body.count)
        XCTAssertEqual(encoded.dropFirst(4), body)
        for header in [Data(), Data([1, 0]), Data([0, 0, 0, 0]), Data([255, 255, 255, 255]), Data([1, 16, 0, 0])] {
            XCTAssertThrowsError(try NativeFrames.length(header))
        }
        XCTAssertThrowsError(try NativeFrames.encode(Data(repeating: 1, count: 4097)))
    }
    func testTruncatedStreamAndCleanEOF() throws {
        for input in [Data([3, 0]), Data([3, 0, 0, 0, 65])] {
            let pipe = Pipe()
            pipe.fileHandleForWriting.write(input)
            try pipe.fileHandleForWriting.close()
            XCTAssertThrowsError(try NativeFrames.read(from: pipe.fileHandleForReading))
        }
        let pipe = Pipe()
        try pipe.fileHandleForWriting.close()
        XCTAssertNil(try NativeFrames.read(from: pipe.fileHandleForReading))
    }
    func testMultipleFramesAndShortWrites() throws {
        let body = try request()
        let framed = try NativeFrames.encode(body)
        let pipe = Pipe()
        for byte in framed + framed { pipe.fileHandleForWriting.write(Data([byte])) }
        try pipe.fileHandleForWriting.close()
        XCTAssertEqual(try NativeFrames.read(from: pipe.fileHandleForReading), body)
        XCTAssertEqual(try NativeFrames.read(from: pipe.fileHandleForReading), body)
        XCTAssertNil(try NativeFrames.read(from: pipe.fileHandleForReading))
    }
    func testLocalProcessSuccessAndFailure() throws {
        let output = try MullvadReader.readBoundedOutput(executablePath: "/usr/bin/printf", arguments: ["synthetic-output"])
        XCTAssertEqual(String(data: output, encoding: .utf8), "synthetic-output")
        XCTAssertThrowsError(try MullvadReader.readBoundedOutput(executablePath: "/usr/bin/false", arguments: [])) {
            XCTAssertEqual($0 as? HelperError, .providerUnavailable)
        }
    }
    func testLocalProcessDeadline() {
        let start = ProcessInfo.processInfo.systemUptime
        XCTAssertThrowsError(try MullvadReader.readBoundedOutput(executablePath: "/bin/sleep", arguments: ["5"], timeout: 0.05)) {
            XCTAssertEqual($0 as? HelperError, .providerTimeout)
        }
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 2)
    }
    func testLocalProcessOutputCap() {
        XCTAssertThrowsError(try MullvadReader.readBoundedOutput(executablePath: "/usr/bin/yes", arguments: ["synthetic"], limit: 1024)) {
            XCTAssertEqual($0 as? HelperError, .oversizedOutput)
        }
    }
}
