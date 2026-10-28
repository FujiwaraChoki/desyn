import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import Foundation
import Observation
import PanelKit
import SharedKit

/// The inspector's view model: what is selected, which sections apply, and edits that preview while a control
/// moves and commit one transaction when it settles (one undo step per change).
@MainActor
@Observable
public final class InspectorModel {
    public enum Section: String, CaseIterable, Identifiable {
        case style, text, data, arrange, position, animate

        public var id: String { rawValue }

        public var title: String {
            switch self {
            case .style: "Style"
            case .text: "Text"
            case .data: "Content"
            case .arrange: "Arrange"
            case .position: "Position"
            case .animate: "Animate"
            }
        }

        public var systemImage: String {
            switch self {
            case .style: "paintpalette"
            case .text: "textformat"
            case .data: "tablecells"
            case .arrange: "square.3.layers.3d"
            case .position: "arrow.up.and.down.and.arrow.left.and.right"
            case .animate: "play.circle"
            }
        }
    }

    public let editor: EditorModel
    public var section: Section = .style
    /// Plan gates (advanced effects, animations).
    public let context: EditorContext

    @ObservationIgnored private var settleTask: Task<Void, Never>?

    public init(editor: EditorModel) {
        self.editor = editor
        context = EditorContext.for(editor)
    }

    // MARK: Selection

    /// Selected nodes, or the current page when nothing is selected (page mode).
    public var targets: [Node] {
        if !editor.selectedNodes.isEmpty { return editor.selectedNodes }
        if let pageId = editor.currentPage?.id, let page = editor.lookupNode(pageId) { return [page] }
        return []
    }

    public var isPageMode: Bool { editor.selectedNodes.isEmpty }
    public var first: Node? { targets.first }
    public var textNodes: [Node] { targets.filter { $0.type == .text } }
    public var hasText: Bool { !textNodes.isEmpty }
    public var images: [Node] { targets.filter { $0.type == .image } }

    /// Sections that apply to the selection, in order.
    public var sections: [Section] {
        if isPageMode { return [.style, .animate] }
        var list: [Section] = [.style]
        if hasText { list.append(.text) }
        if let type = first?.type, targets.count == 1, type == .chart || type == .table || type == .qr { list.append(.data) }
        list += [.arrange, .position, .animate]
        return list
    }

    /// The visible section (falls back when the selection changes type).
    public var currentSection: Section {
        sections.contains(section) ? section : (sections.first ?? .style)
    }

    public var title: String {
        if isPageMode { return "page *\(editor.currentPageIndex + 1)*" }
        if targets.count == 1, let node = first { return node.displayName.lowercased() }
        return "\(targets.count) *layers*"
    }

    public var subtitle: String? {
        guard let node = first else { return nil }
        if isPageMode {
            return "\(Int(node.width.rounded())) × \(Int(node.height.rounded())) \(node.unit == .px ? "px" : node.unit.rawValue)"
        }
        guard targets.count == 1 else { return nil }
        return "\(node.typeName.capitalized) · \(Int(node.width.rounded())) × \(Int(node.height.rounded()))"
    }

    public var canEdit: Bool { editor.canEdit }

    // MARK: Editing

    /// Applies `build(targets)`: a preview while `final` is false, else one committed transaction.
    public func edit(_ label: String, final: Bool, _ build: @escaping ([Node]) -> [Op]) {
        let ops = build(targets)
        guard !ops.isEmpty else { return }
        settleTask?.cancel()
        if final {
            Task { await editor.apply(ops, label: label) }
        } else {
            Task { await editor.applyPreview(ops) }
            // VoiceOver adjustments and taps have no "end" event: commit after a quiet moment.
            settleTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(650))
                guard !Task.isCancelled, let self else { return }
                await self.editor.apply(build(self.targets), label: label)
            }
        }
    }

    /// Commits ops computed asynchronously (engine geometry).
    public func commit(_ label: String, opsJSON: String) async {
        settleTask?.cancel()
        await editor.apply(opsJSON: opsJSON, label: label)
    }

    // MARK: Colors

    /// Swatches: the design's named colors, then recently used ones.
    public func documentColors() async -> [(name: String, hex: String)] {
        guard let json = try? await editor.designSnapshotJSON(), let design = try? Design(jsonString: json) else { return [] }
        return design.styles.colors.map { ($0.name, $0.value) }
    }
}
