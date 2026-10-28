# DesynEngine (Swift package)

The Desyn Rust engine (`crates/desyn-ffi`) for the iOS app: one engine renders, edits, hit-tests, lays out text,
describes and exports designs exactly like the web and desktop apps.

| target | what |
|---|---|
| `DesynFFIC` | binary target: `Frameworks/DesynFFIC.xcframework` (static library + `DesynFFIC.h`), built by `scripts/build-ios-engine.sh`, not committed |
| `DesynFFI` | the UniFFI-generated Swift wrapper (`Sources/DesynFFI/DesynFFI.swift`, committed, never edited by hand) |
| `DesynEngine` | the `DesynEngine` actor, `FrameBuffer`, `RenderedFrame.makeCGImage()`, `MetalFrameTexture`, CoreGraphics conversions, `Viewport` math, `DesynTransaction` |

`import DesynEngine` re-exports `DesynFFI`, so the records (`RenderRequest`, `Viewport`, `DesignPoint`,
`DesignRect`, `OrientedBox`, `ExportRequest`, ...) and the raw `Engine` class are available too.

## Build

On a Mac with Xcode, from the repository root:

```sh
rustup target add aarch64-apple-ios aarch64-apple-ios-sim        # once (x86_64-apple-ios optional)
scripts/build-ios-engine.sh                                      # release; --debug for faster iteration
swift test --package-path apps/ios/DesynEngine                   # package tests on the macOS slice
```

The script builds static libraries for device, simulator and macOS, generates the Swift bindings and writes
`Frameworks/DesynFFIC.xcframework`. The app adds this directory as a local package (`path: DesynEngine` in
`apps/ios/project.yml`) and links the `DesynEngine` product. `scripts/build-ios-engine.sh --check` (any OS) fails
when the committed Swift wrapper no longer matches the Rust API; `--bindings-only` regenerates it.

## Use

```swift
import DesynEngine

let engine = DesynEngine()                                   // bundled fonts; one engine per open design
let loaded = try await engine.load(designJSON: json)         // `designs.load` assembled with designs_wire
if loaded.layoutOpsJson != "[]" {                            // derived boxes recomputed with real fonts (already
    let tx = try DesynTransaction.json(opsJSON: loaded.layoutOpsJson, label: "Layout", source: .system)
    // applied locally): commit `tx` through designs.commit so other clients converge
}

// Render: a Viewport is the visible page region in device pixels.
var viewport = Viewport.fitting(pageWidth: page.width, pageHeight: page.height, in: bounds.size, scale: screenScale)
let frame = try await engine.render(RenderRequest(viewport: viewport, background: "#0b0b0f"))
layer.contents = frame.makeCGImage()
for id in frame.info.missingAssets { /* fetch bytes, then */ await engine.setAsset(id, data: bytes) }

// Edit: apply locally with layout, commit `applied` (normal form incl. derived geometry), keep the inverse for undo.
let (outcome, tx) = try await engine.apply(opsJSON: #"[{"op":"update","id":"…","set":{"opacity":0.5}}]"#, label: "Fade")
// designs.commit({ designId, baseSeq, tx }) with the ops of outcome.appliedJson; undo = outcome.inverseJson

// Gestures (page coordinates = viewport.pagePoint(fromView:)).
let hit = try await engine.hitTest(viewport.pagePoint(fromView: touch))
let start = try await engine.selectionBounds(selection)!.obb
let resized = resizeBox(bounds: start, handle: .bottomRight, pointer: pagePoint, options: ResizeOptions())
let ops = try await engine.transformOps(for: selection, from: start, to: resized.bounds,
                                        flipX: resized.flipX, flipY: resized.flipY)
try await engine.preview(opsJSON: ops, label: "Resize")       // every pointer move: replaces the last step
let committed = await engine.commitPreview()                   // pointer-up (or `cancelPreview()`)
// designs.commit with committed.appliedJson; undo = committed.inverseJson
```

Live gestures never commit per frame (DOCUMENT_MODEL section 6): `transformOps` is computed against the committed
state, `preview` shows each step on top of it, remote transactions applied meanwhile go under the preview, and
`commitPreview()` / `cancelPreview()` end the gesture. Snapping ignores the preview.

### Threading

`DesynEngine` is an actor with a custom executor: every call runs on its own serial dispatch queue (QoS user
initiated), never on the main thread and never on the Swift cooperative pool, because renders, exports and
describe calls block for milliseconds to seconds. Call it with `await` from the main actor. The Rust object itself
is thread-safe (`Send + Sync`, one internal lock); `engine.core` can be called synchronously from a dedicated
render thread (for example a `CADisplayLink` on a background run loop) and is serialized with the actor's calls.

### Pixels: CGImage and Metal

Frames are **premultiplied RGBA8** (bytes R, G, B, A; sRGB encoded).

* `RenderedFrame.makeCGImage()` wraps the returned pixels without conversion
  (`premultipliedLast | byteOrder32Big`, sRGB).
* Zero-copy path: allocate a `FrameBuffer(width:height:)` (64-byte aligned rows) or wrap memory you own
  (`FrameBuffer(wrapping: mtlBuffer.contents(), width:, height:, bytesPerRow:, release: { _ = mtlBuffer })`),
  then `try await engine.render(request, into: buffer)`. The engine copies only the damaged rectangles when the
  buffer shows the previous frame (tracked with `FrameInfo.sequence`), the whole frame otherwise; double / triple
  buffering stays correct.
* `MetalFrameTexture(device:)` keeps an `.rgba8Unorm` texture in sync: `update(with: frame)` /
  `update(with: buffer)` uploads only the damage when the texture holds the previous frame. Draw it with
  premultiplied blending (`sourceRGBBlendFactor = .one`, `destinationRGBBlendFactor = .oneMinusSourceAlpha`) into
  a non-sRGB drawable so the encoded values pass through unchanged.

### Text editing

`textLayout(id)` returns lines, the box size and `transform` (box-local to page). Caret and selection geometry are
box-local (`caret(in:at:)`, `selectionRects(in:range:)`); offsets are **UTF-16** (`NSString` / `UITextInput`), so
`TextPosition.index` maps directly to `UITextPosition` offsets. Hide the node under the native editor with
`RenderRequest(viewport: viewport, hidden: [id])` while it is being edited.

### Naming

The actor has the module's name (`DesynEngine`). Refer to the package's types unqualified (`Viewport`,
`RenderRequest`); a qualified `DesynEngine.Viewport` resolves to the actor, not the module.

## Verify

`Tests/DesynEngineTests` (Swift Testing) loads a design, renders, checks pixels and `CGImage`, renders into a
`FrameBuffer`, applies and undoes transactions, hit-tests, previews and commits a resize gesture (`transformOps`), converts text to outlines, snaps, walks UTF-16
caret positions, describes, exports PNG / PDF and uploads frames to Metal. They need the XCFramework, so they run
on macOS (`swift test`, CI `ios.yml`). The Rust side has its own offline tests (`crates/desyn-ffi`).
