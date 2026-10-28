#!/usr/bin/env bash
# Compiles and tests the platform-neutral Swift of the iOS app on Linux, in Docker (no Mac needed):
#   - DesynKit: models, JSON parser, ops, text runs, ink geometry, presets, sync session, offline store, auth
#     client, PKCE, auth provider, API facade, asset repository / uploader (all but the Keychain store and the
#     Combine-based convex-swift transport, which need Apple frameworks);
#   - FeatureCore's Foundation-only files (deep links, formatting, routes);
#   - their XCTest suites (Packages/DesynKit/Tests, Tests/DesynTests/FeatureCoreTests.swift).
# convex-swift and CryptoKit are replaced by the small shims in scripts/linux-shims (never shipped).
#
# With --engine it also links the real Rust engine and runs the engine-backed suites of the Xcode test bundle
# (Tests/DesynTests/EngineContractTests.swift, EngineSyncTests.swift): the DesynEngine package sources (minus the
# CoreGraphics image and Metal files), the editor's EngineDocument and SyncSession against desyn-ffi. It reuses
# the engine's Linux harness, so build that first (static library, C header and Apple shims):
#   scripts/build-ios-engine.sh --swift-linux
#
#   apps/ios/scripts/linux-check.sh            # swift build + swift test
#   apps/ios/scripts/linux-check.sh --engine   # + the engine-backed suites
#   SWIFT_IMAGE=swift:6.2-noble apps/ios/scripts/linux-check.sh
#
# The Xcode build on macOS (README.md) compiles and tests everything, including the UIKit / SwiftUI modules.
set -euo pipefail

engine=0
for arg in "$@"; do
  case "${arg}" in
    --engine) engine=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg} (see --help)" >&2
      exit 2
      ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd)"
ios="$(cd "${here}/.." && pwd)"
repo="$(cd "${ios}/../.." && pwd)"
image="${SWIFT_IMAGE:-swift:6.2-noble}"
work="$(mktemp -d "${TMPDIR:-/tmp}/desyn-ios-linux.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

kit="${ios}/Packages/DesynKit"
core="${ios}/Packages/Features/Sources/FeatureCore"
editor="${ios}/Packages/Features/Sources/EditorFeature"
engine_pkg="${ios}/DesynEngine"
ffi_harness="${DESYN_FFI_HARNESS:-${repo}/target/desyn-ffi/swift-linux}"

# Files that need Apple-only frameworks (Security, Combine with convex-swift's client).
apple_only=(
  "Auth/KeychainSessionStore.swift"
  "Backend/ConvexTransportClient.swift"
)

mkdir -p "${work}/Sources/DesynKit" "${work}/Sources/FeatureCore" "${work}/Tests/DesynKitTests" "${work}/Tests/FeatureCoreTests"
cp -R "${here}/linux-shims/ConvexMobile" "${work}/Sources/ConvexMobile"
cp -R "${here}/linux-shims/CryptoKit" "${work}/Sources/CryptoKit"

while IFS= read -r -d '' file; do
  relative="${file#"${kit}/Sources/DesynKit/"}"
  skip=0
  for excluded in "${apple_only[@]}"; do
    if [ "${relative}" = "${excluded}" ]; then skip=1; fi
  done
  if [ "${skip}" = 1 ]; then continue; fi
  mkdir -p "${work}/Sources/DesynKit/$(dirname "${relative}")"
  cp "${file}" "${work}/Sources/DesynKit/${relative}"
done < <(find "${kit}/Sources/DesynKit" -name '*.swift' -print0)

for file in DeepLink.swift Formatting.swift DesignRoute.swift; do
  cp "${core}/${file}" "${work}/Sources/FeatureCore/${file}"
