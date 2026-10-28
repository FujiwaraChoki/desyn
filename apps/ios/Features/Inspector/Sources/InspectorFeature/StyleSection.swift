import DesignSystem
import DesynKit
import PanelKit
import SharedKit
import SwiftUI

/// Style: fill, stroke, corners, opacity and blend, effects, and image adjustments.
struct StyleSection: View {
    let model: InspectorModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PaintEditor(model: model)
            if !model.isPageMode {
                if model.targets.contains(where: NodeEditing.supportsStroke) {
                    StrokeEditor(model: model)
                }
                if model.targets.contains(where: { $0.json["cornerRadius"] != nil }) {
                    CornerEditor(model: model)
                }
                AppearanceEditor(model: model)
                if !model.images.isEmpty {
                    ImageAdjustEditor(model: model)
                }
                EffectsEditor(model: model)
            }
        }
    }
}

// MARK: Stroke

private struct StrokeEditor: View {
    let model: InspectorModel
    @State private var showColor = false

    private var stroke: Stroke? { model.first?.strokes.first }
    private var isLine: Bool { model.first?.type == .line }

    var body: some View {
        PanelSection(isLine ? "Line" : "Stroke", trailing: {
            if stroke != nil, !isLine {
                Button("Remove") {
                    model.edit("Remove stroke", final: true) { NodeEditing.removeStrokes(on: $0) }
                }
                .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                .foregroundStyle(Palette.sun)
            }
        }) {
            if let stroke {
                HStack(spacing: Spacing.sm) {
                    Button {
                        showColor.toggle()
                    } label: {
                        Circle()
                            .fill(Color(hex: stroke.fills.first?.swatchHex ?? "#111111"))
                            .frame(width: 30, height: 30)
                            .overlay(Circle().strokeBorder(showColor ? Palette.sun : Palette.border, lineWidth: showColor ? 2.5 : 1))
                            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Stroke color")
                    ScrubField("W", value: stroke.width, in: 0...200, step: 1, unit: "px") { value, final in
                        let color = stroke.fills.first?.swatchHex ?? "#111111"
                        model.edit("Change stroke width", final: final) { NodeEditing.setStroke(color: color, width: value, on: $0) }
                    }
                }
                if showColor {
                    SunColorPicker(hex: stroke.fills.first?.swatchHex ?? "#111111") { hex, final in
                        model.edit("Change stroke color", final: final) { nodes in
                            nodes.flatMap { node in NodeEditing.setStroke(color: hex, width: node.strokes.first?.width ?? stroke.width, on: [node]) }
                        }
                    }
                }
                if !isLine {
                    IconSegments(selection: stroke.align, options: [
                        ("inside", "square.inset.filled", "Inside"),
                        ("center", "square", "Center"),
                        ("outside", "square.dashed", "Outside"),
                    ]) { align in
                        let color = stroke.fills.first?.swatchHex ?? "#111111"
                        model.edit("Change stroke position", final: true) { NodeEditing.setStroke(color: color, width: stroke.width, align: align, on: $0) }
                    }
                }
                IconSegments(selection: dashStyle(stroke), options: [
                    ("solid", "line.horizontal.3", "Solid"),
                    ("dash", "line.3.horizontal.decrease", "Dashed"),
                    ("dot", "ellipsis", "Dotted"),
                ]) { style in
                    let color = stroke.fills.first?.swatchHex ?? "#111111"
                    let w = max(1, stroke.width)
                    let dash: [Double] = style == "dash" ? [w * 3, w * 2] : style == "dot" ? [w, w * 1.6] : []
                    model.edit("Change stroke style", final: true) { NodeEditing.setStroke(color: color, width: stroke.width, dash: dash, on: $0) }
                }
                if isLine {
                    lineCaps
                }
            } else {
                DSButton("Add stroke", systemImage: "plus", kind: .secondary, size: .small) {
                    model.edit("Add stroke", final: true) { NodeEditing.setStroke(color: "#111111", width: 2, on: $0) }
                }
            }
        }
    }

    private func dashStyle(_ stroke: Stroke) -> String {
        guard let dash = stroke.json["dash"]?.arrayValue, let first = dash.first?.doubleValue, first > 0 else { return "solid" }
        return first <= max(1, stroke.width) * 1.2 ? "dot" : "dash"
    }

    private var lineCaps: some View {
        let caps = ["none", "arrow", "triangle", "circle", "square", "diamond", "bar"]
        return VStack(alignment: .leading, spacing: Spacing.sm) {
            Text("Ends").font(.dsFootnote).foregroundStyle(Palette.muted)
            HStack(spacing: Spacing.sm) {
                Menu {
                    ForEach(caps, id: \.self) { cap in
                        Button(cap.capitalized) {
                            model.edit("Change line start", final: true) { NodeEditing.setLineCaps(start: cap, end: nil, on: $0) }
                        }
                    }
                } label: {
                    capLabel("Start", model.first?.string("startCap") ?? "none")
                }
                Menu {
                    ForEach(caps, id: \.self) { cap in
                        Button(cap.capitalized) {
                            model.edit("Change line end", final: true) { NodeEditing.setLineCaps(start: nil, end: cap, on: $0) }
                        }
                    }
                } label: {
                    capLabel("End", model.first?.string("endCap") ?? "none")
                }
            }
        }
    }

    private func capLabel(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title).font(.dsFootnote).foregroundStyle(Palette.muted)
            Spacer()
            Text(value.capitalized).font(.dsCallout).foregroundStyle(Palette.foreground)
            Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
        }
        .padding(.horizontal, Spacing.md)
        .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
    }
}

