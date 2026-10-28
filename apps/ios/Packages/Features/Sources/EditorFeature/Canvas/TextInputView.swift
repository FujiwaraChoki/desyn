import DesignSystem
import DesynEngine
import DesynKit
import UIKit

/// A position in the edited text: a UTF-16 offset (the engine's text offsets are UTF-16 too).
final class EngineTextPosition: UITextPosition {
    let offset: Int

    init(_ offset: Int) {
        self.offset = offset
    }
}

final class EngineTextRange: UITextRange {
    let lower: Int
    let upper: Int

    init(_ a: Int, _ b: Int) {
        lower = min(a, b)
        upper = max(a, b)
    }

    override var start: UITextPosition { EngineTextPosition(lower) }
    override var end: UITextPosition { EngineTextPosition(upper) }
    override var isEmpty: Bool { lower == upper }
    var range: Range<Int> { lower..<upper }
}

final class EngineSelectionRect: UITextSelectionRect {
    private let _rect: CGRect
    private let _containsStart: Bool
    private let _containsEnd: Bool

    init(rect: CGRect, containsStart: Bool, containsEnd: Bool) {
        _rect = rect
        _containsStart = containsStart
        _containsEnd = containsEnd
    }

    override var rect: CGRect { _rect }
    override var writingDirection: NSWritingDirection { .natural }
    override var containsStart: Bool { _containsStart }
    override var containsEnd: Bool { _containsEnd }
    override var isVertical: Bool { false }
}

/// Native text editing over the canvas: implements `UITextInput` (keyboard, IME marked text, dictation,
/// hardware keyboard, the system selection UI through `UITextInteraction`) on top of the engine's text layout.
/// The text itself is drawn by the engine: every change is applied as a live preview, and committed as one
/// transaction after 400 ms of idle typing (DOCUMENT_MODEL section 6) or when editing ends.
@MainActor
final class TextInputView: UIView, UITextInput {
    private weak var model: EditorModel?
    private weak var canvas: CanvasUIView?
    let nodeId: String

    private var runs: [TextRun] = []
    private var selected: Range<Int> = 0..<0
    private var marked: Range<Int>?
    private var layoutCache: TextLayout?
    private var dirty = false
    private var previewPending = false
    private var previewRunning = false
    private var commitTask: Task<Void, Never>?
    private let textInteraction = UITextInteraction(for: .editable)

    weak var inputDelegate: (any UITextInputDelegate)?
    var markedTextStyle: [NSAttributedString.Key: Any]?
    lazy var tokenizer: any UITextInputTokenizer = UITextInputStringTokenizer(textInput: self)

    // UITextInputTraits
    var autocapitalizationType: UITextAutocapitalizationType = .sentences
    var autocorrectionType: UITextAutocorrectionType = .default
    var spellCheckingType: UITextSpellCheckingType = .default
    var smartQuotesType: UITextSmartQuotesType = .default
    var smartDashesType: UITextSmartDashesType = .default
    var keyboardType: UIKeyboardType = .default
    var returnKeyType: UIReturnKeyType = .default

    init(model: EditorModel, canvas: CanvasUIView, nodeId: String) {
        self.model = model
        self.canvas = canvas
        self.nodeId = nodeId
        super.init(frame: canvas.bounds)
        backgroundColor = .clear
        isAccessibilityElement = true
        accessibilityTraits = [.allowsDirectInteraction]
        accessibilityLabel = "Text editor"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    private var text: String { TextRuns.text(of: runs) }
    private var length: Int { TextRuns.length(of: runs) }

    // MARK: Lifecycle

    func start(selectAll: Bool) {
        runs = model?.node(nodeId)?.runs ?? []
        selected = selectAll ? 0..<length : length..<length
        textInteraction.textInput = self
        addInteraction(textInteraction)
        becomeFirstResponder()
        layoutDidChange()
    }

    /// Commits pending typing (deleting the box when it ended up empty) and leaves editing.
    func finish() {
        commitTask?.cancel()
        commitTask = nil
        resignFirstResponder()
        guard let model else { return }
        let nodeId = self.nodeId
        let wasDirty = dirty
        dirty = false
        let finalRuns = runs
        Task {
            if TextRuns.text(of: finalRuns).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                await model.commit([.delete(id: nodeId)], label: "Delete empty text")
                model.clearSelection()
            } else if wasDirty {
                await model.commit(Self.ops(nodeId: nodeId, runs: finalRuns), label: "Edit text")
            }
        }
    }

