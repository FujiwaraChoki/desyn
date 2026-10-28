import Foundation

/// Page size preset (`PagePreset` of @desyn/schema). `width` / `height` are design px; print presets carry their
/// physical size, display unit, export dpi and bleed. The list itself is generated (`PagePreset.all`).
public struct PagePreset: Hashable, Sendable, Identifiable {
    public enum Category: String, Sendable, CaseIterable {
        case social, video, print, presentation, web, ads, other

        public var label: String {
            switch self {
            case .social: "Social"
            case .video: "Video"
            case .print: "Print"
            case .presentation: "Presentation"
            case .web: "Web"
            case .ads: "Ads"
            case .other: "Other"
            }
        }

        public var systemImage: String {
            switch self {
            case .social: "heart.text.square"
            case .video: "play.rectangle"
            case .print: "printer"
            case .presentation: "rectangle.on.rectangle.angled"
            case .web: "globe"
            case .ads: "megaphone"
            case .other: "square.dashed"
            }
        }
    }

    public struct SafeArea: Hashable, Sendable {
        public let top, right, bottom, left: Double

        public init(top: Double, right: Double, bottom: Double, left: Double) {
            self.top = top
            self.right = right
            self.bottom = bottom
            self.left = left
        }
    }

    public struct PhysicalSize: Hashable, Sendable {
        public let width: Double
        public let height: Double
        /// `mm` or `in`.
        public let unit: String

        public init(width: Double, height: Double, unit: String) {
            self.width = width
            self.height = height
            self.unit = unit
        }
    }

    public let id: String
    public let label: String
    public let kind: DesignKind
    public let category: Category
    public let platform: String?
    public let width: Double
    public let height: Double
    public let unit: String
    public let dpi: Double?
    public let bleed: Double?
    public let safeArea: SafeArea?
    public let physical: PhysicalSize?

    public init(
        id: String, label: String, kind: DesignKind, category: Category, platform: String?, width: Double, height: Double,
        unit: String, dpi: Double?, bleed: Double?, safeArea: SafeArea?, physical: PhysicalSize?
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.category = category
        self.platform = platform
        self.width = width
        self.height = height
        self.unit = unit
        self.dpi = dpi
        self.bleed = bleed
        self.safeArea = safeArea
        self.physical = physical
    }

    /// "1080 x 1080 px" or "210 x 297 mm".
    public var sizeLabel: String {
        if let physical {
            return "\(Self.trim(physical.width)) x \(Self.trim(physical.height)) \(physical.unit)"
        }
        return "\(Self.trim(width)) x \(Self.trim(height)) px"
    }

    /// Width / height.
    public var aspectRatio: Double { height > 0 ? width / height : 1 }

    public static func preset(id: String) -> PagePreset? {
        all.first { $0.id == id }
    }

    /// Presets grouped by category in display order, optionally filtered by a search query.
    public static func grouped(matching query: String = "") -> [(category: Category, presets: [PagePreset])] {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        let filtered = needle.isEmpty ? all : all.filter {
            $0.label.lowercased().contains(needle) || $0.kind.label.lowercased().contains(needle)
                || ($0.platform?.lowercased().contains(needle) ?? false)
        }
        return Category.allCases.compactMap { category in
            let presets = filtered.filter { $0.category == category }
            return presets.isEmpty ? nil : (category, presets)
        }
    }

    private static func trim(_ value: Double) -> String {
        value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }
}
