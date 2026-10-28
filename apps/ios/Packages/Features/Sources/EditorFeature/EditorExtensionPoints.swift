import CoreGraphics
import DesynEngine
import DesynKit
import Foundation
import SwiftUI

// Extension points of the editor for feature modules that live outside this package (apps/ios/Features/*:
// inspector, insert / assets, AI dock, export, share, comments, version history). The app's composition root
// registers an `EditorExtensions` value once at launch; `EditorView` places the views it provides. Without a
// registration the editor shows its built-in chrome only.

/// Views the editor embeds from feature modules. Each closure receives the open design's model.
public struct EditorExtensions {
    public typealias Slot = @MainActor (EditorModel) -> AnyView

    /// Trailing items of the top bar (share, export, comments, more).
    public var topBarTrailing: Slot?
    /// Extra buttons at the end of the tool dock (insert elements, photos, brand).
    public var dockAccessory: Slot?
    /// Above the selection bar and the tool dock (the AI prompt bar).
    public var bottomAccessory: Slot?
    /// Between the canvas and the chrome, full screen (comment pins, AI highlights) and the host of feature sheets.
    public var canvasOverlay: Slot?
    /// Replaces the built-in inspector sheet content.
    public var inspector: Slot?

    public init(
        topBarTrailing: Slot? = nil,
        dockAccessory: Slot? = nil,
        bottomAccessory: Slot? = nil,
        canvasOverlay: Slot? = nil,
        inspector: Slot? = nil
    ) {
        self.topBarTrailing = topBarTrailing
        self.dockAccessory = dockAccessory
        self.bottomAccessory = bottomAccessory
        self.canvasOverlay = canvasOverlay
        self.inspector = inspector
    }

    /// Set once by the app at launch, before the first editor opens; the environment default.
    nonisolated(unsafe) public static var registered = EditorExtensions()
}

private struct EditorExtensionsKey: EnvironmentKey {
    static var defaultValue: EditorExtensions { EditorExtensions.registered }
}

public extension EnvironmentValues {
    /// The editor's feature views (defaults to `EditorExtensions.registered`).
    var editorExtensions: EditorExtensions {
        get { self[EditorExtensionsKey.self] }
        set { self[EditorExtensionsKey.self] = newValue }
    }
}

/// The public surface feature modules use to read and edit the open design. Every edit is one transaction (one
/// undo step) through the editor's sync session, exactly like the built-in commands.
public extension EditorModel {
    /// Convex `designs` id of the open design.
    var designId: String { route.designId }

    /// The Rust engine holding the working copy (render, export, describe, bounds, fonts).
    var designEngine: DesynEngine { engine }

    /// Applies `ops` as one undoable transaction; false when nothing was committed (view only, all dropped).
    @discardableResult
    func apply(_ ops: [Op], label: String) async -> Bool {
        guard !ops.isEmpty else { return false }
        return await commit(ops, label: label)
    }

    /// Applies JSON `Op[]` (engine helpers such as `transformOps`) as one undoable transaction.
    @discardableResult
    func apply(opsJSON: String, label: String) async -> Bool {
        guard opsJSON != "[]" else { return false }
        return await commit(opsJSON: opsJSON, label: label)
    }

    /// Shows `ops` live without committing (sliders, pickers); the next preview or `apply` replaces it.
    func applyPreview(_ ops: [Op]) async {
        guard !ops.isEmpty else { return }
        await preview(opsJSON: Op.serialize(ops))
    }

    /// Shows JSON `Op[]` live without committing.
    func applyPreview(opsJSON: String) async {
        await preview(opsJSON: opsJSON)
    }

    /// The current state of node `id` (working copy, including pending edits).
    func lookupNode(_ id: String) -> Node? { node(id) }

    /// `id` and its descendants, parent first.
    func lookupSubtree(_ id: String) -> [Node] { subtree(id) }

    /// The selection without nodes whose ancestor is selected too.
    var topLevelSelectionIds: [String] { topLevelSelection }

    /// Asset references known to the editor (design assets plus uploads of this session).
    var knownAssets: [String: AssetRef] { assetRefs }

    /// Hands asset bytes to the engine and records the reference (call before committing nodes that use it).
    func registerAsset(_ ref: AssetRef, data: Data?) async {
        assetRefs[ref.id] = ref
        if let data {
            if ref.kind == "font" {
                if let faces = try? await engine.setFont(data, family: ref.family), !faces.isEmpty {
                    await relayoutThroughSync()
                }
            } else {
                await engine.setAsset(ref.id, data: data)
            }
        }
        canvas?.documentDidChange()
    }

    /// Registers font bytes for `family` (Google Fonts loaded on demand), re-lays out text that uses it and shares
    /// the derived geometry like the built-in font loading does. False when the bytes are not a usable font.
    @discardableResult
    func registerFont(_ data: Data, family: String) async -> Bool {
        guard let faces = try? await engine.setFont(data, family: family), !faces.isEmpty else { return false }
        await relayoutThroughSync()
        canvas?.documentDidChange()
        return true
    }

    /// Text measured with a newly registered font: relayout through the sync queue (exact inverse, never between a
    /// rebase's rewind and replay), like the built-in font loading. Before sync starts, opening relayouts anyway.
    private func relayoutThroughSync() async {
        guard let sync else { return }
        _ = try? await sync.relayout()
    }

    /// Center of the visible part of the current page (where inserted elements go).
    func visibleCenter() -> DesignPoint? {
        canvas?.visiblePageCenter()
    }

    /// The canvas viewport (page px -> view points via `pageToView`), nil before the canvas is laid out.
    var canvasViewport: Viewport? { canvas?.viewport }

    /// Page-space bounds of `id` (rotated box), nil for unknown or empty nodes.
    func pageBounds(of id: String) -> OrientedBox? {
        try? engine.core.nodeBounds(id: id)
    }

    /// JSON of the whole working copy (export fallbacks, version compare).
    func designSnapshotJSON() async throws -> String {
        try await engine.snapshot(canonical: false)
    }
}
