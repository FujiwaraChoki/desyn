// swift-tools-version: 6.0
//
// SharedKit: code shared by the app's editor features (apps/ios/Features/*) and its extensions
// (share extension, widget, App Intents).
//   AppGroupKit - Foundation only, no other dependency: the App Group container and the recent-designs snapshot the
//                 widget reads (the widget links only this).
//   SharedKit   - Foundation only (on DesynKit): typed Convex calls of the editor features, AI run events and
//                 timeline, op builders for the inspector, element / brand / import factories, Iconify and Google
//                 Fonts clients, the generated font catalog. Tested on Linux by scripts/linux-test.sh.
//   PanelKit    - SwiftUI + UIKit on EditorFeature: the per-editor context (open panel, AI highlights, fonts),
//                 shared panel components, cached remote images, engine-rendered previews.
import PackageDescription

let package = Package(
    name: "SharedKit",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AppGroupKit", targets: ["AppGroupKit"]),
        .library(name: "SharedKit", targets: ["SharedKit"]),
        .library(name: "PanelKit", targets: ["PanelKit"]),
    ],
    dependencies: [
        .package(path: "../../Packages/DesignSystem"),
        .package(path: "../../Packages/DesynKit"),
        .package(path: "../../Packages/Features"),
        .package(path: "../../DesynEngine"),
    ],
    targets: [
        .target(
            name: "AppGroupKit",
            path: "Sources/AppGroupKit"
        ),
        .target(
            name: "SharedKit",
            dependencies: ["AppGroupKit", "DesynKit"],
            path: "Sources/SharedKit"
        ),
        .target(
            name: "PanelKit",
            dependencies: [
                "SharedKit",
                "DesignSystem",
                "DesynKit",
                .product(name: "EditorFeature", package: "Features"),
                .product(name: "FeatureCore", package: "Features"),
                .product(name: "DesynEngine", package: "DesynEngine"),
            ],
            path: "Sources/PanelKit"
        ),
        .testTarget(
            name: "SharedKitTests",
            dependencies: ["SharedKit", "AppGroupKit", "DesynKit"],
            path: "Tests/SharedKitTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
