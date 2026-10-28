#!/usr/bin/env bash
# Builds the Desyn engine for iOS: crates/desyn-ffi as static libraries for device and simulator, the UniFFI
# Swift bindings, and apps/ios/DesynEngine/Frameworks/DesynFFIC.xcframework for the DesynEngine Swift package.
#
# Usage (repository root or anywhere inside it):
#   scripts/build-ios-engine.sh                  # macOS + Xcode: full build (release)
#   scripts/build-ios-engine.sh --debug          # unoptimized libraries (faster local iteration)
#   scripts/build-ios-engine.sh --bindings-only  # any OS: regenerate Sources/DesynFFI/DesynFFI.swift only
#   scripts/build-ios-engine.sh --check          # any OS: fail when the committed Swift bindings are stale
#   scripts/build-ios-engine.sh --swift-linux    # Linux: compile the Swift package (minus CoreGraphics / Metal) and
#                                                # run its tests against the Linux build (swift in PATH or Docker)
#
# Requirements for the full build: macOS with Xcode (xcodebuild, lipo), rustup targets aarch64-apple-ios and
# aarch64-apple-ios-sim (x86_64-apple-ios joins the simulator slice when installed). A macOS slice
# (aarch64-apple-darwin, plus x86_64-apple-darwin when installed) lets `swift test` run the package on the Mac.
# Deployment targets: IPHONEOS_DEPLOYMENT_TARGET (default 18.0), MACOSX_DEPLOYMENT_TARGET (default 15.0). Outputs:
#   apps/ios/DesynEngine/Frameworks/DesynFFIC.xcframework   (static library + DesynFFIC.h + module map)
#   apps/ios/DesynEngine/Sources/DesynFFI/DesynFFI.swift     (generated wrapper, committed)
set -euo pipefail

mode=full
profile=release
for arg in "$@"; do
  case "${arg}" in
    --bindings-only) mode=bindings ;;
    --check) mode=check ;;
    --swift-linux) mode=swift-linux ;;
    --debug) profile=debug ;;
    -h | --help)
      # The header comment (every line after the shebang up to the first non-comment line).
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: ${arg} (see --help)" >&2
      exit 2
      ;;
  esac
done

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"
package="${root}/apps/ios/DesynEngine"
swift_out="${package}/Sources/DesynFFI"
xcframework="${package}/Frameworks/DesynFFIC.xcframework"
lib=libdesyn_ffi.a
export IPHONEOS_DEPLOYMENT_TARGET="${IPHONEOS_DEPLOYMENT_TARGET:-18.0}"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-${root}/target/desyn-ffi}"
export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-6}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

profile_flag=()
profile_dir=debug
if [ "${profile}" = release ]; then
  profile_flag=(--release)
  profile_dir=release
fi

# uniffi-bindgen of this crate (host build; reads the UniFFI metadata embedded in a compiled library).
bindgen() {
  cargo run --quiet --locked -p desyn-ffi --features bindgen-cli --bin uniffi-bindgen -- "$@"
}

# Swift wrapper + C header + module map from a compiled library, into $1.
generate_swift() {
  local library="$1" out="$2"
  mkdir -p "${out}"
  bindgen generate --library "${library}" --language swift --out-dir "${out}" --no-format
}

host_library() {
  # A host static library carries the same metadata as the iOS ones (bindings do not depend on the target).
  cargo rustc --quiet --locked -p desyn-ffi --lib --crate-type staticlib >&2
  echo "${CARGO_TARGET_DIR}/debug/${lib}"
}

