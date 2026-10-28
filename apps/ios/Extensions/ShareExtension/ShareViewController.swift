import DesignSystem
import SwiftUI
import UIKit

/// Principal class of the share extension: hosts the SwiftUI import sheet.
@objc(ShareViewController)
final class ShareViewController: UIViewController {
    private let importer = ShareImporter()

    override func viewDidLoad() {
        super.viewDidLoad()
        DSFont.registerFonts()
        let root = ShareImportView(importer: importer, close: { [weak self] in self?.finish() })
        let host = UIHostingController(rootView: root)
        host.view.backgroundColor = .clear
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        view.backgroundColor = UIPalette.background
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task { await importer.read(items) }
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}

/// The import sheet: what came in, the new design's name, progress and the result.
struct ShareImportView: View {
    let importer: ShareImporter
    let close: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            OrbsBackground(intensity: 0.5)
            VStack(alignment: .leading, spacing: Spacing.xl) {
                HStack {
                    SunMark(size: 22)
                    Spacer()
                    Button("Cancel", action: close)
                        .font(DSFont.sans(16, weight: .semibold, relativeTo: .body))
                        .foregroundStyle(Palette.sun)
                        .frame(minHeight: Spacing.touchTarget)
                }
                content
                Spacer(minLength: 0)
            }
            .padding(Spacing.gutter)
        }
        .preferredColorScheme(.dark)
        .tint(Palette.sun)
    }

    @ViewBuilder private var content: some View {
        switch importer.phase {
        case .reading:
            LoadingState("Reading what you shared")
        case .empty:
            EmptyStateView("nothing to *import*.", message: "Share photos or a PDF to turn them into a Desyn design.", systemImage: "photo.on.rectangle", actionTitle: "Close", action: close)
        case .signedOut:
            EmptyStateView("sign in *first*.", message: "Open Desyn and sign in, then share again.", systemImage: "person.crop.circle", actionTitle: "Close", action: close)
        case .ready:
            ready
        case let .importing(done, total):
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SerifHeadline("bringing it *in*", size: 34)
                ProgressView(value: Double(done), total: Double(max(1, total)))
                    .tint(Palette.sun)
                Text(done < total ? "Uploading \(done + 1) of \(total)" : "Creating the design")
                    .font(.dsCallout)
                    .foregroundStyle(Palette.muted)
                SunSpinner(size: 32)
            }
        case let .finished(name):
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SerifHeadline("saved to *desyn*", size: 34)
                Text("\u{201C}\(name)\u{201D} is in your library. Open Desyn to start designing.")
                    .font(.dsBody)
                    .foregroundStyle(Palette.muted)
                DSButton("Done", systemImage: "checkmark", kind: .primary, size: .large, action: close)
            }
            .onAppear { Haptics.success() }
        case let .failed(message):
            VStack(alignment: .leading, spacing: Spacing.lg) {
                SerifHeadline("that didn't *work*", size: 34)
                Text(message).font(.dsBody).foregroundStyle(Palette.muted)
                DSButton("Try again", systemImage: "arrow.clockwise", kind: .primary) {
                    Task { await importer.importDesign() }
                }
                DSButton("Close", kind: .ghost, action: close)
            }
        }
    }

    private var ready: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            SerifHeadline(importer.isPDF ? "a document, *ready*" : "new design from *\(importer.sources.count == 1 ? "a photo" : "\(importer.sources.count) photos")*", size: 30)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(importer.sources) { source in
                        Image(uiImage: source.preview)
                            .resizable()
                            .scaledToFill()
                            .frame(width: 96, height: 120)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
                            .accessibilityHidden(true)
                    }
                }
            }
            DSTextField("Design name", text: Binding(get: { importer.designName }, set: { importer.designName = $0 }), prompt: "Name", kind: .plain, submitLabel: .done)
            Text(importer.isPDF ? "Each page becomes a page of the design." : "Each photo becomes its own page, ready to design on.")
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
            DSButton("Create design", kind: .primary, size: .large) {
                Task { await importer.importDesign() }
            }
        }
    }
}
