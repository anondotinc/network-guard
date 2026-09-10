import XCTest
@testable import NetworkHelperCore

final class DiscoveryTests: XCTestCase {
    let id = "01234567-89ab-4def-8123-456789abcdef"
    func request(_ override: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 4, "id": id, "method": "describe"].merging(override) { _, new in new })
    }
    func testDescriptionIsStaticAndStrict() throws {
        let response = DiscoveryService().handle(try request())
        XCTAssertTrue(response.ok)
        XCTAssertEqual(response.v, 4)
        XCTAssertEqual(response.id, id)
        XCTAssertEqual(response.helper?.version, NetworkGuardBuild.version)
        XCTAssertEqual(response.helper?.channel, NativeEnrollment.channel)
        XCTAssertEqual(response.helper?.protocols, [1, 2, 3, 4])
        XCTAssertEqual(response.helper?.providers, ["mullvad", "ivpn", "nordvpn"])
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as! [String: Any]
        XCTAssertEqual(Set(object.keys), ["v", "id", "ok", "helper"])
    }
    func testUnknownFieldsVersionsAndOperationsFailClosed() throws {
        for fields: [String: Any] in [["v": true], ["v": 3], ["v": 4.5], ["id": "not-a-uuid"],
            ["method": "connectSelected"], ["provider": "mullvad"], ["path": "/bin/sh"]] {
            let response = DiscoveryService().handle(try request(fields))
            XCTAssertFalse(response.ok)
            XCTAssertNil(response.helper)
        }
        XCTAssertEqual(DiscoveryService().handle(Data(repeating: 32, count: 4097)).error, .invalidRequest)
    }
}
