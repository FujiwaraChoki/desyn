import Foundation

/// `DesignKind` (open: unknown kinds from newer servers are kept as-is).
public struct DesignKind: RawRepresentable, Hashable, Codable, Sendable, CustomStringConvertible {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public init(from decoder: Decoder) throws {
        rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public var description: String { rawValue }

    public static let socialPost = DesignKind(rawValue: "social-post")
    public static let story = DesignKind(rawValue: "story")
    public static let presentation = DesignKind(rawValue: "presentation")
    public static let custom = DesignKind(rawValue: "custom")

    /// Display info from @desyn/schema DESIGN_KIND_INFO.
    public var info: DesignKindInfo? { DesignKindInfo.all.first { $0.kind == self } }

    /// Human label ("Social post"); falls back to the raw value.
    public var label: String { info?.label ?? rawValue.replacingOccurrences(of: "-", with: " ").capitalized }

    /// SF Symbol for this kind (mapped from the Lucide icon the web uses).
    public var systemImage: String {
        switch rawValue {
        case "social-post": "square.on.square"
        case "story": "iphone"
        case "poster": "doc.richtext"
        case "flyer": "doc.text.image"
        case "thumbnail": "play.rectangle"
        case "banner": "rectangle.split.3x1"
        case "ad": "megaphone"
        case "presentation": "rectangle.on.rectangle.angled"
        case "infographic": "chart.bar.doc.horizontal"
        case "business-card": "person.text.rectangle"
        case "resume": "doc.plaintext"
        case "invitation": "envelope.open"
        case "menu": "fork.knife"
        case "logo": "seal"
        case "newsletter": "newspaper"
        case "document": "doc"
        case "whiteboard": "scribble.variable"
        case "website": "globe"
        case "video": "film"
        case "book-cover": "book.closed"
        case "certificate": "rosette"
        case "sticker": "face.smiling"
        case "mockup": "macbook.and.iphone"
        default: "square.dashed"
        }
    }
}

/// `DESIGN_KIND_INFO` entry.
public struct DesignKindInfo: Hashable, Sendable {
    public let kind: DesignKind
    public let label: String
    /// Lucide icon name used by the web app.
    public let icon: String
    public let description: String
    public let defaultPreset: String
    public let multiPage: Bool

    public init(kind: DesignKind, label: String, icon: String, description: String, defaultPreset: String, multiPage: Bool) {
        self.kind = kind
        self.label = label
        self.icon = icon
        self.description = description
        self.defaultPreset = defaultPreset
        self.multiPage = multiPage
    }
}

/// Node `type` discriminants.
public enum NodeType: String, Sendable, CaseIterable {
    case root, page, frame, group, boolean, rect, ellipse, polygon, star, line, path, text, image, svg, video, audio
    case chart, table, qr

    /// Types with `children`.
    public var isContainer: Bool {
        switch self {
        case .root, .page, .frame, .group, .boolean: true
        default: false
        }
    }

    /// SF Symbol for the layers list.
    public var systemImage: String {
        switch self {
        case .root: "square.stack.3d.up"
        case .page: "doc"
        case .frame: "number.square"
        case .group: "square.on.square.dashed"
        case .boolean: "square.on.circle"
        case .rect: "rectangle"
        case .ellipse: "circle"
        case .polygon: "hexagon"
        case .star: "star"
        case .line: "line.diagonal"
        case .path: "scribble"
        case .text: "textformat"
        case .image: "photo"
        case .svg: "pencil.and.outline"
        case .video: "film"
        case .audio: "waveform"
        case .chart: "chart.bar"
        case .table: "tablecells"
        case .qr: "qrcode"
        }
    }
}

/// `Unit` of a page.
public enum PageUnit: String, Sendable, CaseIterable {
    case px, mm, `in`, pt

    /// Design px per unit (1 px = 1/96 in).
    public var pxPerUnit: Double {
        switch self {
        case .px: 1
        case .in: 96
        case .mm: 96 / 25.4
        case .pt: 96.0 / 72.0
        }
    }
}
