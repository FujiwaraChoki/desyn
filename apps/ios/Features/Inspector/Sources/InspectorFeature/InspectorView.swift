import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// The inspector: a resizable sheet over the canvas (the canvas stays interactive and visible up to the medium
/// detent) with sections for what is selected: style, text, content (charts, tables, QR), arrange, position and
/// animate. With nothing selected it edits the current page (background, transitions).
public struct InspectorView: View {
    @State private var model: InspectorModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(editor: EditorModel) {
        _model = State(initialValue: InspectorModel(editor: editor))
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            if model.sections.count > 1 {
                sectionTabs
            }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    if !model.canEdit {
                        InlineNotice("This design is view only. Ask its owner for edit access to change it.", tone: .info)
                    }
                    content
                        .disabled(!model.canEdit)
                        .opacity(model.canEdit ? 1 : 0.5)
                }
                .padding(.horizontal, Spacing.gutter)
                .padding(.top, Spacing.md)
                .padding(.bottom, Spacing.xxxl)
                .animation(Motion.animation(Motion.quick, reduced: reduceMotion), value: model.currentSection)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .panelSheet([.fraction(0.42), .medium, .large], interactiveUpThrough: .medium)
        .onChange(of: model.editor.selection) { _, _ in
            if !model.sections.contains(model.section) { model.section = model.sections.first ?? .style }
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                SerifHeadline(model.title, size: 26, relativeTo: .title2)
                    .lineLimit(1)
                if let subtitle = model.subtitle {
                    Text(subtitle).font(.dsFootnote).foregroundStyle(Palette.muted)
                }
            }
            Spacer(minLength: Spacing.md)
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 30, height: 30)
                    .background(Palette.surface2, in: Circle())
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel("Close")
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, Spacing.lg)
        .padding(.bottom, Spacing.xs)
    }

    private var sectionTabs: some View {
        DSTabStrip(
            selection: Binding(get: { model.currentSection }, set: { model.section = $0 }),
            tabs: model.sections.map { ($0, $0.title, $0.systemImage) }
        )
        .padding(.horizontal, -Spacing.xs)
    }

    @ViewBuilder private var content: some View {
        switch model.currentSection {
        case .style: StyleSection(model: model)
        case .text: TextSection(model: model)
        case .data: DataSection(model: model)
        case .arrange: ArrangeSection(model: model)
        case .position: PositionSection(model: model)
        case .animate: AnimateSection(model: model)
        }
    }
}
