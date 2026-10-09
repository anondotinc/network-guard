import Foundation
import XCTest
@testable import NetworkHelperSetupCore
import NetworkHelperCore

final class InstallerTests: XCTestCase {
    var temporary: URL!
    var userHome: URL!
    var source: URL!
    var installer: UserInstaller!
    let content = Data("synthetic helper, never executed".utf8)
    var payload: SetupPayload {
        SetupPayload(version: "0.1.0", channel: NativeEnrollment.channel,
                     sha256: UserInstaller.digest(content))
    }
    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent("anon-setup-test-\(UUID().uuidString)")
            .standardizedFileURL.resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        userHome = temporary.appendingPathComponent("user")
        try FileManager.default.createDirectory(at: userHome, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        source = temporary.appendingPathComponent("bundled-helper")
        try content.write(to: source)
        installer = UserInstaller(home: userHome)
    }
    override func tearDownWithError() throws {
        // Exact freshly created fixture only; never a real home or installation.
        try FileManager.default.removeItem(at: temporary)
    }
    func install() throws { try installer.install(payload: payload, bundledHelper: source) }
    func registrationData() throws -> Data { try Data(contentsOf: installer.registration) }
    func registeredBinary() throws -> URL {
        let object = try JSONSerialization.jsonObject(with: registrationData()) as! [String: Any]
        return URL(fileURLWithPath: object["path"] as! String)
    }
    func testInstallCheckRepairAndOwnedUninstall() throws {
        XCTAssertEqual(try installer.check(), .notInstalled)
        try install()
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        let binary = try registeredBinary()
        XCTAssertTrue(binary.path.hasPrefix(installer.root.path + "/versions/0.1.0-"))
        let manifest = try JSONDecoder().decode(NativeEnrollment.Manifest.self, from: registrationData())
        XCTAssertEqual(manifest.allowed_origins.count, 1)
        XCTAssertEqual(manifest.name, NativeEnrollment.hostName)
        try Data("damaged".utf8).write(to: binary)
        XCTAssertEqual(try installer.check(), .needsRepair)
        try install()
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        try FileManager.default.removeItem(at: installer.registration)
        XCTAssertEqual(try installer.check(), .needsRepair)
        try install()
        try installer.uninstall()
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.registration.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        XCTAssertEqual(try installer.check(), .notInstalled)
    }
    func testConflictingRegistrationNeverReplacedOrRemoved() throws {
        try FileManager.default.createDirectory(at: installer.registration.deletingLastPathComponent(),
                                               withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let existing = Data("{\"path\":\"/existing/development/checkout/helper\"}".utf8)
        try existing.write(to: installer.registration)
        XCTAssertThrowsError(try install()) { XCTAssertEqual($0 as? SetupError, .registrationConflict) }
        XCTAssertThrowsError(try installer.uninstall()) { XCTAssertEqual($0 as? SetupError, .registrationConflict) }
        XCTAssertEqual(try registrationData(), existing)
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
    }
    func testDisplayNameChangeDoesNotStrandReceiptOwnedInstallation() throws {
        try install()
        var object = try JSONSerialization.jsonObject(with: registrationData()) as! [String: Any]
        object["description"] = "Anon VPN connection helper"
        try JSONSerialization.data(withJSONObject: object).write(to: installer.registration)
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        try install()
        let repaired = try JSONDecoder().decode(NativeEnrollment.Manifest.self, from: registrationData())
        XCTAssertEqual(repaired.description, "Anon Network Guard")
        try installer.uninstall()
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.registration.path))
    }
    func testOtherChannelRegistrationUntouched() throws {
        let otherName = NativeEnrollment.channel == "development" ? "inc.anon.network_helper.json" : "inc.anon.network_helper.dev.json"
        let other = installer.registration.deletingLastPathComponent().appendingPathComponent(otherName)
        try FileManager.default.createDirectory(at: other.deletingLastPathComponent(), withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let marker = Data("other-channel-registration".utf8)
        try marker.write(to: other)
        try install(); try installer.uninstall()
        XCTAssertEqual(try Data(contentsOf: other), marker)
    }
    func testInterruptedUpdateKeepsWorkingRegistrationAndCanRepair() throws {
        try install()
        let old = try registrationData()
        let newBytes = Data("next synthetic version".utf8)
        try newBytes.write(to: source)
        let next = SetupPayload(version: "0.1.1", channel: NativeEnrollment.channel, sha256: UserInstaller.digest(newBytes))
        installer.beforeRegistration = { throw SetupError.ioFailure }
        XCTAssertThrowsError(try installer.install(payload: next, bundledHelper: source))
        XCTAssertEqual(try registrationData(), old)
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        installer.beforeRegistration = nil
        try installer.install(payload: next, bundledHelper: source)
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.1"))
        try installer.uninstall()
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
    }
    func testInterruptedFirstInstallCanRepair() throws {
        installer.beforeRegistration = { throw SetupError.ioFailure }
        XCTAssertThrowsError(try install())
        XCTAssertEqual(try installer.check(), .needsRepair)
        installer.beforeRegistration = nil
        try install()
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
    }
    func testPayloadWrongChannelHashAndVersionRejectedBeforeWrites() throws {
        for value in [
            SetupPayload(version: "0.1.0", channel: "another-channel", sha256: payload.sha256),
            SetupPayload(version: "../escape", channel: payload.channel, sha256: payload.sha256),
            SetupPayload(version: "0.1.0\n", channel: payload.channel, sha256: payload.sha256),
            SetupPayload(version: String(repeating: "1", count: 250) + ".0.0", channel: payload.channel, sha256: payload.sha256),
            SetupPayload(version: "0.1.0", channel: payload.channel, sha256: String(repeating: "0", count: 64)),
        ] {
            XCTAssertThrowsError(try installer.install(payload: value, bundledHelper: source))
            XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
        }
    }
    func testBundledMetadataRejectsOversizedInputAndNonFiles() throws {
        let resources = temporary.appendingPathComponent("resources")
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        let metadata = resources.appendingPathComponent("payload.json")
        try Data(repeating: 32, count: 4096).write(to: metadata)
        XCTAssertThrowsError(try SetupPayload.load(from: resources)) { XCTAssertEqual($0 as? SetupError, .invalidPayload) }
        try FileManager.default.removeItem(at: metadata)
        try FileManager.default.createDirectory(at: metadata, withIntermediateDirectories: false)
        XCTAssertThrowsError(try SetupPayload.load(from: resources)) { XCTAssertEqual($0 as? SetupError, .invalidPayload) }
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
    }
    func testUnknownFilesPreventDestructiveRemoval() throws {
        try install()
        let extra = try registeredBinary().deletingLastPathComponent().appendingPathComponent("user-notes.txt")
        try content.write(to: extra)
        XCTAssertThrowsError(try installer.uninstall()) { XCTAssertEqual($0 as? SetupError, .ownershipConflict) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: installer.registration.path))
        XCTAssertEqual(try Data(contentsOf: extra), content)
    }
    func testRegistrationExtraOriginsRejected() throws {
        try install()
        var object = try JSONSerialization.jsonObject(with: registrationData()) as! [String: Any]
        object["allowed_origins"] = ["chrome-extension://\(NativeEnrollment.developmentExtensionID)/",
                                     "chrome-extension://\(NativeEnrollment.productionExtensionID)/"]
        try JSONSerialization.data(withJSONObject: object).write(to: installer.registration)
        XCTAssertThrowsError(try installer.check()) { XCTAssertEqual($0 as? SetupError, .registrationConflict) }
        XCTAssertThrowsError(try install())
        XCTAssertThrowsError(try installer.uninstall())
    }
    func testSymlinkAndWritableDestinationRejected() throws {
        let library = userHome.appendingPathComponent("Library")
        let elsewhere = temporary.appendingPathComponent("elsewhere")
        try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: library, withDestinationURL: elsewhere)
        XCTAssertThrowsError(try install()) { XCTAssertEqual($0 as? SetupError, .unsafePath) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: elsewhere.path), [])
        try FileManager.default.removeItem(at: library)
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: library.path)
        XCTAssertThrowsError(try install()) { XCTAssertEqual($0 as? SetupError, .unsafePath) }
    }
    func testUnrecognizedReceiptAndSymlinkedBinaryFailClosed() throws {
        try install()
        let binary = try registeredBinary()
        try FileManager.default.removeItem(at: binary)
        try FileManager.default.createSymbolicLink(at: binary, withDestinationURL: source)
        XCTAssertThrowsError(try installer.check()) { XCTAssertEqual($0 as? SetupError, .unsafePath) }
        XCTAssertThrowsError(try installer.uninstall()) { XCTAssertEqual($0 as? SetupError, .unsafePath) }
        XCTAssertEqual(try Data(contentsOf: source), content)
    }
    func testDirectoryAtBinaryPathNeverRecursivelyRemoved() throws {
        try install()
        let binary = try registeredBinary()
        try FileManager.default.removeItem(at: binary)
        try FileManager.default.createDirectory(at: binary, withIntermediateDirectories: false)
        let unrelated = binary.appendingPathComponent("do-not-delete.txt")
        try content.write(to: unrelated)
        XCTAssertThrowsError(try installer.uninstall()) { XCTAssertEqual($0 as? SetupError, .ownershipConflict) }
        XCTAssertTrue(FileManager.default.fileExists(atPath: installer.registration.path))
        XCTAssertEqual(try Data(contentsOf: unrelated), content)
    }
    func testFullJournalNeverBecomesUnreadableAfterAnotherInstall() throws {
        try install()
        let receiptURL = installer.root.appendingPathComponent("installation.json")
        let versions = [payload] + (1..<128).map {
            SetupPayload(version: "0.1.\($0)", channel: payload.channel, sha256: payload.sha256)
        }
        let record = InstallationReceipt(schemaVersion: 1, owner: InstallationReceipt.ownerID,
                                         channel: payload.channel, versions: versions)
        try JSONEncoder().encode(record).write(to: receiptURL)
        let before = try Data(contentsOf: receiptURL)
        let extra = SetupPayload(version: "0.2.0", channel: payload.channel, sha256: payload.sha256)
        XCTAssertThrowsError(try installer.install(payload: extra, bundledHelper: source)) {
            XCTAssertEqual($0 as? SetupError, .ownershipConflict)
        }
        XCTAssertEqual(try Data(contentsOf: receiptURL), before)
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
    }
}

