import DesignSystem
import DesynEngine
import DesynKit
import PhotosUI
import SwiftUI

/// The floating tool dock: select, hand, text, shapes, pen (with ink settings) and photos.
struct ToolDock: View {
    let model: EditorModel
    @Binding var photoItem: PhotosPickerItem?
    @State private var showInk = false
    @Environment(\.editorExtensions) private var extensions

    private let primary: [EditorModel.Tool] = [.select, .hand, .text, .pen]
    private let shapes: [EditorModel.Tool] = [.rect, .ellipse, .triangle, .line]

    var body: some View {
        GlassBar {
            ForEach(primary) { tool in
                DSIconButton(tool.systemImage, label: tool.title, isActive: model.tool == tool) {
                    select(tool)
                }
                .contextMenu {
                    if tool == .pen {
                        Button { showInk = true } label: { Label("Ink settings", systemImage: "paintbrush.pointed") }
                    }
                }
            }
            Menu {
                ForEach(shapes) { tool in
                    Button {
                        select(tool)
                    } label: {
                        Label(tool.title, systemImage: tool.systemImage)
                    }
                }
            } label: {
                Image(systemName: model.tool.isShape ? model.tool.systemImage : "square.on.circle")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                    .foregroundStyle(model.tool.isShape ? Palette.onSun : Palette.foreground)
                    .background(Circle().fill(model.tool.isShape ? AnyShapeStyle(Palette.sun) : AnyShapeStyle(Color.clear)))
            }
            .accessibilityLabel("Shapes")
            PhotosPicker(selection: $photoItem, matching: .images) {
                Image(systemName: "photo.on.rectangle")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                    .foregroundStyle(Palette.foreground)
            }
            .accessibilityLabel("Add a photo")
            if model.tool == .pen {
                Button {
                    showInk = true
                } label: {
                    Circle()
                        .fill(Color(hex: model.penColor))
                        .frame(width: 22, height: 22)
                        .overlay(Circle().strokeBorder(Palette.border, lineWidth: 1))
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                }
                .accessibilityLabel("Ink color and width")
            }
            if let accessory = extensions.dockAccessory {
                accessory(model)
            }
        }
        .popover(isPresented: $showInk) {
            InkSettings(model: model)
                .presentationCompactAdaptation(.popover)
        }
    }

    private func select(_ tool: EditorModel.Tool) {
        guard model.tool != tool else { return }
        Haptics.selection()
        model.tool = tool
    }
}

/// Pen color and width.
private struct InkSettings: View {
    @Bindable var model: EditorModel
    private let colors = ["#ffb02e", "#ff6a1f", "#c4451c", "#111111", "#ffffff", "#5aa9ff", "#4ade80", "#e8e1d3"]

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("Ink").font(.dsHeadline).foregroundStyle(Palette.foreground)
            HStack(spacing: Spacing.sm) {
                ForEach(colors, id: \.self) { hex in
                    Button {
                        model.penColor = hex
                        Haptics.selection()
                    } label: {
                        Circle()
                            .fill(Color(hex: hex))
                            .frame(width: 28, height: 28)
                            .overlay(Circle().strokeBorder(model.penColor == hex ? Palette.sun : Palette.border, lineWidth: model.penColor == hex ? 3 : 1))
                            .frame(width: 36, height: 36)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(hex)
                    .accessibilityAddTraits(model.penColor == hex ? .isSelected : [])
                }
            }
            DSSlider("Width", value: $model.penWidth, in: 1...48, format: { "\(Int($0)) px" })
        }
        .padding(Spacing.lg)
        .frame(width: 340)
    }
}

/// Quick actions for the selection (above the dock).
struct SelectionBar: View {
    let model: EditorModel
    @Binding var showInspector: Bool