// MARK: Corners

private struct CornerEditor: View {
    let model: InspectorModel
    @State private var perCorner = false

    private var radius: CornerRadius { model.first?.cornerRadius ?? .uniform(0) }
    private var maxRadius: Double {
        guard let node = model.first else { return 500 }
        return max(1, min(node.width, node.height) / 2)
    }

    var body: some View {
        PanelSection("Corners", trailing: {
            Button {
                perCorner.toggle()
            } label: {
                Image(systemName: perCorner ? "square.dashed" : "square.on.square.dashed")
                    .foregroundStyle(perCorner ? Palette.sun : Palette.muted)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel(perCorner ? "Same radius for all corners" : "Radius per corner")
        }) {
            if perCorner {
                let values = cornerValues
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.sm) {
                    ForEach(0..<4, id: \.self) { index in
                        ScrubField(["↖", "↗", "↘", "↙"][index], value: values[index], in: 0...maxRadius, unit: "px") { value, final in
                            var next = values
                            next[index] = value
                            model.edit("Change corner radius", final: final) {
                                NodeEditing.setCornerRadius(.corners(next[0], next[1], next[2], next[3]), on: $0)
                            }
                        }
                    }
                }
            } else {
                DSSlider("Radius", value: Binding(get: { radius.maxValue }, set: { value in
                    model.edit("Change corner radius", final: false) { NodeEditing.setCornerRadius(.uniform(value), on: $0) }
                }), in: 0...maxRadius, format: { "\(Int($0)) px" }) { editing in
                    if !editing { model.edit("Change corner radius", final: true) { NodeEditing.setCornerRadius(.uniform(radius.maxValue), on: $0) } }
                }
            }
            if model.first?.type != .image {
                DSSlider("Smoothing", value: Binding(get: { model.first?.number("cornerSmoothing") ?? 0 }, set: { value in
                    model.edit("Change corner smoothing", final: false) { NodeEditing.setCornerSmoothing(value, on: $0) }
                }), in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                    if !editing {
                        let value = model.first?.number("cornerSmoothing") ?? 0
                        model.edit("Change corner smoothing", final: true) { NodeEditing.setCornerSmoothing(value, on: $0) }
                    }
                }
            }
        }
        .onAppear {
            if case .corners = radius { perCorner = true }
        }
    }

    private var cornerValues: [Double] {
        switch radius {
        case let .uniform(value): [value, value, value, value]
        case let .corners(tl, tr, br, bl): [tl, tr, br, bl]
        }
    }
}

// MARK: Appearance

private struct AppearanceEditor: View {
    let model: InspectorModel

    var body: some View {
        PanelSection("Appearance") {
            DSSlider("Opacity", value: Binding(get: { model.first?.opacity ?? 1 }, set: { value in
                model.edit("Change opacity", final: false) { NodeEditing.setOpacity(value, on: $0) }
            }), in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                if !editing {
                    let value = model.first?.opacity ?? 1
                    model.edit("Change opacity", final: true) { NodeEditing.setOpacity(value, on: $0) }
                }
            }
            Menu {
                ForEach(NodeEditing.blendModes, id: \.self) { mode in
                    Button {
                        model.edit("Change blend mode", final: true) { NodeEditing.setBlend(mode, on: $0) }
                    } label: {
                        if model.first?.blend == mode {
                            Label(Self.title(mode), systemImage: "checkmark")
                        } else {
                            Text(Self.title(mode))
                        }
                    }
                }
            } label: {
                HStack {
                    Text("Blend").font(.dsSubheadline).foregroundStyle(Palette.muted)
                    Spacer()
                    Text(Self.title(model.first?.blend ?? "normal")).font(.dsCallout).foregroundStyle(Palette.foreground)
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
                }
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: Spacing.touchTarget)
                .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            }
        }
    }

    static func title(_ mode: String) -> String {
        mode.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}