case "${mode}" in
  bindings)
    generate_swift "$(host_library)" "${work}/swift"
    mkdir -p "${swift_out}"
    cp "${work}/swift/DesynFFI.swift" "${swift_out}/DesynFFI.swift"
    echo "wrote ${swift_out}/DesynFFI.swift"
    exit 0
    ;;
  check)
    generate_swift "$(host_library)" "${work}/swift"
    if ! diff -q "${work}/swift/DesynFFI.swift" "${swift_out}/DesynFFI.swift" >/dev/null; then
      echo "apps/ios/DesynEngine/Sources/DesynFFI/DesynFFI.swift is stale: run scripts/build-ios-engine.sh --bindings-only" >&2
      exit 1
    fi
    echo "Swift bindings are up to date"
    exit 0
    ;;
  swift-linux)
    # The generated wrapper, the DesynEngine actor, FrameBuffer, geometry / transaction helpers and the package
    # tests, compiled by a real Swift 6 toolchain and run against the host static library. FrameImage.swift and
    # MetalFrameTexture.swift (CoreGraphics images, Metal) are Apple-only; LinuxHarness/AppleShims.swift stands
    # in for the few Apple APIs the other files use (as a module named CoreGraphics).
    harness="${CARGO_TARGET_DIR}/swift-linux"
    library="$(host_library)"
    generate_swift "${library}" "${work}/swift"
    if ! cmp -s "${work}/swift/DesynFFI.swift" "${swift_out}/DesynFFI.swift"; then
      echo "the committed Swift bindings are stale: run scripts/build-ios-engine.sh --bindings-only" >&2
      exit 1
    fi
    rm -rf "${harness:?}/Sources" "${harness:?}/Tests" "${harness:?}/lib"
    mkdir -p "${harness}/Sources/DesynFFIC" "${harness}/Sources/DesynFFI" "${harness}/Sources/CoreGraphics" \
      "${harness}/Sources/DesynEngine" "${harness}/Tests/DesynEngineTests" "${harness}/lib"
    # Only the static library in the search path, so the test binary needs no LD_LIBRARY_PATH.
    ln -f "${library}" "${harness}/lib/${lib}" 2>/dev/null || cp "${library}" "${harness}/lib/${lib}"
    cp "${work}/swift/DesynFFIC.h" "${harness}/Sources/DesynFFIC/"
    printf 'module DesynFFIC {\n    header "DesynFFIC.h"\n    link "desyn_ffi"\n    export *\n}\n' \
      >"${harness}/Sources/DesynFFIC/module.modulemap"
    cp "${swift_out}/DesynFFI.swift" "${harness}/Sources/DesynFFI/"
    cp "${package}/LinuxHarness/AppleShims.swift" "${harness}/Sources/CoreGraphics/"
    for f in "${package}"/Sources/DesynEngine/*.swift; do
      case "$(basename "${f}")" in
        FrameImage.swift | MetalFrameTexture.swift) continue ;;
      esac
      { echo "import CoreGraphics // Linux harness"; cat "${f}"; } >"${harness}/Sources/DesynEngine/$(basename "${f}")"
    done
    cp "${package}"/Tests/DesynEngineTests/*.swift "${harness}/Tests/DesynEngineTests/"
    cat >"${harness}/Package.swift" <<MANIFEST
// swift-tools-version: 6.0
// Generated by scripts/build-ios-engine.sh --swift-linux (Linux harness of apps/ios/DesynEngine).
import PackageDescription

let package = Package(
    name: "DesynEngineLinux",
    targets: [
        .systemLibrary(name: "DesynFFIC", path: "Sources/DesynFFIC"),
        .target(
            name: "DesynFFI",
            dependencies: ["DesynFFIC"],
            path: "Sources/DesynFFI",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.unsafeFlags(["-L${harness}/lib", "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl"])]
        ),
        .target(name: "CoreGraphics", path: "Sources/CoreGraphics"),
        .target(name: "DesynEngine", dependencies: ["DesynFFI", "CoreGraphics"], path: "Sources/DesynEngine"),
        .testTarget(name: "DesynEngineTests", dependencies: ["DesynEngine"], path: "Tests/DesynEngineTests"),
    ]
)
MANIFEST
    if command -v swift >/dev/null; then
      (cd "${harness}" && swift test)
    elif command -v docker >/dev/null; then
      image="${SWIFT_IMAGE:-swift:6.2-noble}"
      echo "no swift in PATH: running the harness in ${image}"
      docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp \
        -v "${harness}:${harness}" -w "${harness}" "${image}" swift test --build-path "${harness}/.build"
    else
      echo "--swift-linux needs swift in PATH or docker" >&2
      exit 1
    fi
    exit 0
    ;;
esac

if [ "$(uname -s)" != Darwin ]; then
  echo "the XCFramework build needs macOS with Xcode; on this OS only --bindings-only and --check work" >&2
  exit 1
fi
for tool in xcodebuild lipo rustup; do
  command -v "${tool}" >/dev/null || { echo "missing ${tool}" >&2; exit 1; }
done

installed="$(rustup target list --installed)"
device_target=aarch64-apple-ios
sim_targets=(aarch64-apple-ios-sim)
for t in "${device_target}" "${sim_targets[@]}"; do
  grep -qx "${t}" <<<"${installed}" || { echo "missing rust target ${t}: rustup target add ${t}" >&2; exit 1; }
done
if grep -qx x86_64-apple-ios <<<"${installed}"; then
  sim_targets+=(x86_64-apple-ios)
fi
mac_targets=()
for t in aarch64-apple-darwin x86_64-apple-darwin; do
  if grep -qx "${t}" <<<"${installed}"; then
    mac_targets+=("${t}")
  fi
done

for t in "${device_target}" "${sim_targets[@]}" ${mac_targets[@]+"${mac_targets[@]}"}; do
  echo "building ${lib} for ${t} (${profile})"
  # Only the static library: the crate's cdylib type is for host binding generation and Kotlin.
  # ${a[@]+"${a[@]}"}: an empty array under `set -u` breaks macOS's bash 3.2 otherwise.
  cargo rustc --locked -p desyn-ffi --lib --crate-type staticlib ${profile_flag[@]+"${profile_flag[@]}"} --target "${t}"
done

device_lib="${CARGO_TARGET_DIR}/${device_target}/${profile_dir}/${lib}"
mkdir -p "${work}/sim"
sim_libs=()
for t in "${sim_targets[@]}"; do
  sim_libs+=("${CARGO_TARGET_DIR}/${t}/${profile_dir}/${lib}")
done
lipo -create "${sim_libs[@]}" -output "${work}/sim/${lib}"
mac_args=()
if [ "${#mac_targets[@]}" -gt 0 ]; then
  mkdir -p "${work}/mac"
  mac_libs=()
  for t in "${mac_targets[@]}"; do
    mac_libs+=("${CARGO_TARGET_DIR}/${t}/${profile_dir}/${lib}")
  done
  lipo -create "${mac_libs[@]}" -output "${work}/mac/${lib}"
  mac_args=(-library "${work}/mac/${lib}" -headers "${work}/headers")
fi

generate_swift "${device_lib}" "${work}/swift"
# Headers live in a DesynFFIC/ subdirectory so this module map never collides with another XCFramework's
# module.modulemap in the same build products directory (clang finds <dir>/<Module>/module.modulemap).
mkdir -p "${work}/headers/DesynFFIC"
cp "${work}/swift/DesynFFIC.h" "${work}/headers/DesynFFIC/"
cp "${work}/swift/DesynFFIC.modulemap" "${work}/headers/DesynFFIC/module.modulemap"

rm -rf "${xcframework}"
mkdir -p "$(dirname "${xcframework}")" "${swift_out}"
xcodebuild -create-xcframework \
  -library "${device_lib}" -headers "${work}/headers" \
  -library "${work}/sim/${lib}" -headers "${work}/headers" \
  ${mac_args[@]+"${mac_args[@]}"} \
  -output "${xcframework}"
cp "${work}/swift/DesynFFI.swift" "${swift_out}/DesynFFI.swift"

echo "built ${xcframework} ($(du -sh "${xcframework}" | cut -f1)) and ${swift_out}/DesynFFI.swift"
