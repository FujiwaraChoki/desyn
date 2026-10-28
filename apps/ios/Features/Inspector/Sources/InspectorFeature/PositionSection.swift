import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Position: X, Y, width, height (page coordinates of the selection's box), rotation, aspect lock and resize
/// constraints. Values come from the engine's selection box; edits go through the engine's transform so groups,
/// rotated layers and text resize exactly like on the canvas.
struct PositionSection: View {
    let model: InspectorModel

    /// The committed box when an edit starts (the engine computes transforms against the committed state).
    @State private var baseline: SelectionBounds?
    @State private var live: SelectionBounds?
    @State private var editing = false

    private var editor: EditorModel { model.editor }
    private var ids: [String] { editor.topLevelSelectionIds }
    private var aspectLocked: Bool { model.targets.allSatisfy { $0.bool("aspectLocked") == true } }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PanelSection("Position and size", trailing: {
                Button {
                    let lock = !aspectLocked
                    model.edit(lock ? "Lock aspect ratio" : "Unlock aspect ratio", final: true) { NodeEditing.setFlag("aspectLocked", lock, on: $0) }
                } label: {
                    Image(systemName: aspectLocked ? "lock.fill" : "lock.open")
                        .foregroundStyle(aspectLocked ? Palette.sun : Palette.muted)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel(aspectLocked ? "Aspect ratio locked" : "Aspect ratio unlocked")
            }) {
                if let box = live {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.sm) {
                        ScrubField("X", value: box.aabb.x, in: -100_000...100_000, unit: "px") { value, final in
                            transform("Move", final: final) { from in from.offsetBy(dx: value - (baseline?.aabb.x ?? box.aabb.x), dy: 0) }
                        }
                        ScrubField("Y", value: box.aabb.y, in: -100_000...100_000, unit: "px") { value, final in
                            transform("Move", final: final) { from in from.offsetBy(dx: 0, dy: value - (baseline?.aabb.y ?? box.aabb.y)) }
                        }
                        ScrubField("W", value: box.obb.width, in: 1...100_000, unit: "px") { value, final in
                            transform("Resize", final: final) { from in
                                let ratio = from.width > 0 ? from.height / from.width : 1
                                return OrientedBox(transform: from.transform, width: value, height: aspectLocked ? value * ratio : from.height)
                            }
                        }
                        ScrubField("H", value: box.obb.height, in: 1...100_000, unit: "px") { value, final in
                            transform("Resize", final: final) { from in
                                let ratio = from.height > 0 ? from.width / from.height : 1
                                return OrientedBox(transform: from.transform, width: aspectLocked ? value * ratio : from.width, height: value)
                            }
                        }
                    }
                    ScrubField("Rotation", value: box.rotation, in: -360...360, unit: "°") { value, final in
                        transform("Rotate", final: final) { from in
                            CanvasGeometry.rotate(from, degrees: value - (baseline?.rotation ?? box.rotation), around: from.center)
                        }
                    }
                } else {
                    SunSpinner(size: 22)
                }
            }
            if model.targets.allSatisfy({ ($0.parent.flatMap(editor.lookupNode)?.type ?? .page) == .frame }) {
                constraints
            }
        }
        .task(id: TaskKey(ids: ids, revision: editor.revision)) {
            guard !editing else { return }
            let bounds = try? await editor.designEngine.selectionBounds(ids)
            live = bounds
            baseline = bounds
        }
    }

    private struct TaskKey: Equatable {
        let ids: [String]
        let revision: UInt64
    }

    /// Previews the transform while scrubbing; commits it when the value settles.
    private func transform(_ label: String, final: Bool, _ target: @escaping (OrientedBox) -> OrientedBox) {
        guard let from = baseline?.obb else { return }
        let ids = self.ids
        let to = target(from)
        editing = !final
        Task {
            guard let json = try? await editor.designEngine.transformOps(for: ids, from: from, to: to) else { return }
            if final {
                await model.commit(label, opsJSON: json)
                let bounds = try? await editor.designEngine.selectionBounds(ids)
                baseline = bounds
                live = bounds
            } else {
                await editor.applyPreview(opsJSON: json)
                live = try? await editor.designEngine.selectionBounds(ids)
            }
        }
    }

    private var constraints: some View {
        let current = model.first?.object("constraints") ?? [:]
        let h = current["h"]?.stringValue ?? "left"
        let v = current["v"]?.stringValue ?? "top"
        return PanelSection("When the frame resizes") {
            constraintMenu("Horizontal", value: h, options: ["left", "right", "center", "stretch", "scale"]) { value in
                model.edit("Change constraints", final: true) { NodeEditing.setConstraints(h: value, v: nil, on: $0) }
            }
            constraintMenu("Vertical", value: v, options: ["top", "bottom", "center", "stretch", "scale"]) { value in
                model.edit("Change constraints", final: true) { NodeEditing.setConstraints(h: nil, v: value, on: $0) }
            }
        }
    }

    private func constraintMenu(_ title: String, value: String, options: [String], onSelect: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button {
                    onSelect(option)
                } label: {
                    if option == value { Label(option.capitalized, systemImage: "checkmark") } else { Text(option.capitalized) }
                }
            }
        } label: {
            HStack {
                Text(title).font(.dsSubheadline).foregroundStyle(Palette.muted)
                Spacer()
                Text(value.capitalized).font(.dsCallout).foregroundStyle(Palette.foreground)
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Spacing.md)
            .frame(minHeight: Spacing.touchTarget)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        }
    }
}