// MARK: Effects

private struct EffectsEditor: View {
    let model: InspectorModel

    private var effects: [Effect] { model.first?.effects ?? [] }

    var body: some View {
        PanelSection("Effects", trailing: {
            Menu {
                ForEach(NodeEditing.EffectKind.allCases, id: \.self) { kind in
                    Button {
                        guard !kind.isAdvanced || model.context.require("effects.advanced") else { return }
                        model.edit("Add \(kind.title.lowercased())", final: true) { NodeEditing.addEffect(kind, on: $0) }
                    } label: {
                        if kind.isAdvanced, model.context.isLocked("effects.advanced") {
                            Label("\(kind.title) (Pro)", systemImage: "lock")
                        } else {
                            Text(kind.title)
                        }
                    }
                }
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(Palette.sun)
                    .frame(width: 36, height: 36)
            }
            .accessibilityLabel("Add effect")
        }) {
            if effects.isEmpty {
                Text("Shadows, glow, blur and grain. Add one with +.")
                    .font(.dsFootnote)
                    .foregroundStyle(Palette.muted)
            }
            ForEach(Array(effects.enumerated()), id: \.offset) { index, effect in
                EffectRow(model: model, index: index, effect: effect)
            }
        }
    }
}

private struct EffectRow: View {
    let model: InspectorModel
    let index: Int
    let effect: Effect
    @State private var expanded = false

    private var kind: NodeEditing.EffectKind? { NodeEditing.EffectKind(rawValue: effect.type) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            HStack(spacing: Spacing.sm) {
                Button {
                    model.edit("Toggle effect", final: true) { NodeEditing.setEffect(index: index, key: "visible", value: .bool(!effect.visible), on: $0) }
                } label: {
                    Image(systemName: effect.visible ? "eye" : "eye.slash")
                        .foregroundStyle(effect.visible ? Palette.foreground : Palette.muted)
                        .frame(width: 36, height: 36)
                }
                .accessibilityLabel(effect.visible ? "Hide effect" : "Show effect")
                Button {
                    withAnimation(Motion.quick) { expanded.toggle() }
                } label: {
                    HStack {
                        Text(kind?.title ?? effect.type).font(.dsCallout).foregroundStyle(Palette.foreground)
                        Spacer()
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(Palette.muted)
                    }
                    .frame(minHeight: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button {
                    model.edit("Remove effect", final: true) { NodeEditing.removeEffect(index: index, on: $0) }
                } label: {
                    Image(systemName: "trash").foregroundStyle(Palette.muted).frame(width: 36, height: 36)
                }
                .accessibilityLabel("Remove effect")
            }
            if expanded {
                fields
            }
        }
        .padding(Spacing.sm)
        .background(Palette.surface2.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    }

    @ViewBuilder private var fields: some View {
        switch kind {
        case .dropShadow, .innerShadow:
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.sm) {
                field("X", "x", -200...200)
                field("Y", "y", -200...200)
                field("Blur", "blur", 0...200)
                field("Spread", "spread", -100...100)
            }
            colorField
        case .layerBlur, .backgroundBlur:
            field("Radius", "radius", 0...200)
        case .glow:
            field("Radius", "radius", 0...200)
            DSSlider("Strength", value: Binding(get: { effect.number("strength") ?? 0.6 }, set: { value in
                model.edit("Change glow", final: false) { NodeEditing.setEffect(index: index, key: "strength", value: .number(value), on: $0) }
            }), in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                if !editing {
                    let value = effect.number("strength") ?? 0.6
                    model.edit("Change glow", final: true) { NodeEditing.setEffect(index: index, key: "strength", value: .number(value), on: $0) }
                }
            }
            colorField
        case .noise:
            DSSlider("Amount", value: Binding(get: { effect.number("amount") ?? 0.15 }, set: { value in
                model.edit("Change grain", final: false) { NodeEditing.setEffect(index: index, key: "amount", value: .number(value), on: $0) }
            }), in: 0...1, format: { "\(Int(($0 * 100).rounded()))%" }) { editing in
                if !editing {
                    let value = effect.number("amount") ?? 0.15
                    model.edit("Change grain", final: true) { NodeEditing.setEffect(index: index, key: "amount", value: .number(value), on: $0) }
                }
            }
            PanelToggle("Monochrome", isOn: effect.bool("mono") ?? true) { mono in
                model.edit("Change grain", final: true) { NodeEditing.setEffect(index: index, key: "mono", value: .bool(mono), on: $0) }
            }
        case nil:
            Text("This effect comes from a newer version of Desyn.").font(.dsFootnote).foregroundStyle(Palette.muted)
        }
    }

    private func field(_ label: String, _ key: String, _ range: ClosedRange<Double>) -> some View {
        ScrubField(label, value: effect.number(key) ?? 0, in: range, unit: "px") { value, final in
            model.edit("Change \(kind?.title.lowercased() ?? "effect")", final: final) {
                NodeEditing.setEffect(index: index, key: key, value: .number(value), on: $0)
            }
        }
    }

    private var colorField: some View {
        SunColorPicker(hex: effect.string("color") ?? "#00000040") { hex, final in
            model.edit("Change \(kind?.title.lowercased() ?? "effect") color", final: final) {
                NodeEditing.setEffect(index: index, key: "color", value: .string(hex), on: $0)
            }
        }
    }
}

// MARK: Images

private struct ImageAdjustEditor: View {
    let model: InspectorModel

