#!/usr/bin/env bash
# Compiles and tests SharedKit + AppGroupKit (the Foundation-only code of the iOS editor features and extensions)
# on Linux, in Docker, together with DesynKit (minus its Apple-only files) and the convex-swift / CryptoKit shims of
# apps/ios/scripts/linux-shims. No Mac needed; Xcode builds and tests everything else (PanelKit and the feature
# modules are SwiftUI / UIKit).
#
#   apps/ios/Extensions/SharedKit/scripts/linux-test.sh
#   SWIFT_IMAGE=swift:6.2-noble apps/ios/Extensions/SharedKit/scripts/linux-test.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
shared="$(cd "${here}/.." && pwd)"
ios="$(cd "${shared}/../.." && pwd)"
image="${SWIFT_IMAGE:-swift:6.2-noble}"
work="$(mktemp -d "${TMPDIR:-/tmp}/desyn-sharedkit-linux.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

kit="${ios}/Packages/DesynKit"
apple_only=(
  "Auth/KeychainSessionStore.swift"
  "Backend/ConvexTransportClient.swift"
)

mkdir -p "${work}/Sources/DesynKit" "${work}/Tests"
cp -R "${ios}/scripts/linux-shims/ConvexMobile" "${work}/Sources/ConvexMobile"
cp -R "${ios}/scripts/linux-shims/CryptoKit" "${work}/Sources/CryptoKit"
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
cp -R "${shared}/Sources/AppGroupKit" "${work}/Sources/AppGroupKit"
cp -R "${shared}/Sources/SharedKit" "${work}/Sources/SharedKit"
cp -R "${shared}/Tests/SharedKitTests" "${work}/Tests/SharedKitTests"

cat > "${work}/Package.swift" <<'SWIFT'
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SharedKitLinuxCheck",
    targets: [
        .target(name: "ConvexMobile", path: "Sources/ConvexMobile"),
        .target(name: "CryptoKit", path: "Sources/CryptoKit"),
        .target(name: "DesynKit", dependencies: ["ConvexMobile", "CryptoKit"], path: "Sources/DesynKit"),
        .target(name: "AppGroupKit", path: "Sources/AppGroupKit"),
        .target(name: "SharedKit", dependencies: ["AppGroupKit", "DesynKit"], path: "Sources/SharedKit"),
        .testTarget(name: "SharedKitTests", dependencies: ["SharedKit", "AppGroupKit", "DesynKit"], path: "Tests/SharedKitTests"),
    ],
    swiftLanguageModes: [.v5]
)
SWIFT

docker run --rm \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  --cpus "${SWIFT_CPUS:-6}" \
  -v "${work}:/work" -w /work \
  "${image}" \
  bash -c 'swift build --build-tests -j "${SWIFT_JOBS:-6}" && swift test --skip-build'
