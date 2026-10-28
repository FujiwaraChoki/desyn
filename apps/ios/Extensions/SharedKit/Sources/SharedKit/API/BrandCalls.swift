import DesynKit
import Foundation

/// `brand/brandKits:list|get` item with what applying a kit needs (logo asset ids and refs, font assets, roles).
public struct BrandKitDetail: Decodable, Hashable, Sendable, Identifiable {
    public struct BrandColor: Decodable, Hashable, Sendable {
        public let id: String?
        public let name: String
        public let value: String
        /// `primary` | `secondary` | `accent` | `background` | `text` | ... (free-form).
        public let role: String?

        public init(id: String?, name: String, value: String, role: String?) {
            self.id = id
            self.name = name
            self.value = value
            self.role = role
        }
    }

    public struct Logo: Decodable, Hashable, Sendable {
        public let id: String?
        /// Convex `assets` id.
        public let assetId: String?
        public let name: String?
        public let variant: String?
        /// `AssetRef.id` for designs.
        public let refId: String?
        public let mime: String?
        public let width: Double?
        public let height: Double?
        public let url: String?
    }

    public struct FontSlot: Decodable, Hashable, Sendable {
        public let family: String
        public let weight: Double?
        public let style: String?
        public let assetId: String?
        public let refId: String?
        public let url: String?
        public let fallback: String?

        public init(family: String, weight: Double?, style: String?, assetId: String? = nil, refId: String? = nil, url: String? = nil, fallback: String? = nil) {
            self.family = family
            self.weight = weight
            self.style = style
            self.assetId = assetId
            self.refId = refId
            self.url = url
            self.fallback = fallback
        }
    }

    public struct Fonts: Decodable, Hashable, Sendable {
        public let heading: FontSlot?
        public let body: FontSlot?
        public let accent: FontSlot?

        public init(heading: FontSlot?, body: FontSlot?, accent: FontSlot?) {
            self.heading = heading
            self.body = body
            self.accent = accent
        }
    }

    public struct Voice: Decodable, Hashable, Sendable {
        public let tone: String?
        public let description: String?
    }

    public let id: String
    public let workspaceId: String?
    public let name: String
    public let logos: [Logo]
    public let colors: [BrandColor]
    public let fonts: Fonts
    public let voice: Voice?
    public let isDefault: Bool

    public init(id: String, workspaceId: String?, name: String, logos: [Logo], colors: [BrandColor], fonts: Fonts, voice: Voice?, isDefault: Bool) {
        self.id = id
        self.workspaceId = workspaceId
        self.name = name
        self.logos = logos
        self.colors = colors
        self.fonts = fonts
        self.voice = voice
        self.isDefault = isDefault
    }
}

public extension DesynAPI {
    /// The workspace's brand kits (default first).
    func brandKitDetails(workspaceId: String) async throws -> [BrandKitDetail] {
        let kits = try await transport.query("brand/brandKits:list", args: ["workspaceId": workspaceId], as: [BrandKitDetail].self)
        return kits.sorted { lhs, rhs in
            if lhs.isDefault != rhs.isDefault { return lhs.isDefault }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }
}
