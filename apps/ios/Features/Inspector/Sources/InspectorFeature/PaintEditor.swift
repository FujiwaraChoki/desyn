import DesignSystem
import DesynKit
import PanelKit
import SharedKit
import SwiftUI

/// Edits the paint layers of the selection (fills, text color, page background, line color): solid colors with
/// the sun picker, linear and radial gradients with draggable stops, per-layer opacity, add / remove layers.
struct PaintEditor: View {
    let model: InspectorModel

    @State private var layer = 0
    @State private var stop = 0
    @State private var documentColors: [(name: String, hex: String)] = []

    private enum Kind: String, CaseIterable {
        case solid, linear, radial

        var title: String { rawValue.capitalized }
    }

    private var node: Node? { model.first }
    private var slot: NodeEditing.PaintSlot? { node.flatMap(NodeEditing.paintSlot(for:)) }
    private var paints: [Fill] { node.map(NodeEditing.paints(of:)) ?? [] }
    private var current: Fill? { paints.indices.contains(layer) ? paints[layer] : paints.first }

    private var kind: Kind {
        switch current?.type ?? "solid" {
        case "linear": .linear
        case "radial", "conic": .radial
        default: .solid
        }
    }

    var body: some View {
        if let slot {
            PanelSection(slot == .background ? "Background" : slot == .lineStroke ? "Color" : "Fill", trailing: { layerControls }) {
                if paints.count > 1 {
                    layerChips
                }
                if slot != .lineStroke, current?.type != "image" {
                    DSSegmentedControl(selection: Binding(get: { kind }, set: { setKind($0) }), options: Kind.allCases.map { ($0, $0.title) })
                }
                if current?.type == "image" {
                    InlineNotice("This layer is an image fill. Replace it with a color or gradient above, or change the image from the canvas.")
                } else if kind == .solid {
                    SunColorPicker(hex: current?.swatchHex ?? "#d9d9d9", documentColors: documentColors) { hex, final in
                        setSolid(hex, final: final)
                    }
                } else {
                    gradientEditor
                }
                if current != nil {
                    DSSlider("Layer opacity", value: Binding(get: { current?.opacity ?? 1 }, set: { setOpacity($0, final: false) }), in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                        if !editing { setOpacity(current?.opacity ?? 1, final: true) }
                    }
                }
            }
            .task(id: model.first?.id) {
                layer = 0
                stop = 0
                documentColors = await model.documentColors()
            }
        }
    }

    // MARK: Layers

