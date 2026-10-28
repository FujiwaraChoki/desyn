import Foundation

// Extension point of the app shell for the integration layer outside this package (apps/ios/Extensions/App):
// links the built-in routing does not know (`desyn://new`, `desyn://create?...` from the widget and Shortcuts).
extension AppModel {
    /// Called first for every opened URL; returns true when it handled the link.
    nonisolated(unsafe) public static var linkHandler: (@MainActor (URL, AppModel) async -> Bool)?
}