    private struct Adjustment: Hashable {
        let key: String
        let title: String
        let range: ClosedRange<Double>
    }

    private static let sliders: [Adjustment] = [
        Adjustment(key: "brightness", title: "Brightness", range: -1...1),
        Adjustment(key: "contrast", title: "Contrast", range: -1...1),
        Adjustment(key: "saturation", title: "Saturation", range: -1...1),
        Adjustment(key: "temperature", title: "Warmth", range: -1...1),
        Adjustment(key: "exposure", title: "Exposure", range: -1...1),
        Adjustment(key: "vignette", title: "Vignette", range: 0...1),
        Adjustment(key: "blur", title: "Blur", range: 0...50),
        Adjustment(key: "grain", title: "Grain", range: 0...1),
    ]

    private var image: Node? { model.images.first }

    var body: some View {
        PanelSection("Photo", trailing: {
            Button("Reset") {
                model.edit("Reset adjustments", final: true) { NodeEditing.resetAdjustments(on: $0) }
            }
            .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
            .foregroundStyle(Palette.sun)
        }) {
            if let image {
                let adjust = NodeEditing.adjustments(of: image)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ChipButton("Original", isSelected: adjust["filter"] == nil || adjust["filter"] == .null) {
                            model.edit("Remove filter", final: true) { NodeEditing.setAdjustment("filter", nil, on: $0) }
                        }
                        ForEach(NodeEditing.imageFilters, id: \.self) { filter in
                            ChipButton(filter.capitalized, isSelected: adjust["filter"]?.stringValue == filter) {
                                model.edit("Apply \(filter) filter", final: true) { NodeEditing.setAdjustment("filter", .string(filter), on: $0) }
                            }
                        }
                    }
                }
                IconSegments(selection: image.string("fit") ?? "fill", options: [
                    ("fill", "rectangle.arrowtriangle.2.outward", "Fill"),
                    ("fit", "rectangle.arrowtriangle.2.inward", "Fit"),
                    ("tile", "square.grid.3x3", "Tile"),
                ]) { fit in
                    model.edit("Change image fit", final: true) { NodeEditing.setImageFit(fit, on: $0) }
                }
                ForEach(Self.sliders, id: \.key) { item in
                    DSSlider(item.title, value: Binding(get: { adjust[item.key]?.doubleValue ?? 0 }, set: { value in
                        model.edit("Adjust \(item.title.lowercased())", final: false) { NodeEditing.setAdjustment(item.key, .number(value), on: $0) }
                    }), in: item.range, format: { item.range.upperBound > 1 ? "\(Int($0)) px" : "\(Int(($0 * 100).rounded()))" }) { editing in
                        if !editing, let current = model.images.first.map(NodeEditing.adjustments(of:))?[item.key] {
                            model.edit("Adjust \(item.title.lowercased())", final: true) { NodeEditing.setAdjustment(item.key, current, on: $0) }
                        }
                    }
                }
            }
        }
    }
}
