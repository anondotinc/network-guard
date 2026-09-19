import XCTest
@testable import NetworkHelperCore

final class RPCProxyTests: XCTestCase {
    let id = "01234567-89ab-4def-8123-456789abcdef"
    func payload(_ overrides: [String: Any] = [:]) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["v": 7, "id": id, "method": "rpc", "host": "127.0.0.1", "port": 9050,
            "url": "https://rpc.example/", "headers": ["content-type": "application/json"],
            "body": Data("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}".utf8).base64EncodedString()
        ].merging(overrides) { _, new in new })
    }
    func testExactSchemaRejectsCommandsNonNumericProxyAndInvalidRPC() throws {
        let invalid: [[String: Any]] = [["v": true], ["port": true], ["port": 0], ["port": 65536], ["port": 9050.5],
            ["host": "proxy.example"], ["host": "127.0.0.1/path"], ["host": "::1%lo0"], ["command": "curl"],
            ["url": "file:///etc/passwd"], ["url": "http://name:password@rpc.example"], ["url": "https://rpc.example/#fragment"],
            ["url": "https://rpc.example/\noutput=/tmp/unsafe"], ["body": "invalid"],
            ["body": Data("{\"method\":\"eth_chainId\"}".utf8).base64EncodedString()],
            ["headers": ["cookie": "token=example"]], ["headers": ["proxy-authorization": "example"]],
            ["headers": ["x-api-key": "value\r\nInjected: yes"]]]
        for row in invalid { XCTAssertThrowsError(try RPCProxySession.parse(payload(row), id: id), "\(row.keys)") }
        XCTAssertThrowsError(try RPCProxySession.parse(payload(), id: UUID().uuidString))
    }
    func testDomainDestinationIsPreservedForRemoteDNSAndNoFallback() throws {
        let value = try RPCProxySession.parse(payload(["url": "http://synthetic-node.onion/rpc", "host": "::1"]), id: id)
        let config = String(data: RPCProxySession.configuration(value), encoding: .utf8)!
        XCTAssertTrue(config.contains("socks5h://[::1]:9050"))
        XCTAssertTrue(config.contains("http://synthetic-node.onion/rpc"))
        XCTAssertEqual(RPCProxySession.arguments.first, "--disable")
        XCTAssertTrue(RPCProxySession.arguments.contains("--noproxy"))
        XCTAssertFalse(RPCProxySession.arguments.contains("--location"))
        XCTAssertFalse(RPCProxySession.arguments.contains("--insecure"))
    }
    func testCurlConfigCannotInjectAnotherOption() throws {
        let body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[\"\\\"\\nproxy=\\\"\\\"\"]}"
        let value = try RPCProxySession.parse(payload(["body": Data(body.utf8).base64EncodedString(), "headers": ["x-api-key": "value\"\\"]]), id: id)
        let config = String(data: RPCProxySession.configuration(value), encoding: .utf8)!
        XCTAssertEqual(config.split(separator: "\n").count, 5)
        XCTAssertTrue(config.contains("header = \"x-api-key: value\\\"\\\\\""))
    }
    func testLegacyFramesStaySmallAndOnlyNegotiatedFramesUseHigherLimit() throws {
        let body = Data(repeating: 65, count: 4097)
        XCTAssertThrowsError(try NativeFrames.encode(body))
        let frame = try NativeFrames.encode(body, limit: RPCProxySession.requestLimit)
        XCTAssertThrowsError(try NativeFrames.length(frame.prefix(4)))
        XCTAssertEqual(try NativeFrames.length(frame.prefix(4), limit: RPCProxySession.requestLimit), 4097)
    }
}
