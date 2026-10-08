import Foundation

/// Chrome native messaging on the supported little-endian macOS architectures.
/// Much tighter than Chrome's limit: requests and responses have no large payloads.
public enum NativeFrames {
    public static let maxBytes = 4096

    public static func encode(_ data: Data) throws -> Data {
        guard !data.isEmpty, data.count <= maxBytes else { throw HelperError.invalidFrame }
        var size = UInt32(data.count).littleEndian
        var result = withUnsafeBytes(of: &size) { Data($0) }
        result.append(data)
        return result
    }

    public static func length(_ header: Data) throws -> Int {
        guard header.count == 4 else { throw HelperError.invalidFrame }
        let value = header.enumerated().reduce(UInt32(0)) { $0 | (UInt32($1.element) << ($1.offset * 8)) }
        guard value > 0, value <= maxBytes else { throw HelperError.invalidFrame }
        return Int(value)
    }

    public static func read(from input: FileHandle) throws -> Data? {
        func exact(_ count: Int, allowEOF: Bool = false) throws -> Data? {
            var data = Data()
            while data.count < count {
                guard let chunk = try input.read(upToCount: count - data.count), !chunk.isEmpty else {
                    if data.isEmpty && allowEOF { return nil }
                    throw HelperError.invalidFrame
                }
                data.append(chunk)
            }
            return data
        }
        guard let header = try exact(4, allowEOF: true) else { return nil }
        return try exact(length(header))
    }
}

public enum NativeOrigin {
    public static func accepts(_ origin: String, extensionIDs: Set<String>) -> Bool {
        extensionIDs.contains { id in
            id.count == 32 && id.utf8.allSatisfy { (97...112).contains($0) }
                && origin == "chrome-extension://\(id)/"
        }
    }
}