final class RollbackAndCommandLineTests: XCTestCase {
    var temporary: URL!
    var userHome: URL!
    var installer: UserInstaller!
    override func setUpWithError() throws {
        temporary = FileManager.default.temporaryDirectory.appendingPathComponent("anon-setup-cli-\(UUID().uuidString)")
            .standardizedFileURL.resolvingSymlinksInPath()
        userHome = temporary.appendingPathComponent("user")
        try FileManager.default.createDirectory(at: userHome, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        installer = UserInstaller(home: userHome)
    }
    override func tearDownWithError() throws {
        // Exact freshly created fixture only; never a real home or installation.
        try FileManager.default.removeItem(at: temporary)
    }
    /// A bundled helper and payload.json, as in Setup.app's Resources.
    func resources(_ version: String, _ bytes: String) throws -> (URL, SetupPayload) {
        let folder = temporary.appendingPathComponent("resources-\(version)-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let data = Data(bytes.utf8)
        try data.write(to: folder.appendingPathComponent("anon-network-helper"))
        let payload = SetupPayload(version: version, channel: NativeEnrollment.channel, sha256: UserInstaller.digest(data))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(payload).write(to: folder.appendingPathComponent("payload.json"))
        return (folder, payload)
    }
    func registeredPath() throws -> String {
        let object = try JSONSerialization.jsonObject(with: Data(contentsOf: installer.registration)) as! [String: Any]
        return object["path"] as! String
    }
    func run(_ arguments: [String], _ resources: URL? = nil) -> (Int32, [String: Any]) {
        let result = SetupCommandLine.run(arguments + ["--home", userHome.path], resources: resources, home: temporary)
        let object = (try? JSONSerialization.jsonObject(with: Data(result.output.utf8))) as? [String: Any] ?? [:]
        return (result.status, object)
    }

    func testActivateRollsBackToAnInstalledVersionOnly() throws {
        let (first, one) = try resources("0.1.0", "first synthetic helper")
        let (second, two) = try resources("0.1.1", "second synthetic helper")
        try installer.install(payload: one, bundledHelper: first.appendingPathComponent("anon-network-helper"))
        try installer.install(payload: two, bundledHelper: second.appendingPathComponent("anon-network-helper"))
        XCTAssertEqual(try installer.inventory(), InstallationInventory(versions: [one, two], active: two, registration: "owned"))
        XCTAssertEqual(try installer.activate(directory: one.directoryName), one)
        XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        XCTAssertEqual(try registeredPath(), installer.helperURL(one).path)
        XCTAssertThrowsError(try installer.activate(directory: "0.9.9-" + String(repeating: "0", count: 64))) {
            XCTAssertEqual($0 as? SetupError, .installationDamaged)
        }
        try Data("tampered".utf8).write(to: installer.helperURL(two))
        XCTAssertThrowsError(try installer.activate(directory: two.directoryName)) {
            XCTAssertEqual($0 as? SetupError, .installationDamaged)
        }
        XCTAssertEqual(try registeredPath(), installer.helperURL(one).path)
    }

    func testActivateAndInventoryRespectAForeignRegistration() throws {
        let (folder, one) = try resources("0.1.0", "synthetic helper")
        try installer.install(payload: one, bundledHelper: folder.appendingPathComponent("anon-network-helper"))
        let foreign = try JSONSerialization.data(withJSONObject: [
            "name": NativeEnrollment.hostName, "description": "Device Guard bridge", "path": "/Applications/Other.app/host",
            "type": "stdio", "allowed_origins": ["chrome-extension://\(NativeEnrollment.allowedExtensionIDs.first!)/"]])
        try foreign.write(to: installer.registration)
        XCTAssertEqual(try installer.inventory(), InstallationInventory(versions: [one], active: nil, registration: "foreign"))
        XCTAssertThrowsError(try installer.activate(directory: one.directoryName)) {
            XCTAssertEqual($0 as? SetupError, .registrationConflict)
        }
        XCTAssertEqual(try Data(contentsOf: installer.registration), foreign)
    }

    func testCommandLineInstallListActivateUninstall() throws {
        let (first, one) = try resources("0.1.0", "first synthetic helper")
        let (second, two) = try resources("0.1.1", "second synthetic helper")
        var (status, reply) = run(["--check"])
        XCTAssertEqual(status, 0); XCTAssertEqual(reply["state"] as? String, "notInstalled")
        (status, reply) = run(["--install"], first)
        XCTAssertEqual(status, 0); XCTAssertEqual((reply["active"] as? [String: Any])?["directory"] as? String, one.directoryName)
        XCTAssertEqual(reply["registrationPath"] as? String, installer.registration.path)
        (status, reply) = run(["--install"], second)
        XCTAssertEqual(status, 0)
        (status, reply) = run(["--list"])
        XCTAssertEqual((reply["versions"] as? [[String: Any]])?.compactMap { $0["directory"] as? String },
                       [one.directoryName, two.directoryName])
        XCTAssertEqual((reply["active"] as? [String: Any])?["helper"] as? String, installer.helperURL(two).path)
        XCTAssertEqual(reply["registration"] as? String, "owned")
        (status, reply) = run(["--activate", one.directoryName])
        XCTAssertEqual(status, 0); XCTAssertEqual(try installer.check(), .installed(version: "0.1.0"))
        (status, reply) = run(["--activate", "unknown"])
        XCTAssertEqual(status, 1); XCTAssertEqual(reply["error"] as? String, "installationDamaged")
        (status, reply) = run(["--uninstall"])
        XCTAssertEqual(status, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.root.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer.registration.path))
    }

    func testCommandLineRefusesUsageErrorsAndNeverUsesTheDefaultHomeWhenOneIsGiven() throws {
        for arguments in [["--install", "--home"], ["--install", "--home", "relative"], ["--activate"], ["--check", "--extra"], ["--window"]] {
            let result = SetupCommandLine.run(arguments, resources: nil, home: temporary)
            XCTAssertEqual(result.status, 64, arguments.joined(separator: " "))
        }
        XCTAssertFalse(SetupCommandLine.handles([]))
        XCTAssertFalse(SetupCommandLine.handles(["-psn_0_12345"]))
        let (status, reply) = run(["--install"], nil)
        XCTAssertEqual(status, 1); XCTAssertEqual(reply["error"] as? String, "invalidPayload")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: temporary.path), ["user"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: userHome.path), [])
    }
}