done
cp "${kit}"/Tests/DesynKitTests/*.swift "${work}/Tests/DesynKitTests/"
cp "${ios}/Tests/DesynTests/FeatureCoreTests.swift" "${work}/Tests/FeatureCoreTests/"

engine_targets=""
docker_mounts=()
if [ "${engine}" = 1 ]; then
  header="${ffi_harness}/Sources/DesynFFIC/DesynFFIC.h"
  library="${ffi_harness}/lib/libdesyn_ffi.a"
  if [ ! -f "${header}" ] || [ ! -f "${library}" ]; then
    echo "--engine needs the engine's Linux harness (${ffi_harness}): run scripts/build-ios-engine.sh --swift-linux" >&2
    exit 1
  fi
  mkdir -p "${work}/Sources/DesynFFIC" "${work}/Sources/DesynFFI" "${work}/Sources/CoreGraphics" \
    "${work}/Sources/DesynEngine" "${work}/Sources/EditorFeature" "${work}/Tests/EngineTests"
  cp "${header}" "${work}/Sources/DesynFFIC/"
  printf 'module DesynFFIC {\n    header "DesynFFIC.h"\n    link "desyn_ffi"\n    export *\n}\n' \
    >"${work}/Sources/DesynFFIC/module.modulemap"
  # The committed wrapper must match the library (UniFFI checks API checksums when the engine starts).
  cp "${engine_pkg}/Sources/DesynFFI/DesynFFI.swift" "${work}/Sources/DesynFFI/"
  cp "${engine_pkg}/LinuxHarness/AppleShims.swift" "${work}/Sources/CoreGraphics/"
  for f in "${engine_pkg}"/Sources/DesynEngine/*.swift; do
    case "$(basename "${f}")" in
      FrameImage.swift | MetalFrameTexture.swift) continue ;;
    esac
    { echo "import CoreGraphics // Linux harness"; cat "${f}"; } >"${work}/Sources/DesynEngine/$(basename "${f}")"
  done
  cp "${editor}/EngineDocument.swift" "${work}/Sources/EditorFeature/"
  cp "${ios}/Tests/DesynTests/EngineContractTests.swift" "${ios}/Tests/DesynTests/EngineSyncTests.swift" \
    "${work}/Tests/EngineTests/"
  # The scripted backend and memory applier the engine suites share with DesynKit's tests (one bundle in Xcode).
  cp "${kit}/Tests/DesynKitTests/SyncSessionTests.swift" "${work}/Tests/EngineTests/"
  docker_mounts=(-v "$(dirname "${library}"):/ffi-lib:ro")
  engine_targets='
        .systemLibrary(name: "DesynFFIC", path: "Sources/DesynFFIC"),
        .target(
            name: "DesynFFI",
            dependencies: ["DesynFFIC"],
            path: "Sources/DesynFFI",
            linkerSettings: [.unsafeFlags(["-L/ffi-lib", "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl"])]
        ),
        .target(name: "CoreGraphics", path: "Sources/CoreGraphics"),
        .target(name: "DesynEngine", dependencies: ["DesynFFI", "CoreGraphics"], path: "Sources/DesynEngine"),
        .target(name: "EditorFeature", dependencies: ["DesynEngine", "DesynKit"], path: "Sources/EditorFeature"),
        .testTarget(name: "EngineTests", dependencies: ["EditorFeature", "DesynEngine", "DesynKit"], path: "Tests/EngineTests"),'
fi

cat > "${work}/Package.swift" <<SWIFT
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DesynLinuxCheck",
    targets: [
        .target(name: "ConvexMobile", path: "Sources/ConvexMobile"),
        .target(name: "CryptoKit", path: "Sources/CryptoKit"),
        .target(name: "DesynKit", dependencies: ["ConvexMobile", "CryptoKit"], path: "Sources/DesynKit"),
        .target(name: "FeatureCore", dependencies: ["DesynKit"], path: "Sources/FeatureCore"),
        .testTarget(name: "DesynKitTests", dependencies: ["DesynKit"], path: "Tests/DesynKitTests"),
        .testTarget(name: "FeatureCoreTests", dependencies: ["FeatureCore"], path: "Tests/FeatureCoreTests"),${engine_targets}
    ],
    swiftLanguageModes: [.v5]
)
SWIFT

docker run --rm \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --cpus "${SWIFT_CPUS:-6}" \
  -v "${work}:/work" -w /work \
  ${docker_mounts[@]+"${docker_mounts[@]}"} \
  "${image}" \
  bash -c 'swift build --build-tests -j "${SWIFT_JOBS:-6}" && swift test --skip-build'