    var body: some View {
        GlassBar {
            if model.selectedNodes.count == 1, model.selectedNodes[0].type == .text {
                DSIconButton("character.cursor.ibeam", label: "Edit text") {
                    if let id = model.selection.first { model.beginTextEditing(id) }
                }
            }
            DSIconButton("slider.horizontal.3", label: "Edit style") { showInspector = true }
            DSIconButton("plus.square.on.square", label: "Duplicate") { Task { await model.duplicateSelection() } }
            DSIconButton("square.3.layers.3d.top.filled", label: "Bring forward") { Task { await model.arrange(.forward) } }
            DSIconButton("square.3.layers.3d.bottom.filled", label: "Send backward") { Task { await model.arrange(.backward) } }
            DSIconButton(model.selectionIsLocked ? "lock.fill" : "lock.open", label: model.selectionIsLocked ? "Unlock" : "Lock") {
                Task { await model.toggleLock() }
            }
            DSIconButton("trash", label: "Delete") { Task { await model.deleteSelection() } }
        }
    }
}

/// Horizontal strip of page thumbnails with add / duplicate / delete / reorder.
struct PagesStrip: View {
    let model: EditorModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(Array(model.pages.enumerated()), id: \.element.id) { index, page in
                        PageThumb(
                            page: page,
                            index: index,
                            image: model.pageThumbnails[page.id],
                            isCurrent: page.id == model.currentPage?.id
                        )
                        .id(page.id)
                        .onTapGesture { model.showPage(page.id) }
                        .contextMenu {
                            if model.canEdit {
                                Button { Task { await model.duplicatePage(page.id) } } label: { Label("Duplicate page", systemImage: "plus.square.on.square") }
                                Button { Task { await model.movePage(page.id, by: -1) } } label: { Label("Move left", systemImage: "arrow.left") }
                                    .disabled(index == 0)
                                Button { Task { await model.movePage(page.id, by: 1) } } label: { Label("Move right", systemImage: "arrow.right") }
                                    .disabled(index == model.pages.count - 1)
                                Divider()
                                Button(role: .destructive) { Task { await model.deletePage(page.id) } } label: { Label("Delete page", systemImage: "trash") }
                                    .disabled(model.pages.count < 2)
                            }
                        }
                        .accessibilityAddTraits(.isButton)
                    }
                    if model.canEdit {
                        Button {
                            Task { await model.addPage() }
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundStyle(Palette.sun)
                                .frame(width: 52, height: 64)
                                .background(Palette.surface2.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .strokeBorder(Palette.sun.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                }
                        }
                        .buttonStyle(PressScaleStyle())
                        .accessibilityLabel("Add page")
                    }
                }
                .padding(.horizontal, Spacing.sm)
                .padding(.vertical, Spacing.sm)
            }
            .onChange(of: model.currentPageId) { _, id in
                guard let id else { return }
                withAnimation(Motion.easeOut(0.4)) { proxy.scrollTo(id, anchor: .center) }
            }
        }
        .dsGlass(cornerRadius: Radius.panel)
    }
}

private struct PageThumb: View {
    let page: PageInfo
    let index: Int
    let image: CGImage?
    let isCurrent: Bool

    var body: some View {
        let ratio = page.height > 0 ? page.width / page.height : 1
        let height: CGFloat = 64
        let width = max(36, min(120, height * CGFloat(ratio)))
        ZStack(alignment: .bottomLeading) {
            Group {
                if let image {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .scaledToFit()
                } else {
                    Palette.surface2
                }
            }
            .frame(width: width, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(isCurrent ? Palette.sun : Palette.borderSubtle, lineWidth: isCurrent ? 2 : 1)
            }
            .dsGlow(isCurrent, radius: 8)
            Text("\(index + 1)")
                .font(DSFont.sans(10, weight: .semibold, relativeTo: .caption2))
                .foregroundStyle(isCurrent ? Palette.onSun : Palette.foreground)
                .padding(.horizontal, 5)
                .padding(.vertical, 1)
                .background(isCurrent ? Palette.sun : Palette.surface3, in: Capsule())
                .padding(4)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Page \(index + 1)\(page.name.isEmpty ? "" : ", \(page.name)")")
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
    }
}
