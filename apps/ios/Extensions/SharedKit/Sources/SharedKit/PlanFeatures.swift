import Foundation

/// The plan features that gate work the app does on the device (local exports). The server enforces the same keys
/// for everything it does; this keeps the device from producing what the person's plan does not include.
///
/// Resolution order: the features `accounts/profiles:me` resolved live (plan + feature flags), then the generated
/// table for the known plan id (offline), then the Free plan.
public struct PlanFeatures: Equatable, Sendable {
    /// Feature key -> included.
    public let values: [String: Bool]

    public init(values: [String: Bool]) {
        self.values = values
    }

    /// `live` (from `profiles:me`) wins; otherwise the table for `plan`; otherwise Free.
    public static func resolve(live: [String: Bool]?, plan: String?) -> PlanFeatures {
        let base = plan.flatMap { table[$0] } ?? table["free"] ?? [:]
        guard let live else { return PlanFeatures(values: base) }
        return PlanFeatures(values: base.merging(live) { _, new in new })
    }

    /// Unknown keys are not included.
    public func allows(_ feature: String) -> Bool {
        values[feature] ?? false
    }

    /// Every key in `features` is included.
    public func allowsAll(_ features: [String]) -> Bool {
        features.allSatisfy(allows)
    }

    /// What a locked feature is called, for the "part of Desyn Pro" note (no purchase links: App Store 3.1.1).
    public static func lockedMessage(_ feature: String) -> String {
        let names: [String: (name: String, plural: Bool)] = [
            "charts": ("Charts", true),
            "tables": ("Tables", true),
            "qr": ("QR codes", true),
            "effects.advanced": ("Advanced effects", true),
            "brandKit": ("Brand kits", true),
            "presentation": ("Animations", true),
            "export.webp": ("WebP export", false),
            "export.svg": ("SVG export", false),
            "export.pptx": ("PowerPoint export", false),
            "export.video": ("GIF and video export", false),
            "export.pdfPrint": ("Print options for PDFs", true),
        ]
        guard let entry = names[feature] else { return "This feature is part of Desyn Pro." }
        return "\(entry.name) \(entry.plural ? "are" : "is") part of Desyn Pro."
    }
}
