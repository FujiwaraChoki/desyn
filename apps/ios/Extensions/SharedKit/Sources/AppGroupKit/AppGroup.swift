import Foundation

/// The App Group the app, the share extension and the widget share (`com.apple.security.application-groups`).
public enum AppGroup {
    /// Must match the entitlements of the app, `DesynShare` and `DesynWidgets`.
    public static let identifier = "group.app.desyn.ios"

    /// The shared container, or nil when the entitlement is missing (unsigned simulator builds, tests).
    public static func containerURL(fileManager: FileManager = .default) -> URL? {
        #if os(iOS) || os(macOS)
        return fileManager.containerURL(forSecurityApplicationGroupIdentifier: identifier)
        #else
        return nil
        #endif
    }

    /// `<container>/Library/Application Support/Desyn`, created on demand. Falls back to this process's Application
    /// Support directory so the app keeps working (without sharing) when the group is unavailable.
    public static func sharedDirectory(fileManager: FileManager = .default) -> URL {
        let base: URL
        if let container = containerURL(fileManager: fileManager) {
            base = container.appendingPathComponent("Library/Application Support", isDirectory: true)
        } else {
            base = (try? fileManager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
                ?? fileManager.temporaryDirectory
        }
        let directory = base.appendingPathComponent("Desyn", isDirectory: true)
        try? fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
