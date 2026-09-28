import XCTest
@testable import NetworkHelperCore

/// Runs the shared wire fixtures in `conformance/`. The Rust helper runs the
/// same files. `CONFORMANCE_RECORD=1` fills in a missing `response` only.
final class ConformanceTests: XCTestCase {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("conformance")

    final class Fake: VPNAdapter, ProviderReading, ProviderConnecting {
        let provider: VPNProvider
        var installed = true
        var failure: HelperError?
        var state = "disconnected"
        var reads = 0, connects = 0, opens = 0
        init(_ provider: VPNProvider, _ scenario: [String: Any]?) {
            self.provider = provider
            if let installed = scenario?["installed"] as? Bool { self.installed = installed }
            if let failure = scenario?["failure"] as? String { self.failure = HelperError(rawValue: failure)! }
            if let state = scenario?["state"] as? String { self.state = state }
        }
        func validate() throws {
            if !installed { throw HelperError.notInstalled }
            if let failure { throw failure }
        }
        func status() throws -> ProviderSnapshot {
            try validate(); reads += 1
            let version = ["mullvad": "2026.4", "ivpn": "3.15.15", "protonvpn": "6.5.1", "nordvpn": "2026.4"][provider.rawValue]!
            return ProviderSnapshot(provider: provider.rawValue, providerVersion: version, tunnel: state)
        }
        func connect() throws -> ProviderSnapshot { connects += 1; state = "connecting"; return try status() }
        func openApp() throws { try validate(); opens += 1 }
        func connectSelected() throws -> ProviderSnapshot {
            try SelectedConnection.ensure(status: status, connect: { _ = try connect() })
        }
    }

    static func load(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        return try JSONSerialization.jsonObject(with: data) as! [String: Any]
    }
    static func hex(_ value: String) -> Data {
        var data = Data(); var index = value.startIndex
        while index < value.endIndex {
            let next = value.index(index, offsetBy: 2)
            data.append(UInt8(value[index..<next], radix: 16)!); index = next
        }
        return data
    }
    static let tokens: [String: String] = [
        "\"{{build}}\"": String(NetworkGuardBuild.build),
        "{{version}}": NetworkGuardBuild.version,
        "{{channel}}": NativeEnrollment.channel,
        "{{platform}}": PlatformCapabilities.platform,
        "{{arch}}": PlatformCapabilities.arch,
    ]
    static func expand(_ value: Any) throws -> Any {
        var text = String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
        for (token, replacement) in tokens { text = text.replacingOccurrences(of: token, with: replacement) }
        return try JSONSerialization.jsonObject(with: Data(text.utf8))
    }
    static func tokenize(_ value: Any) throws -> Any {
        var text = String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!
        for (plain, token) in [("\"version\":\"\(NetworkGuardBuild.version)\"", "\"version\":\"{{version}}\""),
                               ("\"build\":\(NetworkGuardBuild.build)", "\"build\":\"{{build}}\""),
                               ("\"channel\":\"\(NativeEnrollment.channel)\"", "\"channel\":\"{{channel}}\""),
                               ("\"platform\":\"\(PlatformCapabilities.platform)\"", "\"platform\":\"{{platform}}\""),
                               ("\"arch\":\"\(PlatformCapabilities.arch)\"", "\"arch\":\"{{arch}}\"")] {
            text = text.replacingOccurrences(of: plain, with: token)
        }
        return try JSONSerialization.jsonObject(with: Data(text.utf8))
    }

