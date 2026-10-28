import DesignSystem
import DesynKit
import FeatureCore
import PanelKit
import PhotosUI
import SharedKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Photos: from the library (several at once), the camera or Files, uploaded to the workspace; and stock photos
/// searched through the backend (Unsplash / Pexels keys stay on the server), credited to their authors.
struct PhotosTab: View {
    let model: InsertModel

    @State private var picked: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var query = ""
    @State private var orientation: String?
    @State private var results: [StockPhoto] = []
    @State private var searching = false
    @State private var configured = true
    @State private var searchError: String?

    private static let suggestions = ["Sunset", "Coffee", "Mountains", "Office", "Flowers", "City night", "Food", "Texture"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.xl) {
                PanelSection("From this \(DeviceName.current)") {
                    HStack(spacing: Spacing.sm) {
                        PhotosPicker(selection: $picked, maxSelectionCount: 10, matching: .images) {
                            sourceLabel("Photos", systemImage: "photo.on.rectangle")
                        }
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            Button { showCamera = true } label: { sourceLabel("Camera", systemImage: "camera") }
                                .buttonStyle(PressScaleStyle())
                        }
                        Button { showFiles = true } label: { sourceLabel("Files", systemImage: "folder") }
                            .buttonStyle(PressScaleStyle())
                    }
                }
                PanelSection("Stock photos") {
                    DSTextField("", text: $query, prompt: "Search free photos", kind: .search, submitLabel: .search) {
                        Task { await search() }
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: Spacing.sm) {
                            ChipButton("Any shape", isSelected: orientation == nil) { setOrientation(nil) }
                            ChipButton("Landscape", systemImage: "rectangle", isSelected: orientation == "landscape") { setOrientation("landscape") }
                            ChipButton("Portrait", systemImage: "rectangle.portrait", isSelected: orientation == "portrait") { setOrientation("portrait") }
                            ChipButton("Square", systemImage: "square", isSelected: orientation == "square") { setOrientation("square") }
                        }
                    }
                    stockResults
                }
            }
            .padding(Spacing.gutter)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = []
            Task { await importPicked(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                Task {
                    guard let prepared = await Task.detached(priority: .userInitiated, operation: { ImagePreparation.prepare(image) }).value else { return }
                    await model.upload(prepared)
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image, .svg], allowsMultipleSelection: true) { result in
            guard case let .success(urls) = result else { return }
            Task { await importFiles(urls) }
        }
    }

    private func sourceLabel(_ title: String, systemImage: String) -> some View {
        VStack(spacing: Spacing.xs) {
            Image(systemName: systemImage).font(.system(size: 22))
            Text(title).font(.dsFootnote)
        }
        .foregroundStyle(Palette.foreground)
        .frame(maxWidth: .infinity, minHeight: 72)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
    }

    @ViewBuilder private var stockResults: some View {
        if !configured {
            InlineNotice("Stock photos aren't set up on this server. Its admin can add Unsplash or Pexels keys.", tone: .info)
        } else if let searchError {
            InlineNotice(searchError, tone: .error, actionTitle: "Try again") { Task { await search() } }
        } else if searching, results.isEmpty {
            TileGrid(minimum: 104) {
                ForEach(0..<6, id: \.self) { _ in
                    ShimmerPlaceholder().aspectRatio(1, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                }
            }
        } else if results.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(Self.suggestions, id: \.self) { suggestion in
                        ChipButton(suggestion) {
                            query = suggestion
                            Task { await search() }
                        }
                    }
                }
            }
        } else {
            TileGrid(minimum: 104) {
                ForEach(results) { photo in
                    Button {
                        Task { await model.insertStock(photo) }
                    } label: {
                        RemoteImage(photo.thumbUrl, maxPixel: 360)
                            .frame(minWidth: 0, maxWidth: .infinity)
                            .aspectRatio(1, contentMode: .fill)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            .overlay(alignment: .bottomLeading) {
                                Text(photo.author)
                                    .font(DSFont.sans(10, weight: .medium, relativeTo: .caption2))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 3)
                                    .background(.black.opacity(0.45), in: Capsule())
                                    .padding(6)
                            }
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel(photo.description.isEmpty ? photo.credit : "\(photo.description). \(photo.credit)")
                    .contextMenu {
                        if let url = URL(string: photo.sourceUrl) {
                            Link(destination: url) { Label("View on \(photo.provider.capitalized)", systemImage: "safari") }
                        }
                        if let url = URL(string: photo.authorUrl) {
                            Link(destination: url) { Label("About \(photo.author)", systemImage: "person") }
                        }
                    }
                }
            }
            Text("Photos from Unsplash and Pexels. Each one is credited in its layer.")
                .font(.dsCaption)
                .foregroundStyle(Palette.muted)
        }
    }

    private func setOrientation(_ value: String?) {
        orientation = value
        if !query.trimmingCharacters(in: .whitespaces).isEmpty { Task { await search() } }
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        searching = true
        searchError = nil
        defer { searching = false }
        do {
            let result = try await model.api.searchStock(query: text, orientation: orientation, count: 30)
            configured = true
            results = result.photos
        } catch {
            let mapped = DesynError(error)
            if mapped.code == "NOT_CONFIGURED" {
                configured = false
            } else {
                searchError = mapped.isTransient ? "You're offline. Connect to search stock photos." : mapped.message
            }
        }
    }

    private func importPicked(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                model.errorMessage = "A photo couldn't be read. Try another one."
                continue
            }
            let type = item.supportedContentTypes.first
            guard let prepared = await Task.detached(priority: .userInitiated, operation: { ImagePreparation.prepare(data: data, fileName: nil, type: type) }).value else {
                model.errorMessage = "A photo couldn't be prepared. Try another one."
                continue
            }
            await model.upload(prepared)
        }
    }

    private func importFiles(_ urls: [URL]) async {
        for url in urls {
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else {
                model.errorMessage = "\(url.lastPathComponent) couldn't be read."
                continue
            }
            let type = UTType(filenameExtension: url.pathExtension)
            let name = url.lastPathComponent
            guard let prepared = await Task.detached(priority: .userInitiated, operation: { ImagePreparation.prepare(data: data, fileName: name, type: type) }).value else {
                model.errorMessage = "\(name) isn't an image Desyn can use."
                continue
            }
            await model.upload(prepared)
        }
    }
}

/// The system camera (photos only).
struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier]
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onCapture(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
