import FeatureCore
import SwiftUI

// Extension points of the library for feature modules outside this package (apps/ios/Features/Settings). The app
// registers a `LibraryExtensions` value at launch; without one the built-in account sheet is shown.

/// Views the library embeds from feature modules.
public struct LibraryExtensions {
    public typealias AccountSlot = @MainActor (AppSession) -> AnyView

    /// Replaces the account sheet behind the avatar button (settings: account, appearance, AI, plan).
    public var account: AccountSlot?

    public init(account: AccountSlot? = nil) {
        self.account = account
    }

    /// Set once by the app at launch; the environment default.
    nonisolated(unsafe) public static var registered = LibraryExtensions()
}

private struct LibraryExtensionsKey: EnvironmentKey {
    static var defaultValue: LibraryExtensions { LibraryExtensions.registered }
}

public extension EnvironmentValues {
    /// The library's feature views (defaults to `LibraryExtensions.registered`).
    var libraryExtensions: LibraryExtensions {
        get { self[LibraryExtensionsKey.self] }
        set { self[LibraryExtensionsKey.self] = newValue }
    }
}
