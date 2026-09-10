import Foundation
import NetworkHelperCore

let encoder = JSONEncoder()
encoder.outputFormatting = [.sortedKeys]
let service = HelperService(provider: MullvadReader())
let controls = ConnectionControlService(provider: MullvadReader(), enabled: NativeEnrollment.supportsConnectionControl)
let providers = ProviderRegistry(enabled: NativeEnrollment.supportsConnectionControl)
let args = Array(CommandLine.arguments.dropFirst())

// Build-specific exact identity. No native host is installed by this executable.
let allowedExtensionIDs = NativeEnrollment.allowedExtensionIDs

if args == ["--print-host-manifest"] {
    do {
        let path = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath().path
        let manifest = try NativeEnrollment.manifest(executablePath: path)
        FileHandle.standardOutput.write(try encoder.encode(manifest))
        FileHandle.standardOutput.write(Data([10]))
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("Cannot prepare host manifest.\n".utf8))
        exit(64)
    }
}

if args == ["--inspect"] {
    let request = try! JSONSerialization.data(withJSONObject: ["v": 1, "id": UUID().uuidString, "method": "status"])
    let response = service.handle(request)
    let data = try encoder.encode(response)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
    exit(response.ok ? 0 : 1)
}

guard args.count == 1, NativeOrigin.accepts(args[0], extensionIDs: allowedExtensionIDs) else {
    FileHandle.standardError.write(Data("Native caller is not enrolled. Read-only local check: --inspect\n".utf8))
    exit(64)
}

do {
    // Prototype processes sequentially and caps each host session; no background daemon.
    for _ in 0..<128 {
        guard let payload = try NativeFrames.read(from: .standardInput) else { break }
        let object = try? JSONSerialization.jsonObject(with: payload) as? [String: Any]
        let response: Data
        switch object?["v"] as? Int {
        case 4: response = try encoder.encode(DiscoveryService().handle(payload))
        case 3: response = try encoder.encode(providers.handle(payload))
        case 2: response = try encoder.encode(controls.handle(payload))
        default: response = try encoder.encode(service.handle(payload))
        }
        FileHandle.standardOutput.write(try NativeFrames.encode(response))
    }
} catch {
    // No raw frame/exception contents on stderr or stdout.
    FileHandle.standardError.write(Data("Native protocol ended.\n".utf8))
    exit(65)
}
