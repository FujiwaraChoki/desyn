// swift-tools-version: 6.0
//
// AssetsFeature: the insert sheet (shapes, text presets, Iconify icons, charts, tables, QR codes), photos
// (PhotosPicker, camera, uploads through presigned S3), stock photos through the backend, the workspace library
// and brand kits (browse and apply). Tests live in Tests/ and run in the app's DesynTests bundle (project.yml).
// Plugs into the editor through EditorFeature's EditorExtensions (registered by the app's integration layer,
// apps/ios/Extensions/App). Shared panel UI, API calls and op builders come from apps/ios/Extensions/SharedKit.
import PackageDescription

let package = Package(
    name: "AssetsFeature",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "AssetsFeature", targets: ["AssetsFeature"]),
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
            name: "AssetsFeature",
            dependencies: [
                "DesignSystem",
                "DesynKit",
                .product(name: "FeatureCore", package: "Features"),
                .product(name: "EditorFeature", package: "Features"),
                .product(name: "DesynEngine", package: "DesynEngine"),
                .product(name: "SharedKit", package: "SharedKit"),
                .product(name: "PanelKit", package: "SharedKit"),
            ],
            path: "Sources/AssetsFeature"
        ),
    ],
    swiftLanguageModes: [.v5]
)
