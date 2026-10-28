// swift-tools-version: 6.0
//
// ShareFeature: share links: create, permissions, password, expiry, copy, system share sheet, revoke. Tests live
// in Tests/ and run in the app's DesynTests bundle (project.yml). Plugs into the editor through EditorFeature's
// EditorExtensions (registered by the app's integration layer, apps/ios/Extensions/App). Shared panel UI, API
// calls and op builders come from apps/ios/Extensions/SharedKit.
import PackageDescription

let package = Package(
    name: "ShareFeature",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "ShareFeature", targets: ["ShareFeature"]),
    ],
    dependencies: [
        .package(path: "../../Packages/DesignSystem"),
        .package(path: "../../Packages/DesynKit"),
        .package(path: "../../Packages/Features"),
        .package(path: "../../DesynEngine"),
        .package(path: "../../Extensions/SharedKit"),
    ],
    targets: [
        .target(
            name: "ShareFeature",
            dependencies: [
                "DesignSystem",
                "DesynKit",
                .product(name: "FeatureCore", package: "Features"),
                .product(name: "EditorFeature", package: "Features"),
                .product(name: "DesynEngine", package: "DesynEngine"),
                .product(name: "SharedKit", package: "SharedKit"),
                .product(name: "PanelKit", package: "SharedKit"),
            ],
            path: "Sources/ShareFeature"
        ),
    ],
    swiftLanguageModes: [.v5]
)
