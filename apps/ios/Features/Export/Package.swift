// swift-tools-version: 6.0
//
// ExportFeature: export (formats and options rendered on the device with the engine, MP4 and fallbacks on the
// server) to the share sheet, Photos or Files. Tests live in Tests/ and run in the app's DesynTests bundle
// (project.yml). Plugs into the editor through EditorFeature's EditorExtensions (registered by the app's
// integration layer, apps/ios/Extensions/App). Shared panel UI, API calls and op builders come from
// apps/ios/Extensions/SharedKit.
import PackageDescription

let package = Package(
    name: "ExportFeature",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "ExportFeature", targets: ["ExportFeature"]),
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
            name: "ExportFeature",
            dependencies: [
                "DesignSystem",
                "DesynKit",
                .product(name: "FeatureCore", package: "Features"),
                .product(name: "EditorFeature", package: "Features"),
                .product(name: "DesynEngine", package: "DesynEngine"),
                .product(name: "SharedKit", package: "SharedKit"),
                .product(name: "PanelKit", package: "SharedKit"),
            ],
            path: "Sources/ExportFeature"
        ),
    ],
    swiftLanguageModes: [.v5]
)
