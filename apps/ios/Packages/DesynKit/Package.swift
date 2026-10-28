// swift-tools-version: 6.0
//
// DesynKit: models mirroring docs/DOCUMENT_MODEL.md (Codable, lossless for unknown keys), the Convex API facade
// over convex-swift, the sync client (DOCUMENT_MODEL section 6), the auth client (Better Auth over HTTP + the
// native PKCE flow, keychain storage), the offline cache and the page presets generated from @desyn/schema.
// Foundation-only (no UIKit), so `swift test --package-path apps/ios/Packages/DesynKit` runs on macOS.
import PackageDescription

let package = Package(
    name: "DesynKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "DesynKit", targets: ["DesynKit"]),
    ],
    dependencies: [
        // The official Convex Swift client (pinned; check https://github.com/get-convex/convex-swift/tags).
        .package(url: "https://github.com/get-convex/convex-swift", exact: "0.8.1"),
    ],
    targets: [
        .target(
            name: "DesynKit",
            dependencies: [.product(name: "ConvexMobile", package: "convex-swift")],
            path: "Sources/DesynKit"
        ),
        .testTarget(
            name: "DesynKitTests",
            dependencies: ["DesynKit"],
            path: "Tests/DesynKitTests"
        ),
    ],
    swiftLanguageModes: [.v5]
)
