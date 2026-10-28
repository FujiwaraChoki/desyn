// swift-tools-version: 6.0
//
// InspectorFeature: the inspector as resizable sheets: fill, stroke, effects, text styles (font picker with live
// previews), arrange, position, animate, chart / table / QR data, and the sun color picker. Tests live in Tests/
// and run in the app's DesynTests bundle (project.yml). Plugs into the editor through EditorFeature's
// EditorExtensions (registered by the app's integration layer, apps/ios/Extensions/App). Shared panel UI, API
// calls and op builders come from apps/ios/Extensions/SharedKit.
import PackageDescription

let package = Package(
    name: "InspectorFeature",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "InspectorFeature", targets: ["InspectorFeature"]),
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
            name: "InspectorFeature",
            dependencies: [
                "DesignSystem",
                "DesynKit",
                .product(name: "FeatureCore", package: "Features"),
                .product(name: "EditorFeature", package: "Features"),
                .product(name: "DesynEngine", package: "DesynEngine"),
                .product(name: "SharedKit", package: "SharedKit"),
                .product(name: "PanelKit", package: "SharedKit"),
            ],
            path: "Sources/InspectorFeature"
        ),
    ],
    swiftLanguageModes: [.v5]
)
