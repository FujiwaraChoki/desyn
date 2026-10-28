import DesignSystem
import DesynKit
import Foundation

/// An undoable step: the ops that revert it (applied without normalizing, DOCUMENT_MODEL section 5).
struct HistoryEntry: Sendable {
    let label: String
    let opsJSON: String
    /// The server AI run this step reverts (its transactions arrive as remote transactions).
    var runId: String? = nil
}

/// Undo / redo. The model keeps its own stacks (each step is an async engine + sync operation) and mirrors
/// them into `undoManager`, so the system gestures work: shake to undo, three-finger swipe / double tap, and
/// the keyboard shortcuts of a hardware keyboard. Steps run strictly in order on `historyTail`.
extension EditorModel {
    private enum Direction {
        case undo, redo
    }

    /// Records a new local edit.
    func recordHistory(_ commit: LocalCommit) {
        pushHistory(HistoryEntry(label: commit.label, opsJSON: commit.undoOpsJSON))
    }

    private func pushHistory(_ entry: HistoryEntry) {
        undoStack.append(entry)
        if undoStack.count > 200 { undoStack.removeFirst(undoStack.count - 200) }
        redoStack.removeAll()
        undoManager.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated { target.undoFromManager() }
        }
        undoManager.setActionName(entry.label)
        updateHistoryState()
    }

    // MARK: AI runs (added by the ios features agent)

    /// Records the transactions of the server AI run `runId` (started from this editor) as one undo step labelled
    /// `label`, kept on top of the undo stack while the run works (DOCUMENT_MODEL section 6: transactions with the
    /// same `actor.runId` group into one undo step). Collaborators' runs are never tracked.
    public func trackRunUndo(runId: String, label: String) {
        trackedRuns[runId] = label
    }

    /// The run whose changes the next undo reverts, if the top step is an AI run.
    public var undoableRunId: String? {
        guard canUndo else { return nil }
        return undoStack.last?.runId
    }

    /// One remote transaction applied (with its inverse): extends the tracked run's undo step.
    func recordRunStep(_ tx: DesignTransaction, inverseJSON: String) {
        guard let runId = tx.actor?["runId"]?.stringValue, let label = trackedRuns[runId],
              let inverse = try? DesignTransaction(jsonString: inverseJSON), !inverse.ops.isEmpty
        else { return }
        // Later transactions are reverted first.
        var ops = inverse.ops
        if let index = undoStack.lastIndex(where: { $0.runId == runId }) {
            ops += (try? Op.parseList(undoStack[index].opsJSON)) ?? []
            undoStack.remove(at: index)
            undoStack.append(HistoryEntry(label: label, opsJSON: Op.serialize(ops), runId: runId))
            updateHistoryState()
        } else {
            pushHistory(HistoryEntry(label: label, opsJSON: Op.serialize(ops), runId: runId))
        }
    }

    /// Toolbar / keyboard undo.
    public func undo() {
        guard canUndo else { return }
        if undoManager.canUndo {
            undoManager.undo()
        } else {
            enqueue(.undo)
        }
        Haptics.light()
    }

    public func redo() {
        guard canRedo else { return }
        if undoManager.canRedo {
            undoManager.redo()
        } else {
            enqueue(.redo)
        }
        Haptics.light()
    }

    /// Invoked by `undoManager.undo()`: registers the matching redo synchronously, then runs the step.
    private func undoFromManager() {
        let label = undoStack.last?.label ?? ""
        undoManager.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated { target.redoFromManager() }
        }
        undoManager.setActionName(label)
        enqueue(.undo)
    }

    private func redoFromManager() {
        let label = redoStack.last?.label ?? ""
        undoManager.registerUndo(withTarget: self) { target in
            MainActor.assumeIsolated { target.undoFromManager() }
        }
        undoManager.setActionName(label)
        enqueue(.redo)
    }

    private func enqueue(_ direction: Direction) {
        let previous = historyTail
        historyTail = Task { [weak self] in
            await previous?.value
            await self?.run(direction)
        }
    }

    private func run(_ direction: Direction) async {
        guard let sync else { return }
        if editingTextId != nil { endTextEditing() }
        switch direction {
        case .undo:
            guard let entry = undoStack.popLast() else { return }
            do {
                if let local = try await sync.commit(opsJSON: entry.opsJSON, label: "Undo \(entry.label)", normalize: false) {
                    redoStack.append(HistoryEntry(label: entry.label, opsJSON: local.undoOpsJSON))
                }
            } catch {
                session.toasts.show("Couldn't undo. \(DesynError(error).message)", tone: .error)
            }
        case .redo:
            guard let entry = redoStack.popLast() else { return }
            do {
                if let local = try await sync.commit(opsJSON: entry.opsJSON, label: entry.label, normalize: false) {
                    undoStack.append(HistoryEntry(label: entry.label, opsJSON: local.undoOpsJSON))
                }
            } catch {
                session.toasts.show("Couldn't redo. \(DesynError(error).message)", tone: .error)
            }
        }
        updateHistoryState()
    }

    func updateHistoryState() {
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        undoLabel = undoStack.last?.label
        redoLabel = redoStack.last?.label
    }
}