    func testRouter() throws {
        var file = try Self.load("router.json")
        var cases = file["cases"] as! [[String: Any]]
        let record = ProcessInfo.processInfo.environment["CONFORMANCE_RECORD"] == "1"
        var recorded = false
        for (index, item) in cases.enumerated() {
            let name = item["name"] as! String
            let scenario = item["scenario"] as? [String: Any]
            let providerScenario = scenario?["providers"] as? [String: [String: Any]]
            let fakes = Dictionary(uniqueKeysWithValues: VPNProvider.allCases.map {
                ($0, Fake($0, providerScenario?[$0.rawValue]))
            })
            let control = scenario?["control"] as? Bool ?? true
            let router = NativeRouter(
                service: HelperService(provider: fakes[.mullvad]!),
                controls: ConnectionControlService(provider: fakes[.mullvad]!, enabled: control),
                providers: ProviderRegistry(enabled: control) { fakes[$0]! })
            let payload: Data
            if let text = item["requestText"] as? String { payload = Data(text.utf8) }
            else { payload = try JSONSerialization.data(withJSONObject: item["request"]!, options: [.sortedKeys]) }
            let actual = try JSONSerialization.jsonObject(with: router.respond(payload))
            let platform = PlatformCapabilities.platform
            let expected = (item["responseByPlatform"] as? [String: Any])?[platform] ?? item["response"]
            if let expected {
                XCTAssertEqual(actual as? NSDictionary, try Self.expand(expected) as? NSDictionary, name)
            } else if record {
                cases[index]["response"] = try Self.tokenize(actual)
                recorded = true
            } else {
                XCTFail("\(name): no expected response. Record with CONFORMANCE_RECORD=1.")
            }
            let calls = (item["callsByPlatform"] as? [String: Any])?[platform] ?? item["calls"]
            for (provider, counts) in calls as? [String: [String: Int]] ?? [:] {
                let fake = fakes[VPNProvider(rawValue: provider)!]!
                XCTAssertEqual(["reads": fake.reads, "connects": fake.connects, "opens": fake.opens], counts, "\(name): \(provider) calls")
            }
        }
        if recorded {
            file["cases"] = cases
            try JSONSerialization.data(withJSONObject: file, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
                .write(to: Self.directory.appendingPathComponent("router.json"))
        }
    }

    func testFrames() throws {
        let file = try Self.load("frames.json")
        XCTAssertEqual(file["maxBytes"] as? Int, NativeFrames.maxBytes)
        for stream in file["streams"] as! [[String: Any]] {
            let name = stream["name"] as! String
            let pipe = Pipe()
            pipe.fileHandleForWriting.write(Self.hex(stream["hex"] as! String))
            try pipe.fileHandleForWriting.close()
            var frames: [Data] = []
            var end = "eof"
            do {
                while let frame = try NativeFrames.read(from: pipe.fileHandleForReading) { frames.append(frame) }
            } catch let error as HelperError { end = error.rawValue }
            XCTAssertEqual(frames, (stream["frames"] as! [String]).map(Self.hex), name)
            XCTAssertEqual(end, stream["end"] as? String, name)
        }
        for item in file["encode"] as! [[String: Any]] {
            let name = item["name"] as! String
            let payload = Self.hex(item["payloadHex"] as! String)
            if let error = item["error"] as? String {
                XCTAssertThrowsError(try NativeFrames.encode(payload), name) { XCTAssertEqual(($0 as? HelperError)?.rawValue, error) }
            } else {
                XCTAssertEqual(try NativeFrames.encode(payload), Self.hex(item["hex"] as! String), name)
            }
        }
    }

    func testOrigins() throws {
        let file = try Self.load("origins.json")
        let ids: Set<String> = [file["allowedId"] as! String]
        for origin in file["accept"] as! [String] { XCTAssertTrue(NativeOrigin.accepts(origin, extensionIDs: ids), origin) }
        for origin in file["reject"] as! [String] { XCTAssertFalse(NativeOrigin.accepts(origin, extensionIDs: ids), origin) }
        for item in file["rejectWithIds"] as! [[String: Any]] {
            let origin = item["origin"] as! String
            XCTAssertFalse(NativeOrigin.accepts(origin, extensionIDs: Set(item["ids"] as! [String])), origin)
        }
    }

    func testStatusParsers() throws {
        let file = try Self.load("status-parsers.json")
        let parsers: [String: (Data) throws -> ProviderSnapshot] = [
            "mullvad": { try MullvadStatus.parse($0, version: "2026.4") },
            "ivpn": IVPNStatus.parse,
        ]
        for (provider, parse) in parsers {
            let group = file[provider] as! [String: Any]
            for item in group["cases"] as! [[String: Any]] {
                let text = item["text"] as! String
                if let tunnel = item["tunnel"] as? String {
                    let snapshot = try parse(Data(text.utf8))
                    XCTAssertEqual(snapshot.tunnel, tunnel, "\(provider): \(text)")
                    XCTAssertEqual(snapshot.providerVersion, group["providerVersion"] as? String)
                    XCTAssertEqual(snapshot.protection, "unknown")
                } else {
                    XCTAssertThrowsError(try parse(Data(text.utf8)), "\(provider): \(text)") {
                        XCTAssertEqual(($0 as? HelperError)?.rawValue, item["error"] as? String)
                    }
                }
            }
        }
    }
}
