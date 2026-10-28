import DesignSystem
import DesynKit
import EditorFeature
import Foundation
import Observation
import PanelKit
import SharedKit

/// The AI dock of one open design: starts agent runs (`ai/agent:startRun`) with the selection as context, follows
/// their event log live (`ai/agent:runEvents`), answers questions, cancels, and drives the canvas highlights: a
/// soft pulse on the layers the agent touches while it works, then a sunrise sweep when it finishes.
@MainActor
@Observable
public final class AIDockModel {
    public let editor: EditorModel
    public let context: EditorContext

    public var prompt = ""
    public var mode: AIMode = .edit
    /// Send the selection as the agent's focus.
    public var useSelection = true
    public private(set) var run: AIRun?
    public private(set) var timeline = AIRunTimeline()
    public private(set) var starting = false
    public var errorMessage: String?
    public private(set) var estimate: AIEstimate?
    /// Earlier runs on this design (newest first) for the history menu.
    public private(set) var history: [AIRun] = []

    @ObservationIgnored private var follow: Task<Void, Never>?
    @ObservationIgnored private var lastTouchedCount = 0

    public init(editor: EditorModel, context: EditorContext) {
        self.editor = editor
        self.context = context
    }

    /// Ideas shown before the first run (they describe outcomes, so the agent plans the steps).
    public static let suggestions: [(title: String, prompt: String, mode: AIMode)] = [
        ("Make it premium", "Make this design feel more premium: refine the type hierarchy, spacing and palette. Keep the copy.", .edit),
        ("Fix the layout", "Tidy the layout: align elements to a clear grid, even out the spacing and fix anything that overflows.", .edit),
        ("Warmer colors", "Shift the palette warmer and more inviting while keeping enough contrast for every text.", .edit),
        ("Rewrite the copy", "Rewrite the text to be shorter and clearer, in a calm, confident voice. Keep the structure.", .edit),
        ("Add a photo", "Add a fitting photo that supports the message and integrate it into the layout.", .edit),
        ("Review it", "Critique this design: hierarchy, contrast, spacing, alignment and copy. List the most important fixes.", .critique),
    ]

