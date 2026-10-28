import DesignSystem
import DesynEngine
import EditorFeature
import FeatureCore
import PanelKit
import Photos
import SharedKit
import SwiftUI
import UIKit

/// Export: pick a format and its options, render, then share, save to Photos or save to Files.
public struct ExportSheet: View {
    @State private var model: ExportModel
    @State private var showShare = false
    @State private var showFiles = false
    @State private var filesToMove: [URL] = []
    @State private var savedToPhotos = false
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel, context: EditorContext) {
        _model = State(initialValue: ExportModel(editor: editor, context: context))
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("export your *design*", subtitle: model.editor.name) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    if let output = model.output {
                        result(output)
                    } else {
                        formats
                        options
                    }
                    if let error = model.errorMessage {
                        InlineNotice(error, tone: .error, actionTitle: "Dismiss") { model.errorMessage = nil }
                    }
                    if model.output == nil {
                        DSButton(model.working ? (model.progress ?? "Rendering") : "Export \(model.plan.format.title)", systemImage: "square.and.arrow.up", kind: .primary, size: .large, isLoading: model.working) {
                            Task { await model.export() }
                        }
                        Text(model.plan.format.rendersOnServer ? "Video renders on Desyn's servers and downloads when ready." : "Renders on this \(DeviceName.current). Works offline.")
                            .font(.dsCaption)
                            .foregroundStyle(Palette.muted)
                    }
                }
                .padding(Spacing.gutter)
            }
        }
        .panelSheet([.medium, .large], interactiveUpThrough: nil)
        .sheet(isPresented: $showShare) {
            if let output = model.output {
                ActivitySheet(items: output.files)
                    .presentationDetents([.medium, .large])
            }
        }
        .fileMover(isPresented: $showFiles, files: filesToMove) { result in
            if case .success = result { Haptics.success() }
        }
    }

    // MARK: Format

    private var formats: some View {
        PanelSection("Format") {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 100), spacing: Spacing.sm)], spacing: Spacing.sm) {
                ForEach(FileFormat.allCases) { format in
                    let selected = model.plan.format == format
                    let locked = model.context.isLocked(format.requiredFeature)
                    Button {
                        guard model.context.require(format.requiredFeature) else { return }
                        Haptics.selection()
                        model.plan.format = format
                        if !format.supportsTransparency { model.plan.transparent = false }
                        if format == .pptx { model.pages = .all }
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .top) {
                                Image(systemName: format.systemImage)
                                    .font(.system(size: 18))
                                    .foregroundStyle(selected ? Palette.sun : locked ? Palette.muted : Palette.foreground)
                                Spacer(minLength: 0)
                                if locked { ProPill() }
                            }
                            Text(format.title).font(DSFont.sans(14, weight: .semibold, relativeTo: .callout)).foregroundStyle(locked ? Palette.muted : Palette.foreground)
                            Text(format.detail).font(.dsCaption).foregroundStyle(Palette.muted).lineLimit(2).multilineTextAlignment(.leading)
                        }
                        .frame(maxWidth: .infinity, minHeight: 92, alignment: .topLeading)
                        .padding(Spacing.md)
                        .background(selected ? Palette.sun.opacity(0.1) : Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(selected ? Palette.sun.opacity(0.7) : Palette.borderSubtle, lineWidth: selected ? 1.5 : 1))
                        .dsGlow(selected, radius: 10)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel(locked ? "\(format.title), Pro" : format.title)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
    }

    // MARK: Options

    @ViewBuilder private var options: some View {
        let format = model.plan.format
        if format.isRaster || format == .gif {
            PanelSection("Size") {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Spacing.sm) {
                        ForEach(ExportPlan.scales, id: \.self) { scale in
                            ChipButton(scale < 1 ? "½×" : "\(Int(scale))×", isSelected: model.plan.scale == scale) { model.plan.scale = scale }
                        }
                    }
                }
                if let page = model.referencePage {
                    let size = model.plan.normalized(pageWidth: page.width, pageHeight: page.height).pixelSize(width: page.width, height: page.height)
                    Text("\(size.width) × \(size.height) px").font(.dsMono).foregroundStyle(Palette.muted)
                }
            }
        }
        if format.hasQuality {
            DSSlider("Quality", value: Binding(get: { model.plan.quality }, set: { model.plan.quality = $0 }), in: 30...100, format: { "\(Int($0))" })
        }
        if format.supportsTransparency {
            PanelToggle("Transparent background", detail: "Leaves out the page color.", isOn: model.plan.transparent) { model.plan.transparent = $0 }
        }
        if format == .pdf {
            PanelSection("Print", trailing: {
                if model.context.isLocked("export.pdfPrint") { ProPill() }
            }) {
                PanelToggle("Bleed", detail: "Includes the area past the trim edge.", isOn: model.plan.pdfBleed) { on in
                    if !on || model.context.require("export.pdfPrint") { model.plan.pdfBleed = on }
                }
                PanelToggle("Crop marks", isOn: model.plan.pdfCropMarks) { on in
                    if !on || model.context.require("export.pdfPrint") { model.plan.pdfCropMarks = on }
                }
                PanelToggle("CMYK", detail: "For print shops that ask for it.", isOn: model.plan.pdfCMYK) { on in
                    if !on || model.context.require("export.pdfPrint") { model.plan.pdfCMYK = on }
                }
                PanelToggle("Flatten", detail: "One image per page; text is no longer selectable.", isOn: model.plan.pdfFlatten) { model.plan.pdfFlatten = $0 }
            }
        }
        if format == .gif {
            DSSlider("Frames per second", value: Binding(get: { model.plan.gifFPS }, set: { model.plan.gifFPS = $0 }), in: 5...30, format: { "\(Int($0))" })
        }
        if model.canChoosePages {
            PanelSection("Pages") {
                DSSegmentedControl(selection: Binding(get: { model.pages }, set: { model.pages = $0 }), options: [
                    (ExportModel.Pages.all, "All \(model.pageInfos.count)"),
                    (ExportModel.Pages.current, "Current"),
                    (ExportModel.Pages.chosen, "Choose"),
                ])
                if model.pages == .chosen {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.sm) {
                            ForEach(Array(model.pageInfos.enumerated()), id: \.element.id) { index, page in
                                let on = model.chosenPages.contains(page.id)
                                Button {
                                    if on { model.chosenPages.remove(page.id) } else { model.chosenPages.insert(page.id) }
                                } label: {
                                    pageThumb(index: index, page: page, selected: on)
                                }
                                .buttonStyle(PressScaleStyle())
                                .accessibilityLabel("Page \(index + 1)")
                                .accessibilityAddTraits(on ? .isSelected : [])
                            }
                        }
                    }
                }
            }
        }
    }

    private func pageThumb(index: Int, page: PageInfo, selected: Bool) -> some View {
        let ratio = page.height > 0 ? page.width / page.height : 1
        return ZStack(alignment: .topTrailing) {
            Group {
                if let image = model.editor.pageThumbnails[page.id] {
                    Image(decorative: image, scale: 1).resizable().scaledToFit()
                } else {
                    Palette.surface3
                }
            }
            .frame(width: max(40, min(110, 72 * CGFloat(ratio))), height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(selected ? Palette.sun : Palette.borderSubtle, lineWidth: selected ? 2 : 1))
            Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(selected ? Palette.sun : Palette.muted)
                .background(Circle().fill(Palette.surface1))
                .padding(4)
        }
    }

    // MARK: Result

    private func result(_ output: ExportModel.Output) -> some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            HStack(spacing: Spacing.md) {
                ZStack {
                    Circle().fill(Palette.sun.opacity(0.16)).frame(width: 64, height: 64).blur(radius: 10)
                    Image(systemName: "checkmark.seal.fill").font(.system(size: 30)).foregroundStyle(Palette.sun)
                }
                VStack(alignment: .leading, spacing: 2) {
                    SerifHeadline("ready to *share*", size: 24, relativeTo: .title2)
                    Text("\(output.files.count) file\(output.files.count == 1 ? "" : "s") · \(ByteCountFormatter.string(fromByteCount: Int64(output.bytes), countStyle: .file))\(output.renderedOnServer ? " · rendered on the server" : "")")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                }
            }
            if output.format.isRaster || output.format == .gif, let first = output.files.first, let image = UIImage(contentsOfFile: first.path) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 220)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel("Exported image")
            }
            ForEach(output.files, id: \.self) { file in
                Label(file.lastPathComponent, systemImage: "doc")
                    .font(.dsFootnote)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
            }
            if !output.warnings.isEmpty {
                InlineNotice(output.warnings.prefix(3).joined(separator: " "), tone: .warning)
            }
            DSButton("Share", systemImage: "square.and.arrow.up", kind: .primary) { showShare = true }
            HStack(spacing: Spacing.sm) {
                if output.format.isPhotoLibraryCompatible {
                    DSButton(savedToPhotos ? "Saved" : "Save to Photos", systemImage: savedToPhotos ? "checkmark" : "photo.on.rectangle", kind: .secondary) {
                        Task { await saveToPhotos(output) }
                    }
                    .disabled(savedToPhotos)
                }
                DSButton("Save to Files", systemImage: "folder", kind: .secondary) { prepareMove(output) }
            }
            Button("Export another format") {
                model.errorMessage = nil
                savedToPhotos = false
                resetOutput()
            }
            .font(DSFont.sans(14, weight: .semibold, relativeTo: .callout))
            .foregroundStyle(Palette.sun)
            .frame(maxWidth: .infinity, minHeight: Spacing.touchTarget)
        }
    }

    private func resetOutput() {
        model.discardOutput()
    }

    /// The Files mover takes the files away; hand it copies so sharing keeps working.
    private func prepareMove(_ output: ExportModel.Output) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ExportCopies", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        filesToMove = output.files.compactMap { file in
            let copy = folder.appendingPathComponent(file.lastPathComponent)
            return (try? FileManager.default.copyItem(at: file, to: copy)) != nil ? copy : nil
        }
        showFiles = !filesToMove.isEmpty
    }

    private func saveToPhotos(_ output: ExportModel.Output) async {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            model.errorMessage = "Desyn can't save to Photos. Allow it in Settings > Privacy > Photos."
            return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                for file in output.files {
                    let request = PHAssetCreationRequest.forAsset()
                    request.addResource(with: output.format == .mp4 ? .video : .photo, fileURL: file, options: nil)
                }
            }
            savedToPhotos = true
            Haptics.success()
        } catch {
            model.errorMessage = "Saving to Photos failed. \(error.localizedDescription)"
        }
    }
}

/// The system share sheet for files.
struct ActivitySheet: UIViewControllerRepresentable {
    let items: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
