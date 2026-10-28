import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// The insert sheet: shapes, text styles, photos (library, camera, stock, files), icons, charts / tables / QR and the
/// workspace's uploads. Opens at a tab; the canvas stays visible and interactive at the medium height.
public struct InsertSheet: View {
    @State private var model: InsertModel
    @State private var tab: InsertTab
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel, context: EditorContext, tab: InsertTab) {
        _model = State(initialValue: InsertModel(editor: editor, context: context))
        _tab = State(initialValue: tab)
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("add to your *design*", subtitle: nil) { dismiss() }
            DSTabStrip(selection: $tab, tabs: InsertTab.allCases.map { ($0, $0.title, $0.systemImage) })
            if !model.busy.isEmpty {
                HStack(spacing: Spacing.sm) {
                    SunSpinner(size: 18)
                    Text(model.busy.last ?? "").font(.dsFootnote).foregroundStyle(Palette.muted).lineLimit(1)
                    Spacer()
                }
                .padding(.horizontal, Spacing.gutter)
                .padding(.vertical, Spacing.sm)
                .transition(.opacity)
            }
            if let error = model.errorMessage {
                InlineNotice(error, tone: .error, actionTitle: "Dismiss") { model.errorMessage = nil }
                    .padding(.horizontal, Spacing.gutter)
                    .padding(.top, Spacing.sm)
            }
            Group {
                switch tab {
                case .elements: ShapesTab(model: model)
                case .text: TextTab(model: model)
                case .photos: PhotosTab(model: model)
                case .icons: IconsTab(model: model)
                case .charts: ChartsTab(model: model)
                case .uploads: UploadsTab(model: model)
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)
        }
        .animation(Motion.quick, value: model.busy)
        .panelSheet([.medium, .large], interactiveUpThrough: .medium)
        .onAppear { model.resetCascade() }
    }
}

/// Grid layout shared by the tabs.
struct TileGrid<Content: View>: View {
    let minimum: CGFloat
    @ViewBuilder let content: () -> Content

    init(minimum: CGFloat = 92, @ViewBuilder content: @escaping () -> Content) {
        self.minimum = minimum
        self.content = content
    }

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minimum), spacing: Spacing.md)], spacing: Spacing.md) {
            content()
        }
    }
}

// MARK: Shapes

struct ShapesTab: View {
    let model: InsertModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                PanelSection("Shapes") {
                    TileGrid(minimum: 76) {
                        ForEach(ElementFactory.Shape.allCases.filter { $0 != .line && $0 != .arrow }) { shape in
                            TileButton(shape.title, systemImage: shape.systemImage, tint: Palette.sun) {
                                Task { await model.insertShape(shape) }
                            }
                        }
                    }
                }
                PanelSection("Lines") {
                    TileGrid(minimum: 76) {
                        TileButton("Line", systemImage: "line.diagonal", tint: Palette.foreground) {
                            Task { await model.insertShape(.line) }
                        }
                        TileButton("Arrow", systemImage: "arrow.right", tint: Palette.foreground) {
                            Task { await model.insertShape(.arrow) }
                        }
                    }
                }
            }
            .padding(Spacing.gutter)
        }
    }
}

// MARK: Text

struct TextTab: View {
    let model: InsertModel
    private var fonts: FontService { FontService.shared }

    var body: some View {
        ScrollView {
            VStack(spacing: Spacing.sm) {
                ForEach(ElementFactory.textPresets) { preset in
                    Button {
                        Task { await model.insertText(preset) }
                    } label: {
                        HStack {
                            Text(preset.sample)
                                .font(fonts.previewFont(preset.fontFamily, size: previewSize(preset), weight: Int(preset.fontWeight), italic: preset.italic) ?? DSFont.sans(previewSize(preset)))
                                .textCase(preset.textCase == "upper" ? .uppercase : nil)
                                .tracking(preset.letterSpacing * previewSize(preset))
                                .foregroundStyle(Palette.foreground)
                                .lineLimit(1)
                                .minimumScaleFactor(0.6)
                            Spacer(minLength: Spacing.sm)
                            Text(preset.title).font(.dsCaption).foregroundStyle(Palette.muted)
                        }
                        .padding(.horizontal, Spacing.lg)
                        .frame(minHeight: 64)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Add \(preset.title.lowercased()) text")
                    .task { await fonts.loadPreview(preset.fontFamily) }
                }
            }
            .padding(Spacing.gutter)
        }
    }

    private func previewSize(_ preset: ElementFactory.TextPreset) -> CGFloat {
        switch preset.id {
        case "display": 32
        case "heading": 26
        case "subheading", "quote": 20
        default: 15
        }
    }
}

// MARK: Charts, tables, QR

struct ChartsTab: View {
    let model: InsertModel
    @State private var rows = 4
    @State private var cols = 3
    @State private var qrText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                PanelSection("Charts", trailing: { proPill("charts") }) {
                    TileGrid(minimum: 76) {
                        ForEach(ElementFactory.ChartKind.allCases) { kind in
                            TileButton(kind.title, systemImage: kind.systemImage, tint: Palette.sun) {
                                Task { await model.insertChart(kind) }
                            }
                        }
                    }
                }
                PanelSection("Table", trailing: { proPill("tables") }) {
                    HStack(spacing: Spacing.md) {
                        Stepper("\(rows) rows", value: $rows, in: 1...40).font(.dsCallout)
                    }
                    HStack(spacing: Spacing.md) {
                        Stepper("\(cols) columns", value: $cols, in: 1...12).font(.dsCallout)
                    }
                    DSButton("Add table", systemImage: "tablecells", kind: .secondary) {
                        Task { await model.insertTable(rows: rows, cols: cols) }
                    }
                }
                .tint(Palette.sun)
                PanelSection("QR code", trailing: { proPill("qr") }) {
                    DSTextField("", text: $qrText, prompt: "Link, email, phone or text", kind: .plain, submitLabel: .done) {
                        Task { await model.insertQR(qrText) }
                    }
                    if !qrText.isEmpty {
                        Text("Encodes \(ElementFactory.qrPayload(qrText))")
                            .font(.dsCaption)
                            .foregroundStyle(Palette.muted)
                            .lineLimit(2)
                    }
                    DSButton("Add QR code", systemImage: "qrcode", kind: .primary) {
                        Task { await model.insertQR(qrText) }
                    }
                    .disabled(ElementFactory.qrPayload(qrText).isEmpty)
                }
            }
            .padding(Spacing.gutter)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    @ViewBuilder private func proPill(_ feature: String) -> some View {
        if model.context.isLocked(feature) { ProPill() }
    }
}
