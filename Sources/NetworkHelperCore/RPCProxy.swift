import Foundation
import Darwin

// Development HTTP JSON-RPC transport, deliberately separate from VPN status.
// No daemon, listening socket, shell, direct fallback, redirects or disk cache.
public enum RPCProxySession {
    public static let requestLimit = 131072
    public static let responseLimit = 400000
    static let bodyLimit = 65536
    static let replyLimit = 262144

    enum Failure: String, Error { case invalidRequest, proxyFailed, responseTooLarge, cancelled }

    static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalidRequest }
        return value
    }
    static func exact(_ object: [String: Any], _ fields: [String]) -> Bool { Set(object.keys) == Set(fields) }
    static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(n.intValue) else { return nil }
        return n.intValue
    }
    static func identity(_ object: [String: Any]) -> String? {
        guard integer(object["v"]) == 7, let id = object["id"] as? String, UUID(uuidString: id) != nil else { return nil }
        return id
    }

    struct Request {
        let host: String
        let port: Int
        let url: String
        let body: String
        let headers: [String: String]
    }
    static func parse(_ data: Data, id: String) throws -> Request {
        guard data.count <= requestLimit else { throw Failure.invalidRequest }
        let value = try object(data)
        guard exact(value, ["v", "id", "method", "host", "port", "url", "body", "headers"]),
              identity(value) == id, value["method"] as? String == "rpc",
              let host = value["host"] as? String, literalHost(host),
              let port = integer(value["port"]), (1...65535).contains(port),
              let url = value["url"] as? String, url.utf8.count <= 4096,
              !url.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let parsed = URLComponents(string: url), ["https", "http"].contains(parsed.scheme),
              let destination = parsed.host, !destination.isEmpty,
              parsed.user == nil, parsed.password == nil, parsed.fragment == nil,
              parsed.port == nil || (1...65535).contains(parsed.port!),
              let encoded = value["body"] as? String, let bytes = Data(base64Encoded: encoded), bytes.count <= bodyLimit,
              let body = String(data: bytes, encoding: .utf8),
              let json = try? JSONSerialization.jsonObject(with: bytes), validRPC(json),
              let headers = value["headers"] as? [String: String], headers.count <= 32,
              headers.reduce(0, { $0 + $1.key.utf8.count + $1.value.utf8.count }) <= 8192,
              headers.allSatisfy({ validHeader($0.key, $0.value) }) else { throw Failure.invalidRequest }
        return Request(host: host, port: port, url: url, body: body, headers: headers)
    }
    static func literalHost(_ host: String) -> Bool {
        var v4 = in_addr(), v6 = in6_addr()
        return !host.contains("%") && (inet_pton(AF_INET, host, &v4) == 1 || inet_pton(AF_INET6, host, &v6) == 1)
    }
    static func validRPC(_ json: Any) -> Bool {
        let calls = (json as? [Any]) ?? [json]
        return !calls.isEmpty && calls.count <= 100 && calls.allSatisfy { item in
            guard let call = item as? [String: Any], call["jsonrpc"] as? String == "2.0",
                  let method = call["method"] as? String, !method.isEmpty, method.utf8.count <= 128 else { return false }
            return !method.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
        }
    }
    static func validHeader(_ name: String, _ value: String) -> Bool {
        let denied = ["host", "cookie", "connection", "content-length", "transfer-encoding", "upgrade", "te", "trailer", "expect", "accept-encoding"]
        return !name.isEmpty && name.utf8.count <= 128 && name == name.lowercased()
            && name.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
            && !denied.contains(name) && !name.hasPrefix("proxy-")
            && value.utf8.count <= 4096 && !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
    // Values go down stdin, never in process arguments or a temporary file.
    static func quote(_ value: String) -> String {
        "\"" + value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "\\r")
            .replacingOccurrences(of: "\t", with: "\\t") + "\""
    }
    static func configuration(_ request: Request) -> Data {
        let host = request.host.contains(":") ? "[\(request.host)]" : request.host
        var rows = ["url = \(quote(request.url))", "proxy = \(quote("socks5h://\(host):\(request.port)"))",
                    "data-binary = \(quote(request.body))"]
        rows += request.headers.sorted(by: { $0.key < $1.key }).map { "header = \(quote("\($0.key): \($0.value)"))" }
        if request.headers["content-type"] == nil { rows.append("header = \"Content-Type: application/json\"") }
        return Data((rows.joined(separator: "\n") + "\n").utf8)
    }
    static let arguments = ["--disable", "--silent", "--globoff", "--proto", "=http,https",
        "--noproxy", "", "--socks5-basic", "--max-time", "45", "--connect-timeout", "15",
        "--max-filesize", String(replyLimit), "--request", "POST", "--write-out", "\n%{http_code}", "--config", "-"]

    static func execute(_ request: Request, watchInput: Int32? = nil) throws -> Data {
        let child = Process(), input = Pipe(), output = Pipe()
        child.executableURL = URL(fileURLWithPath: "/usr/bin/curl")
        child.arguments = arguments
        // No proxy, bypass, CA override, cookie, credential, curlrc or trace environment.
        child.environment = ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"]
        child.standardInput = input; child.standardOutput = output; child.standardError = FileHandle.nullDevice
        do { try child.run() } catch { throw Failure.proxyFailed }
        let writeFD = input.fileHandleForWriting.fileDescriptor, readFD = output.fileHandleForReading.fileDescriptor
        _ = fcntl(writeFD, F_SETFL, O_NONBLOCK)
        var inputClosed = false
        defer {
            if child.isRunning { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
            if !inputClosed { try? input.fileHandleForWriting.close() }
            try? output.fileHandleForReading.close()
        }
        let config = configuration(request), deadline = ProcessInfo.processInfo.systemUptime + 47
        var written = 0, result = Data(), ended = false
        while !ended || child.isRunning {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw Failure.proxyFailed }
            var fds = [pollfd(fd: readFD, events: Int16(POLLIN | POLLHUP), revents: 0),
                       pollfd(fd: inputClosed ? -1 : writeFD, events: Int16(POLLOUT), revents: 0),
                       pollfd(fd: watchInput ?? -1, events: Int16(POLLIN | POLLHUP), revents: 0)]
            let ready = poll(&fds, nfds_t(fds.count), 50)
            if ready < 0 { if errno == EINTR { continue }; throw Failure.proxyFailed }
            if fds[2].revents != 0 { throw Failure.cancelled }
            if fds[1].revents & Int16(POLLOUT) != 0 {
                let count = config.withUnsafeBytes { Darwin.write(writeFD, $0.baseAddress!.advanced(by: written), config.count - written) }
                if count > 0 { written += count }
                else if errno != EAGAIN && errno != EINTR { throw Failure.proxyFailed }
                if written == config.count { try input.fileHandleForWriting.close(); inputClosed = true }
            }
            if !ended && fds[0].revents != 0 {
                var bytes = [UInt8](repeating: 0, count: 8192)
                let count = Darwin.read(readFD, &bytes, bytes.count)
                if count == 0 { ended = true }
                else if count > 0 {
                    guard result.count + count <= replyLimit + 4 else { throw Failure.responseTooLarge }
                    result.append(contentsOf: bytes.prefix(count))
                } else if errno != EINTR { throw Failure.proxyFailed }
            }
        }
        guard child.terminationStatus == 0 else { throw Failure.proxyFailed }
        return result
    }

    public static func run(hello: Data, input: FileHandle, output: FileHandle) throws {
        let handshake = try object(hello)
        guard exact(handshake, ["v", "id", "method"]), let id = identity(handshake),
              handshake["method"] as? String == "rpcCapabilities" else { throw Failure.invalidRequest }
        func send(_ value: [String: Any], limit: Int = NativeFrames.maxBytes) throws {
            try output.write(contentsOf: NativeFrames.encode(JSONSerialization.data(withJSONObject: value), limit: limit))
        }
        try send(["v": 7, "id": id, "ok": true, "method": "rpcCapabilities"])
        do {
            guard let payload = try NativeFrames.read(from: input, limit: requestLimit) else { return }
            let request = try parse(payload, id: id)
            let bytes = try execute(request, watchInput: input.fileDescriptor)
            guard bytes.count >= 4, bytes[bytes.count - 4] == 10,
                  let code = String(data: bytes.suffix(3), encoding: .utf8).flatMap(Int.init), (200...599).contains(code) else { throw Failure.proxyFailed }
            // Redirects aren't followed; a caller must explicitly choose another RPC.
            guard !(300...399).contains(code) else { throw Failure.proxyFailed }
            try send(["v": 7, "id": id, "ok": true, "status": code,
                      "body": bytes.dropLast(4).base64EncodedString()], limit: responseLimit)
        } catch {
            try send(["v": 7, "id": id, "ok": false, "error": (error as? Failure)?.rawValue ?? "invalidRequest"])
        }
    }
}