    override var canBecomeFirstResponder: Bool { true }

    override var undoManager: UndoManager? { model?.undoManager }

    /// Only the edited box (plus a margin) takes touches; elsewhere the canvas ends editing.
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        editingViewRect().insetBy(dx: -24, dy: -24).contains(point)
    }

    // MARK: Engine sync

    func documentDidChange() {
        if !dirty && !previewRunning, let node = model?.node(nodeId) {
            let fresh = node.runs
            if fresh != runs {
                inputDelegate?.textWillChange(self)
                runs = fresh
                selected = min(selected.lowerBound, length)..<min(selected.upperBound, length)
                inputDelegate?.textDidChange(self)
            }
        }
        layoutDidChange()
    }

    func viewportDidChange() {
        layoutDidChange()
    }

    private func layoutDidChange() {
        guard let model else { return }
        layoutCache = try? model.engine.core.textLayout(nodeId: nodeId)
        canvas?.overlay.editingBox = layoutCache.map { OrientedBox(transform: $0.transform, width: $0.width, height: $0.height) }
        inputDelegate?.selectionWillChange(self)
        inputDelegate?.selectionDidChange(self)
    }

    private static func ops(nodeId: String, runs: [TextRun]) -> [Op] {
        [.update(id: nodeId, set: ["runs": .array(runs.map(\.jsonValue))], unset: [])]
    }

    /// Replaces `range` with `string`, previews the result and schedules the commit.
    private func edit(_ range: Range<Int>, with string: String, selection newSelection: Range<Int>) {
        inputDelegate?.textWillChange(self)
        runs = TextRuns.replace(in: runs, range: range, with: string)
        selected = newSelection.clamped(to: 0..<(length + 1))
        inputDelegate?.textDidChange(self)
        dirty = true
        schedulePreview()
        scheduleCommit()
    }

    private func schedulePreview() {
        previewPending = true
        guard !previewRunning, let model else { return }
        previewRunning = true
        Task { [weak self] in
            while let self, self.previewPending {
                self.previewPending = false
                await model.preview(opsJSON: Op.serialize(Self.ops(nodeId: self.nodeId, runs: self.runs)))
            }
            self?.previewRunning = false
            self?.layoutDidChange()
        }
    }

    private func scheduleCommit() {
        commitTask?.cancel()
        commitTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self, self.dirty, let model = self.model else { return }
            // Wait for the latest preview so the commit carries exactly what is on screen.
            while self.previewRunning {
                try? await Task.sleep(for: .milliseconds(10))
            }
            guard !Task.isCancelled, self.dirty else { return }
            self.dirty = false
            await model.commit(Self.ops(nodeId: self.nodeId, runs: self.runs), label: "Edit text")
            self.layoutDidChange()
        }
    }

    // MARK: Geometry (box-local -> page -> view)

    private func toView(_ rect: DesignRect) -> CGRect {
        guard let layout = layoutCache, let viewport = canvas?.viewport else { return .zero }
        let transform = layout.transform.cgAffineTransform.concatenating(viewport.pageToView)
        return rect.cgRect.applying(transform)
    }

    private func editingViewRect() -> CGRect {
        guard let layout = layoutCache else { return .zero }
        return toView(DesignRect(x: 0, y: 0, width: layout.width, height: max(layout.height, layout.contentHeight)))
    }

    private func clamp(_ offset: Int) -> Int {
        min(max(0, offset), length)
    }

    private func engineClamp(_ offset: Int) -> UInt32 {
        UInt32(min(max(0, offset), Int(layoutCache?.length ?? UInt32(length))))
    }

    // MARK: UIKeyInput

    var hasText: Bool { length > 0 }

    func insertText(_ string: String) {
        let range = marked ?? selected
        marked = nil
        let end = range.lowerBound + string.utf16.count
        edit(range, with: string, selection: end..<end)
    }

    func deleteBackward() {
        if let marked {
            self.marked = nil
            edit(marked, with: "", selection: marked.lowerBound..<marked.lowerBound)
            return
        }
        if !selected.isEmpty {
            edit(selected, with: "", selection: selected.lowerBound..<selected.lowerBound)
            return
        }
        guard selected.lowerBound > 0 else { return }
        let character = (text as NSString).rangeOfComposedCharacterSequence(at: selected.lowerBound - 1)
        let range = character.location..<(character.location + character.length)
        edit(range, with: "", selection: range.lowerBound..<range.lowerBound)
    }

    // MARK: UITextInput: text and ranges

    func text(in range: UITextRange) -> String? {
        guard let range = range as? EngineTextRange else { return nil }
        return TextRuns.substring(of: runs, range: clamp(range.lower)..<clamp(range.upper))
    }

    func replace(_ range: UITextRange, withText string: String) {
        guard let range = range as? EngineTextRange else { return }
        let lower = clamp(range.lower)
        let end = lower + string.utf16.count
        edit(lower..<clamp(range.upper), with: string, selection: end..<end)
    }

    var selectedTextRange: UITextRange? {
        get { EngineTextRange(selected.lowerBound, selected.upperBound) }
        set {
            guard let range = newValue as? EngineTextRange else { return }
            inputDelegate?.selectionWillChange(self)
            selected = clamp(range.lower)..<clamp(range.upper)
            inputDelegate?.selectionDidChange(self)
        }
    }

    var markedTextRange: UITextRange? {
        marked.map { EngineTextRange($0.lowerBound, $0.upperBound) }
    }

    func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
        let range = marked ?? selected
        let string = markedText ?? ""
        let base = range.lowerBound
        let selection = (base + selectedRange.location)..<(base + selectedRange.location + selectedRange.length)
        edit(range, with: string, selection: selection)
        marked = string.isEmpty ? nil : base..<(base + string.utf16.count)
    }

    func unmarkText() {
        marked = nil
    }

    var beginningOfDocument: UITextPosition { EngineTextPosition(0) }
    var endOfDocument: UITextPosition { EngineTextPosition(length) }

    func textRange(from fromPosition: UITextPosition, to toPosition: UITextPosition) -> UITextRange? {
        guard let from = fromPosition as? EngineTextPosition, let to = toPosition as? EngineTextPosition else { return nil }
        return EngineTextRange(clamp(from.offset), clamp(to.offset))
    }

    func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
        guard let position = position as? EngineTextPosition else { return nil }
        let target = position.offset + offset
        guard target >= 0, target <= length else { return nil }
        return EngineTextPosition(target)
    }

    func position(from position: UITextPosition, in direction: UITextLayoutDirection, offset: Int) -> UITextPosition? {
        guard let position = position as? EngineTextPosition, let model, offset > 0 else {
            return (position as? EngineTextPosition).map { EngineTextPosition($0.offset) }
        }
        let movement: TextMovement
        switch direction {
        case .left: movement = .left
        case .right: movement = .right
        case .up: movement = .up
        case .down: movement = .down
        @unknown default: return nil
        }
        var current = TextPosition(index: engineClamp(position.offset), affinity: .downstream)
        let column = (try? model.engine.core.textCaret(nodeId: nodeId, position: current))?.x
        for _ in 0..<offset {
            guard let next = try? model.engine.core.textMove(nodeId: nodeId, position: current, movement: movement, x: column) else { break }
            current = next
        }
        return EngineTextPosition(clamp(Int(current.index)))
    }

    func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
        let a = (position as? EngineTextPosition)?.offset ?? 0
        let b = (other as? EngineTextPosition)?.offset ?? 0
        if a < b { return .orderedAscending }
        if a > b { return .orderedDescending }
        return .orderedSame
    }

    func offset(from: UITextPosition, to toPosition: UITextPosition) -> Int {
        ((toPosition as? EngineTextPosition)?.offset ?? 0) - ((from as? EngineTextPosition)?.offset ?? 0)
    }

    func position(within range: UITextRange, farthestIn direction: UITextLayoutDirection) -> UITextPosition? {
        guard let range = range as? EngineTextRange else { return nil }
        switch direction {
        case .left, .up: return EngineTextPosition(range.lower)
        case .right, .down: return EngineTextPosition(range.upper)
        @unknown default: return EngineTextPosition(range.upper)
        }
    }

    func characterRange(byExtending position: UITextPosition, in direction: UITextLayoutDirection) -> UITextRange? {
        guard let position = position as? EngineTextPosition else { return nil }
        switch direction {
        case .left, .up: return EngineTextRange(clamp(position.offset - 1), position.offset)
        case .right, .down: return EngineTextRange(position.offset, clamp(position.offset + 1))
        @unknown default: return EngineTextRange(position.offset, position.offset)
        }
    }

    func baseWritingDirection(for position: UITextPosition, in direction: UITextStorageDirection) -> NSWritingDirection {
        .natural
    }

    func setBaseWritingDirection(_ writingDirection: NSWritingDirection, for range: UITextRange) {
        // Direction comes from ParagraphStyle.direction (auto by default); the inspector owns it.
    }

    // MARK: UITextInput: geometry

    func firstRect(for range: UITextRange) -> CGRect {
        selectionRects(for: range).first?.rect ?? caretRect(for: range.start)
    }

    func caretRect(for position: UITextPosition) -> CGRect {
        guard let model, let position = position as? EngineTextPosition else { return .zero }
        let index = engineClamp(position.offset)
        guard let caret = try? model.engine.core.textCaret(nodeId: nodeId, position: TextPosition(index: index, affinity: .downstream)) else {
            return .zero
        }
        let rect = toView(DesignRect(x: caret.x, y: caret.y, width: 0, height: caret.height))
        return CGRect(x: rect.midX - 1, y: rect.minY, width: 2, height: max(rect.height, 8))
    }

    func selectionRects(for range: UITextRange) -> [UITextSelectionRect] {
        guard let model, let range = range as? EngineTextRange, !range.isEmpty else { return [] }
        let engineRange = TextRange(start: engineClamp(range.lower), end: engineClamp(range.upper))
        guard let rects = try? model.engine.core.textSelectionRects(nodeId: nodeId, range: engineRange) else { return [] }
        return rects.enumerated().map { index, rect in
            EngineSelectionRect(rect: toView(rect), containsStart: index == 0, containsEnd: index == rects.count - 1)
        }
    }

    func closestPosition(to point: CGPoint) -> UITextPosition? {
        guard let model, let canvas else { return nil }
        guard let position = try? model.engine.core.textHitTest(nodeId: nodeId, point: canvas.pagePoint(point)) else {
            return EngineTextPosition(length)
        }
        return EngineTextPosition(clamp(Int(position.index)))
    }

    func closestPosition(to point: CGPoint, within range: UITextRange) -> UITextPosition? {
        guard let range = range as? EngineTextRange, let position = closestPosition(to: point) as? EngineTextPosition else { return nil }
        return EngineTextPosition(min(max(position.offset, range.lower), range.upper))
    }

    func characterRange(at point: CGPoint) -> UITextRange? {
        guard let position = closestPosition(to: point) as? EngineTextPosition else { return nil }
        let start = min(position.offset, max(0, length - 1))
        return EngineTextRange(start, clamp(start + 1))
    }
}
