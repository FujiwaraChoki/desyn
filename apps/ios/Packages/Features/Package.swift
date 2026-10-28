// swift-tools-version: 6.0
//
// Features: the app's screens as separate modules.
//   FeatureCore    - the signed-in session (Convex client, auth, offline store, toasts), deep links
//   AuthFeature    - email + password, magic link (universal link), browser sign-in (PKCE + ASWebAuthenticationSession)
//   LibraryFeature - recent / folders / shared / templates / brand, search, create from presets, offline cache
//   EditorFeature  - the Metal canvas over the Rust engine, gestures, Apple Pencil, text input, undo, pages
//   AppFeature     - root view and routing
import PackageDescription

let package = Package(
    name: "Features",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "FeatureCore", targets: ["FeatureCore"]),
        .library(name: "AuthFeature", targets: ["AuthFeature"]),
        .library(name: "LibraryFeature", targets: ["LibraryFeature"]),
        .library(name: "EditorFeature", targets: ["EditorFeature"]),
        .library(name: "AppFeature", targets: ["AppFeature"]),
    ],
    dependencies: [
        .package(path: "../DesignSystem"),
        .package(path: "../DesynKit"),
        .package(path: "../../DesynEngine"),
    ],
    targets: [
        .target(
            name: "FeatureCore",
            dependencies: ["DesignSystem", "DesynKit"],
            path: "Sources/FeatureCore"
        ),
        .target(
            name: "AuthFeature",
            dependencies: ["FeatureCore", "DesignSystem", "DesynKit"],
            path: "Sources/AuthFeature"
        ),
        .target(
            name: "LibraryFeature",
            dependencies: ["FeatureCore", "DesignSystem", "DesynKit"],
            path: "Sources/LibraryFeature"
        ),
        .target(
            name: "EditorFeature",
            dependencies: ["FeatureCore", "DesignSystem", "DesynKit", .product(name: "DesynEngine", package: "DesynEngine")],
            path: "Sources/EditorFeature"
        ),
        .target(
            name: "AppFeature",
            dependencies: ["FeatureCore", "AuthFeature", "LibraryFeature", "EditorFeature", "DesignSystem", "DesynKit"],
            path: "Sources/AppFeature"
        ),
    ],
    swiftLanguageModes: [.v5]
)
