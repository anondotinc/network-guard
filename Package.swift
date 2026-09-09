// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "AnonNetworkHelper",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "anon-network-helper", targets: ["AnonNetworkHelper"]),
        .executable(name: "AnonNetworkHelperSetup", targets: ["AnonNetworkHelperSetup"]),
    ],
    targets: [
        .target(name: "NetworkHelperCore"),
        .executableTarget(name: "AnonNetworkHelper", dependencies: ["NetworkHelperCore"]),
        .target(name: "NetworkHelperSetupCore", dependencies: ["NetworkHelperCore"]),
        .executableTarget(name: "AnonNetworkHelperSetup", dependencies: ["NetworkHelperSetupCore", "NetworkHelperCore"]),
        .testTarget(name: "NetworkHelperCoreTests", dependencies: ["NetworkHelperCore"]),
        .testTarget(name: "NetworkHelperSetupTests", dependencies: ["NetworkHelperSetupCore"]),
    ]
)
