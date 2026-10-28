import DesynKit
import Foundation

/// A design to open in the editor.
public struct DesignRoute: Hashable, Identifiable, Sendable {
    /// Convex `designs` id.
    public let designId: String
    /// Name shown while loading.
    public let name: String
    /// Set when the design is reached through a share link (shared with me).
    public let share: ShareAccess?

    public var id: String { designId }

    public init(designId: String, name: String, share: ShareAccess? = nil) {
        self.designId = designId
        self.name = name
        self.share = share
    }

    public init(summary: DesignSummary) {
        self.init(
            designId: summary.id,
            name: summary.name,
            share: summary.shareToken.map { ShareAccess(token: $0) }
        )
    }
}
