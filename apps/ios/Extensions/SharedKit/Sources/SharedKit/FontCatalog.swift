import Foundation

/// A family of the curated Google Fonts catalog (`packages/schema/src/fonts.ts`).
public struct FontFamily: Hashable, Sendable, Identifiable {
    public enum Category: String, CaseIterable, Sendable {
        case sansSerif = "sans-serif", serif, display, handwriting, monospace

        public var title: String {
            switch self {
            case .sansSerif: "Sans"
            case .serif: "Serif"
            case .display: "Display"
            case .handwriting: "Script"
            case .monospace: "Mono"
            }
        }
    }

    public let family: String
    public let category: Category
    /// Named weights (every hundred within the wght axis for variable fonts).
    public let weights: [Int]
    public let italic: Bool
    /// The wght axis range of variable families.
    public let variableWeights: ClosedRange<Int>?
    public let pairsWith: [String]
    public let tags: [String]

    public init(family: String, category: Category, weights: [Int], italic: Bool, variableWeights: ClosedRange<Int>?, pairsWith: [String], tags: [String]) {
        self.family = family
        self.category = category
        self.weights = weights
        self.italic = italic
        self.variableWeights = variableWeights
        self.pairsWith = pairsWith
        self.tags = tags
    }

    public var id: String { family }

    /// Families bundled with the engine and the app (always available offline, no download).
    public static let bundledFamilies: Set<String> = ["Inter", "Instrument Sans", "Instrument Serif", "JetBrains Mono"]

    public var isBundled: Bool { Self.bundledFamilies.contains(family) }

    /// The available weight closest to `weight` (ties resolve to the heavier one, like CSS matching).
    public func nearestWeight(_ weight: Double) -> Int {
        if let range = variableWeights {
            return min(range.upperBound, max(range.lowerBound, Int((weight / 100).rounded() * 100)))
        }
        return weights.reduce(weights.first ?? 400) { best, candidate in
            let d = abs(Double(candidate) - weight)
            let bd = abs(Double(best) - weight)
            return d < bd || (d == bd && candidate > best) ? candidate : best
        }
    }

    /// Searches family names and tags (case-insensitive); an empty query matches everything.
    public func matches(_ query: String) -> Bool {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return true }
        return family.lowercased().contains(q) || tags.contains { $0.lowercased().contains(q) } || category.title.lowercased() == q
    }

    public static func named(_ family: String) -> FontFamily? {
        let key = family.lowercased()
        return catalog.first { $0.family.lowercased() == key }
    }

    /// Weight names for the picker.
    public static func weightName(_ weight: Int) -> String {
        switch weight {
        case ..<150: "Thin"
        case ..<250: "Extra light"
        case ..<350: "Light"
        case ..<450: "Regular"
        case ..<550: "Medium"
        case ..<650: "Semibold"
        case ..<750: "Bold"
        case ..<850: "Extra bold"
        default: "Black"
        }
    }
}

/// A heading / body pairing (`FONT_PAIRINGS`).
public struct FontPairing: Hashable, Sendable, Identifiable {
    public let id: String
    public let heading: String
    public let body: String
    public let headingWeight: Int
    public let bodyWeight: Int
    public let moods: [String]
    public let goodFor: [String]

    public init(id: String, heading: String, body: String, headingWeight: Int, bodyWeight: Int, moods: [String], goodFor: [String]) {
        self.id = id
        self.heading = heading
        self.body = body
        self.headingWeight = headingWeight
        self.bodyWeight = bodyWeight
        self.moods = moods
        self.goodFor = goodFor
    }

    /// Pairings recommended for a design kind, then the rest.
    public static func suggested(for kind: String) -> [FontPairing] {
        let good = all.filter { $0.goodFor.contains(kind) }
        return good + all.filter { !$0.goodFor.contains(kind) }
    }
}
