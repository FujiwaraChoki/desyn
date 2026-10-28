import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Text: styles (presets), font with weight and italic, size, alignment, spacing, case, decoration, lists, sizing
/// and curve.
struct TextSection: View {
    let model: InspectorModel
    @State private var showFonts = false

    private var text: Node? { model.textNodes.first }
    private var style: TextStyle? { text?.textStyle }
    private var paragraph: ParagraphStyle? { text?.paragraph }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            PanelSection("Styles") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ForEach(ElementFactory.textPresets) { preset in
                            ChipButton(preset.title) { apply(preset) }
                        }
                    }
                }
            }
            PanelSection("Font") {
                fontRow
                HStack(spacing: Spacing.sm) {
                    weightMenu
                    Button {
                        let italic = !(style?.isItalic ?? false)
                        model.edit(italic ? "Italic" : "Upright", final: true) { NodeEditing.setTextStyle("fontStyle", .string(italic ? "italic" : "normal"), on: $0) }
                    } label: {
                        Image(systemName: "italic")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(style?.isItalic == true ? Palette.sun : Palette.foreground)
                            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Italic")
                    .accessibilityAddTraits(style?.isItalic == true ? .isSelected : [])
                }
                HStack(spacing: Spacing.sm) {
                    ScrubField("Size", value: style?.fontSize ?? 24, in: 1...1000, unit: "px") { value, final in
                        model.edit("Change text size", final: final) { NodeEditing.setTextStyle("fontSize", .number(value.rounded()), on: $0) }
                    }
                    Stepper("Size", onIncrement: { step(+1) }, onDecrement: { step(-1) })
                        .labelsHidden()
                        .tint(Palette.sun)
                }
            }
            PanelSection("Paragraph") {
                IconSegments(selection: paragraph?.align ?? "left", options: [
                    ("left", "text.alignleft", "Align left"),
                    ("center", "text.aligncenter", "Align center"),
                    ("right", "text.alignright", "Align right"),
                    ("justify", "text.justify", "Justify"),
                ]) { align in
                    model.edit("Align text", final: true) { NodeEditing.setParagraph("align", .string(align), on: $0) }
                }
                IconSegments(selection: text?.string("verticalAlign") ?? "top", options: [
                    ("top", "align.vertical.top", "Top"),
                    ("middle", "align.vertical.center", "Middle"),
                    ("bottom", "align.vertical.bottom", "Bottom"),
                ]) { align in
                    model.edit("Align text vertically", final: true) { NodeEditing.setTextField("verticalAlign", .string(align), on: $0) }
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: Spacing.sm) {
                    ScrubField("Letter", value: (style?.number("letterSpacing") ?? 0) * 100, in: -20...100, unit: "%") { value, final in
                        model.edit("Change letter spacing", final: final) { NodeEditing.setTextStyle("letterSpacing", .number((value / 100 * 1000).rounded() / 1000), on: $0) }
                    }
                    ScrubField("Line", value: lineHeightPercent ?? 120, in: 50...400, step: 5, unit: "%") { value, final in
                        model.edit("Change line height", final: final) { NodeEditing.setLineHeight(percent: value, on: $0) }
                    }
                    ScrubField("After", value: paragraph?.number("spacing") ?? 0, in: 0...400, unit: "px") { value, final in
                        model.edit("Change paragraph spacing", final: final) { NodeEditing.setParagraph("spacing", .number(value), on: $0) }
                    }
                    ScrubField("Indent", value: paragraph?.number("indent") ?? 0, in: 0...400, unit: "px") { value, final in
                        model.edit("Change indent", final: final) { NodeEditing.setParagraph("indent", .number(value), on: $0) }
                    }
                }
                IconSegments(selection: paragraph?.string("list") ?? "none", options: [
                    ("none", "text.alignleft", "No list"),
                    ("bullet", "list.bullet", "Bulleted list"),
                    ("number", "list.number", "Numbered list"),
                ]) { list in
                    model.edit("Change list", final: true) { NodeEditing.setParagraph("list", .string(list), on: $0) }
                }
            }
            PanelSection("Details") {
                IconSegments(selection: style?.string("textCase") ?? "none", options: [
                    ("none", "textformat", "As typed"),
                    ("upper", "textformat.size.larger", "Uppercase"),
                    ("lower", "textformat.size.smaller", "Lowercase"),
                    ("title", "textformat.alt", "Title case"),
                ]) { value in
                    model.edit("Change case", final: true) { NodeEditing.setTextStyle("textCase", .string(value), on: $0) }
                }
                IconSegments(selection: style?.string("decoration") ?? "none", options: [
                    ("none", "character", "No decoration"),
                    ("underline", "underline", "Underline"),
                    ("strikethrough", "strikethrough", "Strikethrough"),
                ]) { value in
                    model.edit("Change decoration", final: true) { NodeEditing.setTextStyle("decoration", .string(value), on: $0) }
                }
                IconSegments(selection: text?.string("autoResize") ?? "height", options: [
                    ("none", "rectangle", "Fixed size"),
                    ("height", "arrow.up.and.down.text.horizontal", "Auto height"),
                    ("width", "arrow.left.and.right.text.vertical", "Auto width"),
                ]) { value in
                    model.edit("Change text sizing", final: true) { NodeEditing.setTextField("autoResize", .string(value), on: $0) }
                }
                DSSlider("Curve", value: Binding(get: { text?.number("curve") ?? 0 }, set: { value in
                    model.edit("Curve text", final: false) { NodeEditing.setTextField("curve", .number(value.rounded()), on: $0) }
                }), in: -360...360, format: { "\(Int($0))°" }) { editing in
                    if !editing {
                        let value = model.textNodes.first?.number("curve") ?? 0
                        model.edit("Curve text", final: true) { NodeEditing.setTextField("curve", .number(value.rounded()), on: $0) }
                    }
                }
            }
        }
        .sheet(isPresented: $showFonts) {
            FontPicker(model: model)
        }
    }

    private var lineHeightPercent: Double? {
        guard let lineHeight = paragraph?.object("lineHeight") else { return nil }
        if lineHeight["unit"]?.stringValue == "percent" { return lineHeight["value"]?.doubleValue }
        if lineHeight["unit"]?.stringValue == "px", let px = lineHeight["value"]?.doubleValue, let size = style?.fontSize, size > 0 {
            return (px / size * 100).rounded()
        }
        return nil
    }

    private var fontRow: some View {
        let family = style?.fontFamily ?? "Inter"
        return Button {
            showFonts = true
        } label: {
            HStack {
                Text(family)
                    .font(FontService.shared.previewFont(family, size: 17) ?? .dsBody)
                    .foregroundStyle(Palette.foreground)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Spacing.md)
            .frame(minHeight: Spacing.touchTarget + 4)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.field, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Font, \(family)")
        .accessibilityHint("Opens the font list")
        .task(id: family) { await FontService.shared.loadPreview(family) }
    }

    private var weightMenu: some View {
        let family = style?.fontFamily ?? "Inter"
        let weights = FontFamily.named(family)?.weights ?? [400, 700]
        let current = Int(style?.fontWeight ?? 400)
        return Menu {
            ForEach(weights, id: \.self) { weight in
                Button {
                    Task {
                        await FontService.shared.ensure(family, weight: Double(weight), italic: style?.isItalic ?? false, in: model.editor)
                        model.edit("Change weight", final: true) { NodeEditing.setTextStyle("fontWeight", .number(Double(weight)), on: $0) }
                    }
                } label: {
                    if weight == current {
                        Label(FontFamily.weightName(weight), systemImage: "checkmark")
                    } else {
                        Text(FontFamily.weightName(weight))
                    }
                }
            }
        } label: {
            HStack {
                Text(FontFamily.weightName(current)).font(.dsCallout).foregroundStyle(Palette.foreground)
                Spacer()
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, Spacing.md)
            .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        }
        .accessibilityLabel("Weight, \(FontFamily.weightName(current))")
    }

    private func step(_ delta: Double) {
        model.edit("Change text size", final: true) { nodes in
            nodes.flatMap { node in
                NodeEditing.setTextStyle("fontSize", .number(max(1, (node.textStyle?.fontSize ?? 24) + delta)), on: node)
            }
        }
    }

    private func apply(_ preset: ElementFactory.TextPreset) {
        guard let page = model.editor.currentPage else { return }
        let size = preset.fontSize(pageWidth: page.width, pageHeight: page.height)
        Task {
            await FontService.shared.ensure(preset.fontFamily, weight: preset.fontWeight, italic: preset.italic, in: model.editor)
            model.edit("Apply \(preset.title.lowercased()) style", final: true) { nodes in
                NodeEditing.applyTextStyle([
                    "fontFamily": .string(preset.fontFamily),
                    "fontWeight": .number(preset.fontWeight),
                    "fontStyle": .string(preset.italic ? "italic" : "normal"),
                    "fontSize": .number(size),
                    "letterSpacing": .number(preset.letterSpacing),
                    "textCase": .string(preset.textCase),
                ], paragraph: ["lineHeight": ["unit": "percent", "value": .number(preset.lineHeight)]], on: nodes)
            }
        }
    }
}
