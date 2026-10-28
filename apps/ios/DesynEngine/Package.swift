// swift-tools-version: 6.0
//
// DesynEngine: the Rust engine (crates/desyn-ffi) for the iOS app.
//
// Build the binary first (macOS + Xcode): `scripts/build-ios-engine.sh` from the repository root. It writes
// Frameworks/DesynFFIC.xcframework (static library + C header) and regenerates Sources/DesynFFI/DesynFFI.swift.
import PackageDescription

let package = Package(
    name: "DesynEngine",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "DesynEngine", targets: ["DesynEngine"]),
    ],
    targets: [
        // C declarations of the Rust library (module `DesynFFIC`), built by scripts/build-ios-engine.sh.
        .binaryTarget(name: "DesynFFIC", path: "Frameworks/DesynFFIC.xcframework"),
        // UniFFI-generated Swift wrapper (do not edit; regenerate with the script).
        .target(
            name: "DesynFFI",
            dependencies: ["DesynFFIC"],
            path: "Sources/DesynFFI",
            swiftSettings: [.swiftLanguageMode(.v5)],
            // Rust's standard library on Apple platforms links libiconv (rustc --print native-static-libs).
            linkerSettings: [.linkedLibrary("iconv")]
        ),
        // Swift-friendly layer: the DesynEngine actor, CGImage and Metal helpers, CoreGraphics conversions.
        .target(
            name: "DesynEngine",
            dependencies: ["DesynFFI"],
            path: "Sources/DesynEngine",
            linkerSettings: [.linkedFramework("Metal"), .linkedFramework("CoreGraphics")]
        ),
        .testTarget(
            name: "DesynEngineTests",
            dependencies: ["DesynEngine"],
            path: "Tests/DesynEngineTests"
        ),
    ]
)