    @ViewBuilder private var layerControls: some View {
        if slot == .fills || slot == .background {
            HStack(spacing: 2) {
                if !paints.isEmpty {
                    Button {
                        removeLayer()
                    } label: {
                        Image(systemName: "minus").frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Remove fill")
                }
                Button {
                    addLayer()
                } label: {
                    Image(systemName: "plus").frame(width: 36, height: 36)
                }
                .accessibilityLabel("Add fill")
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Palette.sun)
            .buttonStyle(PressScaleStyle())
        }
    }

    private var layerChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.sm) {
                // Top layer first, like a layers list.
                ForEach(Array(paints.indices.reversed()), id: \.self) { index in
                    ChipButton("Fill \(index + 1)", systemImage: paints[index].visible ? "circle.fill" : "circle.dashed", isSelected: index == layer) {
                        layer = index
                        stop = 0
                    }
                }
            }
        }
    }

    private func addLayer() {
        let top = Fill.solid(.hex("#ffb02e"), opacity: paints.isEmpty ? nil : 0.5)
        model.edit("Add fill", final: true) { nodes in
            nodes.flatMap { NodeEditing.setPaints(NodeEditing.paints(of: $0) + [top], on: $0) }
        }
        layer = paints.count
    }

    private func removeLayer() {
        let index = layer
        model.edit("Remove fill", final: true) { nodes in
            nodes.flatMap { node -> [Op] in
                var fills = NodeEditing.paints(of: node)
                guard fills.indices.contains(index) else { return [] }
                fills.remove(at: index)
                return NodeEditing.setPaints(fills, on: node)
            }
        }
        layer = max(0, index - 1)
    }

    // MARK: Edits

    private func replaceLayer(_ fill: Fill, label: String, final: Bool) {
        let index = layer
        model.edit(label, final: final) { nodes in
            nodes.flatMap { node -> [Op] in
                var fills = NodeEditing.paints(of: node)
                if fills.indices.contains(index) { fills[index] = fill } else { fills.append(fill) }
                return NodeEditing.setPaints(fills, on: node)
            }
        }
    }

    private func setSolid(_ hex: String, final: Bool) {
        if layer == 0 {
            model.edit("Change color", final: final) { NodeEditing.setSolidColor(hex, on: $0) }
        } else {
            var fill = Fill.solid(.hex(hex))
            fill.opacity = current?.opacity ?? 1
            replaceLayer(fill, label: "Change color", final: final)
        }
    }

    private func setOpacity(_ value: Double, final: Bool) {
        guard var fill = current else { return }
        fill.opacity = min(1, max(0, value))
        replaceLayer(fill, label: "Change fill opacity", final: final)
    }

    private func setKind(_ kind: Kind) {
        let base = current?.swatchHex.map { String($0.prefix(7)) } ?? "#ffb02e"
        let end = RGBA(hex: base).map { $0.luminance > 0.5 ? "#c4451c" : "#ffd66b" } ?? "#ff6a1f"
        var fill: Fill
        switch kind {
        case .solid:
            fill = Fill.solid(.hex(base))
        case .linear:
            fill = NodeEditing.linearGradient(angle: 135, stops: startingStops(base: base, end: end))
        case .radial:
            fill = NodeEditing.radialGradient(stops: startingStops(base: base, end: end))
        }
        fill.opacity = current?.opacity ?? 1
        stop = 0
        replaceLayer(fill, label: "Change fill type", final: true)
    }

    // MARK: Gradients

    /// The current stops, or two stops from the current color to a warm partner.
    private func startingStops(base: String, end: String) -> [(pos: Double, hex: String)] {
        let existing = gradientStops
        return existing.count >= 2 ? existing : [(pos: 0, hex: base), (pos: 1, hex: end)]
    }

    private var gradientStops: [(pos: Double, hex: String)] {
        current.map(NodeEditing.stops(of:)) ?? []
    }

    private var gradientEditor: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            GradientStopsBar(stops: gradientStops, selected: stop) { index in
                stop = index
            } onMove: { index, pos, final in
                var stops = gradientStops
                guard stops.indices.contains(index) else { return }
                stops[index].pos = pos
                writeStops(stops, label: "Move gradient stop", final: final)
            } onAdd: { pos in
                var stops = gradientStops
                let color = interpolated(at: pos, in: stops)
                stops.append((pos, color))
                stops.sort { $0.pos < $1.pos }
                stop = stops.firstIndex { $0.pos == pos } ?? 0
                writeStops(stops, label: "Add gradient stop", final: true)
            }
            HStack(spacing: Spacing.sm) {
                if kind == .linear {
                    ScrubField("Angle", value: current?.number("angle") ?? 0, in: -360...360, step: 1, unit: "°") { value, final in
                        guard var fill = current else { return }
                        fill.set("angle", .number(value))
                        replaceLayer(fill, label: "Rotate gradient", final: final)
                    }
                }
                if gradientStops.count > 2 {
                    DSButton("Remove stop", systemImage: "minus.circle", kind: .secondary, size: .small) {
                        var stops = gradientStops
                        guard stops.indices.contains(stop) else { return }
                        stops.remove(at: stop)
                        stop = max(0, stop - 1)
                        writeStops(stops, label: "Remove gradient stop", final: true)
                    }
                }
            }
            if gradientStops.indices.contains(stop) {
                SunColorPicker(hex: gradientStops[stop].hex, documentColors: documentColors) { hex, final in
                    var stops = gradientStops
                    guard stops.indices.contains(stop) else { return }
                    stops[stop].hex = hex
                    writeStops(stops, label: "Change gradient color", final: final)
                }
                .id(stop)
            }
        }
    }

    private func writeStops(_ stops: [(pos: Double, hex: String)], label: String, final: Bool) {
        guard var fill = current else { return }
        fill.set("stops", .array(stops.map { GradientStop(pos: min(1, max(0, $0.pos)), color: .hex($0.hex)).jsonValue }))
        replaceLayer(fill, label: label, final: final)
    }

    private func interpolated(at pos: Double, in stops: [(pos: Double, hex: String)]) -> String {
        let sorted = stops.sorted { $0.pos < $1.pos }
        guard let lower = sorted.last(where: { $0.pos <= pos }) ?? sorted.first,
              let upper = sorted.first(where: { $0.pos >= pos }) ?? sorted.last,
              let a = RGBA(hex: lower.hex), let b = RGBA(hex: upper.hex)
        else { return "#ffb02e" }
        let span = upper.pos - lower.pos
        return a.mixed(with: b, span > 0 ? (pos - lower.pos) / span : 0).hex
    }
}

/// The gradient preview with its stops: tap a stop to select it, drag to move, tap the bar to add one.
private struct GradientStopsBar: View {
    let stops: [(pos: Double, hex: String)]
    let selected: Int
    let onSelect: (Int) -> Void
    let onMove: (Int, Double, Bool) -> Void
    let onAdd: (Double) -> Void

    var body: some View {
        GeometryReader { proxy in
            let width = max(1, proxy.size.width)
            ZStack(alignment: .leading) {
                LinearGradient(stops: stops.map { Gradient.Stop(color: Color(hex: $0.hex), location: CGFloat($0.pos)) }, startPoint: .leading, endPoint: .trailing)
                    .background(CheckerboardView())
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
                    .frame(height: 28)
                    .contentShape(Rectangle())
                    .onTapGesture { location in
                        onAdd(min(1, max(0, Double(location.x / width))))
                    }
                ForEach(Array(stops.enumerated()), id: \.offset) { index, stop in
                    StopHandle(hex: stop.hex, selected: index == selected)
                        .position(x: CGFloat(stop.pos) * width, y: 14)
                        .gesture(
                            DragGesture(minimumDistance: 0)
                                .onChanged { drag in
                                    onSelect(index)
                                    onMove(index, min(1, max(0, Double(drag.location.x / width))), false)
                                }
                                .onEnded { drag in
                                    onMove(index, min(1, max(0, Double(drag.location.x / width))), true)
                                }
                        )
                        .accessibilityElement()
                        .accessibilityLabel("Stop \(index + 1), \(Int(stop.pos * 100)) percent")
                        .accessibilityAddTraits(index == selected ? .isSelected : [])
                        .accessibilityAction { onSelect(index) }
                }
            }
        }
        .frame(height: Spacing.touchTarget)
    }
}

private struct StopHandle: View {
    let hex: String
    let selected: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Color(hex: hex))
            .frame(width: 22, height: 36)
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(selected ? Palette.sun : .white, lineWidth: selected ? 3 : 2))
            .shadow(color: selected ? Palette.sun.opacity(0.5) : .black.opacity(0.3), radius: selected ? 8 : 2)
            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
            .contentShape(Rectangle())
    }
}