    public var isRunning: Bool { run.map { $0.phase.isActive } ?? starting }
    public var isWaiting: Bool { run?.phase == .waitingForAnswer }
    public var canSend: Bool {
        editor.canEdit && !isRunning && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// One-line state for the collapsed prompt bar.
    public var statusLine: String? {
        guard let run else { return starting ? "Starting" : nil }
        switch run.phase {
        case .queued: return timeline.activity ?? "Queued"
        case .running: return timeline.activity ?? "Working"
        case .waitingForAnswer: return "Waiting for your answer"
        case .completed: return "Done · \(timeline.touched.count) layer\(timeline.touched.count == 1 ? "" : "s") changed"
        case .cancelled: return "Stopped"
        case let .stopped(reason): return reason
        case .failed: return run.error ?? "The run failed"
        }
    }

    // MARK: Lifecycle

    /// Called when the dock appears: picks up a queued prompt (Shortcuts, brand panel) or the latest active run.
    public func appear() async {
        if let queued = context.queuedPrompt {
            context.queuedPrompt = nil
            prompt = queued.text
            mode = queued.mode
            await send()
            return
        }
        if run == nil, let runId = context.activeRunId {
            resume(runId: runId)
        }
        await refreshHistory()
        if estimate == nil { estimate = try? await editor.session.api.aiEstimate(mode: mode) }
    }

    public func refreshHistory() async {
        if let runs = try? await editor.session.api.aiRuns(designId: editor.designId, limit: 15) {
            history = runs.filter { $0.kind == "agent" }
            if run == nil, let active = history.first(where: { $0.phase.isActive || $0.phase == .waitingForAnswer }) {
                resume(runId: active.id)
            }
        }
    }

    public func modeChanged() {
        Task { estimate = try? await editor.session.api.aiEstimate(mode: mode) }
    }

    // MARK: Runs

    public func send() async {
        let goal = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !goal.isEmpty, !isRunning else { return }
        guard editor.canEdit else {
            errorMessage = "This design is view only, so the AI can't edit it."
            return
        }
        starting = true
        errorMessage = nil
        defer { starting = false }
        let selection = useSelection ? editor.topLevelSelectionIds : []
        do {
            let runId = try await editor.session.api.startAIRun(
                designId: editor.designId,
                goal: goal,
                mode: mode,
                pageId: editor.currentPage?.id,
                selection: selection,
                previousRunId: run?.phase.isTerminal == true ? run?.id : nil
            )
            // The run edits on the server; its transactions arrive as remote ones and become one undo step here.
            editor.trackRunUndo(runId: runId, label: AIRunTimeline.undoLabel(goal: goal))
            prompt = ""
            Haptics.light()
            timeline = AIRunTimeline(goal: goal)
            lastTouchedCount = 0
            context.pulse(selection)
            startFollowing(runId: runId)
        } catch {
            errorMessage = Self.message(for: DesynError(error))
            Haptics.error()
        }
    }

    /// Follows an existing run (reopened dock, run started elsewhere).
    public func resume(runId: String) {
        guard run?.id != runId else { return }
        timeline = AIRunTimeline()
        lastTouchedCount = 0
        startFollowing(runId: runId)
    }

    public func cancel() async {
        guard let run else { return }
        do {
            try await editor.session.api.cancelAIRun(runId: run.id)
        } catch {
            errorMessage = DesynError(error).message
        }
    }

    public func answer(_ text: String) async {
        guard let run, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do {
            try await editor.session.api.answerAIRun(runId: run.id, answer: text)
        } catch {
            errorMessage = DesynError(error).message
        }
    }

    /// Starts a fresh conversation.
    public func reset() {
        follow?.cancel()
        follow = nil
        run = nil
        timeline = AIRunTimeline()
        context.activeRunId = nil
        context.clearHighlights()
    }

    public func stop() {
        follow?.cancel()
        follow = nil
    }

    private func startFollowing(runId: String) {
        follow?.cancel()
        context.activeRunId = runId
        let api = editor.session.api
        follow = Task { [weak self] in
            var after: Int?
            var failures = 0
            while !Task.isCancelled {
                var fullPage = false
                do {
                    for try await page in api.runEventUpdates(runId: runId, afterSeq: after) {
                        guard let self else { return }
                        failures = 0
                        self.receive(page)
                        after = Int(page.next)
                        if page.done {
                            self.finish()
                            return
                        }
                        // A full page: subscribe again after its last event to read the next ones.
                        if page.events.count >= 200 {
                            fullPage = true
                            break
                        }
                    }
                    if !fullPage { try? await Task.sleep(for: .seconds(1)) }
                } catch {
                    failures += 1
                    if failures > 3 {
                        self?.errorMessage = "Lost the connection to the AI run. It keeps going on the server; reopen the dock to follow it."
                        return
                    }
                    try? await Task.sleep(for: .seconds(Double(failures) * 2))
                }
            }
        }
    }

    private func receive(_ page: AIRunEventsPage) {
        if run?.id != page.run.id, timeline.lastIndex < 0, timeline.items.isEmpty, let goal = page.run.goal {
            // A run resumed from history: show its request first.
            timeline = AIRunTimeline(goal: goal)
        }
        run = page.run
        timeline.apply(page: page.events)
        if timeline.touched.count != lastTouchedCount {
            lastTouchedCount = timeline.touched.count
            context.pulse(Array(timeline.touched.suffix(24)))
        }
    }

    private func finish() {
        context.sunrise(timeline.touched)
        if run?.phase == .completed { Haptics.success() }
        Task { await refreshHistory() }
    }

    /// The finished run's changes are the next undo step.
    public var canUndoRun: Bool {
        guard let run, run.phase.isTerminal else { return false }
        return editor.undoableRunId == run.id
    }

    /// Reverts every change of the finished run (one undo step).
    public func undoRun() {
        guard canUndoRun else { return }
        editor.undo()
        context.clearHighlights()
    }

    /// Errors in plain words (fair-use limits explain what to do next).
    public static func message(for error: DesynError) -> String {
        switch error.code ?? "" {
        case "FEATURE_UNAVAILABLE": return "The AI agent isn't included in your plan. See your plan in Settings."
        case "LIMIT_REACHED": return "You've used this month's AI credits. They renew at the start of next month."
        case "NOT_CONFIGURED": return "No AI provider is set up on this server yet."
        case "CONFLICT": return "The AI is already working on this design. Wait for it to finish or stop it."
        case "EMAIL_NOT_VERIFIED": return "Verify your email address to use the AI."
        default: return error.message
        }
    }
}

/// One dock model per open design, so a run keeps being followed (and highlighted) while the dock sheet is closed.
@MainActor
public enum AIDocks {
    private static var models: [ObjectIdentifier: AIDockModel] = [:]

    public static func model(for editor: EditorModel) -> AIDockModel {
        let key = ObjectIdentifier(editor)
        if let existing = models[key] { return existing }
        let model = AIDockModel(editor: editor, context: EditorContext.for(editor))
        models[key] = model
        return model
    }

    /// The editor closed: stop following (the run continues on the server) and drop the model.
    public static func release(_ editor: EditorModel) {
        let key = ObjectIdentifier(editor)
        models[key]?.stop()
        models[key] = nil
    }
}
