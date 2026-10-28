import DesignSystem
import DesynEngine
import DesynKit
import FeatureCore
import PhotosUI
import SwiftUI

/// Bridges the UIKit canvas into SwiftUI.
struct CanvasView: UIViewRepresentable {
    let model: EditorModel

    func makeUIView(context: Context) -> CanvasUIView {
        let view = CanvasUIView(model: model)
        model.canvas = view
        return view
    }

    func updateUIView(_ uiView: CanvasUIView, context: Context) {}

    static func dismantleUIView(_ uiView: CanvasUIView, coordinator: ()) {
        uiView.model?.canvas = nil
    }
}

/// The editor screen: canvas, floating glass top bar, tool dock, pages strip and inspector.
public struct EditorView: View {
    @State private var model: EditorModel
    private let onClose: () -> Void

    @State private var showInspector = false
    @State private var showPages = true
    @State private var photoItem: PhotosPickerItem?
    @State private var renaming = false
    @State private var newName = ""
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.editorExtensions) private var extensions

    public init(route: DesignRoute, session: AppSession, onClose: @escaping () -> Void) {
        _model = State(initialValue: EditorModel(route: route, session: session))
        self.onClose = onClose
    }

    public var body: some View {
        ZStack {
            Palette.canvas.ignoresSafeArea()
            switch model.phase {
            case .loading:
                LoadingState("Opening \(model.name)")
            case let .failed(message):
                EmptyStateView("couldn't *open* this design.", message: message, systemImage: "exclamationmark.triangle", actionTitle: "Back to library", action: close)
            case .ready:
                CanvasView(model: model)
                    .ignoresSafeArea()
                    .accessibilityLabel("Canvas")
                if let overlay = extensions.canvasOverlay {
                    overlay(model)
                }
                chrome
            }
        }
        .task { await model.open() }
        .onDisappear { model.close() }
        .onChange(of: photoItem) { _, item in
            guard let item else { return }
            photoItem = nil
            Task { await importPhoto(item) }
        }
        .sheet(isPresented: $showInspector) {
            if let inspector = extensions.inspector {
                inspector(model)
            } else {
                InspectorSheet(model: model)
            }
        }
        .alert("Rename design", isPresented: $renaming) {
            TextField("Name", text: $newName)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { Task { await model.rename(to: newName) } }
        }
    }

    private func close() {
        model.close()
        onClose()
    }

    // MARK: Chrome

    private var chrome: some View {
        VStack(spacing: 0) {
            topBar
                .padding(.horizontal, Spacing.md)
                .padding(.top, Spacing.xs)
            Spacer(minLength: 0)
            VStack(spacing: Spacing.sm) {
                if let accessory = extensions.bottomAccessory {
                    accessory(model)
                }
                if !model.selection.isEmpty, model.editingTextId == nil, model.canEdit {
                    SelectionBar(model: model, showInspector: $showInspector)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if model.canEdit {
                    ToolDock(model: model, photoItem: $photoItem)
                }
                if showPages {
                    PagesStrip(model: model)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.horizontal, Spacing.md)
            .padding(.bottom, Spacing.xs)
        }
        .animation(Motion.animation(Motion.panel, reduced: reduceMotion), value: model.selection.isEmpty)
        .animation(Motion.animation(Motion.panel, reduced: reduceMotion), value: showPages)
    }

    private var topBar: some View {
        HStack(spacing: Spacing.sm) {
            GlassBar {
                DSIconButton("chevron.left", label: "Back to library", action: close)
                Button {
                    newName = model.name
                    renaming = model.canEdit
                } label: {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(model.name.isEmpty ? "Untitled" : model.name)
                            .font(DSFont.sans(15, weight: .semibold, relativeTo: .subheadline))
                            .foregroundStyle(Palette.foreground)
                            .lineLimit(1)
                        SyncStatusLabel(status: model.syncStatus, isUploading: model.isUploading)
                    }
                    .frame(maxWidth: horizontalSizeClass == .regular ? 320 : 150, alignment: .leading)
                    .padding(.trailing, Spacing.sm)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(model.canEdit ? "Renames the design" : "")
            }
            Spacer(minLength: Spacing.xs)
            GlassBar {
                DSIconButton("arrow.uturn.backward", label: model.undoLabel.map { "Undo \($0)" } ?? "Undo") { model.undo() }
                    .disabled(!model.canUndo)
                    .opacity(model.canUndo ? 1 : 0.4)
                DSIconButton("arrow.uturn.forward", label: model.redoLabel.map { "Redo \($0)" } ?? "Redo") { model.redo() }
                    .disabled(!model.canRedo)
                    .opacity(model.canRedo ? 1 : 0.4)
                Menu {
                    Button {
                        model.canvas?.fitPage(animated: true)
                    } label: {
                        Label("Zoom to fit", systemImage: "arrow.up.left.and.arrow.down.right")
                    }
                    Button {
                        withAnimation { showPages.toggle() }
                    } label: {
                        Label(showPages ? "Hide pages" : "Show pages", systemImage: "rectangle.split.3x1")
                    }
                } label: {
                    Text("\(model.zoomPercent)%")
                        .font(.dsMono)
                        .foregroundStyle(Palette.foreground)
                        .frame(minWidth: 52, minHeight: Spacing.touchTarget)
                }
                .accessibilityLabel("Zoom \(model.zoomPercent) percent")
            }
            if let trailing = extensions.topBarTrailing {
                trailing(model)
            }
        }
    }
}

/// "Saved", "Saving...", "Offline", "View only" under the design name.
private struct SyncStatusLabel: View {
    let status: SyncSession.Status
    let isUploading: Bool

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(text)
                .font(.dsCaption)
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private var text: String {
        if isUploading { return "Uploading photo..." }
        switch status {
        case .synced: return "Saved"
        case .syncing: return "Saving..."
        case .offline: return "Offline, saved on this \(DeviceName.current)"
        case .readOnly: return "View only"
        case let .paused(reason): return reason
        }
    }

    private var color: Color {
        if isUploading { return Palette.sun }
        switch status {
        case .synced: return Palette.success
        case .syncing: return Palette.sun
        case .offline: return Palette.muted
        case .readOnly: return Palette.info
        case .paused: return Palette.danger
        }
    }
}

extension EditorView {
    /// Loads a picked photo, downsizes it to at most 4096 px and uploads it as JPEG (PNG when it has alpha).
    private func importPhoto(_ item: PhotosPickerItem) async {
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            model.session.toasts.show("That photo couldn't be read.", tone: .error)
            return
        }
        let prepared = await Task.detached(priority: .userInitiated) { PhotoPreparation.prepare(image) }.value
        guard let prepared else {
            model.session.toasts.show("That photo couldn't be prepared.", tone: .error)
            return
        }
        await model.insertImage(data: prepared.data, mime: prepared.mime, name: prepared.name, pixelSize: prepared.pixelSize)
    }
}

/// Photo downsizing / encoding off the main thread.
enum PhotoPreparation {
    struct Prepared: Sendable {
        let data: Data
        let mime: String
        let name: String
        let pixelSize: CGSize
    }

    static func prepare(_ image: UIImage, maxSide: CGFloat = 4096) -> Prepared? {
        let pixelWidth = image.size.width * image.scale
        let pixelHeight = image.size.height * image.scale
        let factor = min(1, maxSide / max(pixelWidth, pixelHeight, 1))
        let target = CGSize(width: (pixelWidth * factor).rounded(), height: (pixelHeight * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let hasAlpha: Bool = {
            guard let alpha = image.cgImage?.alphaInfo else { return false }
            return alpha == .first || alpha == .last || alpha == .premultipliedFirst || alpha == .premultipliedLast
        }()
        format.opaque = !hasAlpha
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        let stamp = Int(Date().timeIntervalSince1970)
        if hasAlpha, let png = rendered.pngData() {
            return Prepared(data: png, mime: "image/png", name: "Photo \(stamp).png", pixelSize: target)
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.88) else { return nil }
        return Prepared(data: jpeg, mime: "image/jpeg", name: "Photo \(stamp).jpg", pixelSize: target)
    }
}
