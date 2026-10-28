// swift-tools-version: 6.0
//
// DesignSystem: the Desyn "Atmospheric Minimalism" sun theme for iOS (docs/DESIGN_SYSTEM.md): colors with light
// and dark variants, bundled Instrument Serif / Instrument Sans / JetBrains Mono, spacing, radii, motion and the
// shared SwiftUI components (buttons, fields, cards, sheets, sun spinner, orbs background, glass bars).
import PackageDescription

let package = Package(
    name: "DesignSystem",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "DesignSystem", targets: ["DesignSystem"]),
    ],
    targets: [
        .target(
            name: "DesignSystem",
            path: "Sources/DesignSystem",
            resources: [.copy("Resources/Fonts")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
