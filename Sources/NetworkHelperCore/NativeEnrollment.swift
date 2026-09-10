import Foundation

/// User-supplied wallet identities, isolated by build. Installation is a separate action.
public enum NativeEnrollment {
    public static var channel: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }
    // Both enrolled builds support the explicit, provider-scoped control protocol.
    public static let supportsConnectionControl = true
    public static let developmentExtensionID = "foghepoakbdbpbjknofnhbhpiehpmdac"
    public static let productionExtensionID = "gnkbgepgknkbhnnbaihklcfkjhbclajk"

    public static var hostName: String {
        #if DEBUG
        return "inc.anon.network_helper.dev"
        #else
        return "inc.anon.network_helper"
        #endif
    }

    public static var allowedExtensionIDs: Set<String> {
        #if DEBUG
        return [developmentExtensionID]
        #else
        return [productionExtensionID]
        #endif
    }

    public struct Manifest: Codable, Equatable {
        public let name: String
        public let description: String
        public let path: String
        public let type: String
        public let allowed_origins: [String]
    }

    /// Prints a manifest for explicit review; does not register or install anything.
    public static func manifest(executablePath: String) throws -> Manifest {
        guard executablePath.hasPrefix("/"),
              !executablePath.contains("\0"), !executablePath.contains("\n") else {
            throw HelperError.invalidRequest
        }
        return Manifest(name: hostName, description: "Anon Network Guard",
                        path: executablePath, type: "stdio",
                        allowed_origins: allowedExtensionIDs.sorted().map { "chrome-extension://\($0)/" })
    }
}
