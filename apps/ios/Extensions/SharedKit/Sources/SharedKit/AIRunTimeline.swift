import DesynKit
import Foundation

/// One stored agent event (`packages/ai/src/agent/events.ts`, compacted by Convex: long strings truncated, large
/// payloads reduced to their scalar fields). Unknown types are kept so newer servers never break the dock.
public enum AIRunEvent: Equatable, Sendable {
    case progress(label: String, detail: String?)
    case start(mode: String?, model: String?)
    case step(Int)
    case thinking(String)
    case text(String)
    case toolCall(callId: String, tool: String)
    case toolResult(callId: String, tool: String, ok: Bool, summary: String, ms: Double?)
    case appliedTransaction(label: String, applied: Int, dropped: Int, touched: [String])
    case preview(url: String?, width: Double?, height: Double?, pageId: String?)
    case plan([AIPlanStep])
    case credits(used: Double, remaining: Double?)
    case question(question: String, options: [String])
    case answer(String)
    case error(message: String, code: String?, recoverable: Bool)
    case done(status: String, summary: String, steps: Int, credits: Double)
    case workflow(type: String, label: String)
    case unknown(type: String)

    public init(json: JSONValue) {
        let type = json["type"]?.stringValue ?? ""
        func string(_ key: String) -> String? { json[key]?.stringValue }
        func number(_ key: String) -> Double? { json[key]?.doubleValue }
        switch type {
        case "progress":
            self = .progress(label: string("label") ?? "Working", detail: string("detail"))
        case "start":
            self = .start(mode: string("mode"), model: string("model"))
        case "step":
            self = .step(Int(number("step") ?? 0))
        case "thinking":
            self = .thinking(string("text") ?? "")
        case "text":
            self = .text(string("text") ?? "")
        case "tool-call":
            self = .toolCall(callId: string("callId") ?? "", tool: string("tool") ?? "")
        case "tool-result":
            self = .toolResult(
                callId: string("callId") ?? "",
                tool: string("tool") ?? "",
                ok: json["ok"]?.boolValue ?? true,
                summary: string("summary") ?? "",
                ms: number("ms")
            )
        case "applied-tx":
            let touched = (json["touched"]?.arrayValue ?? []).compactMap(\.stringValue)
            let targets: [String]
            if touched.isEmpty {
                // Compacted payloads may lose `touched`; fall back to the targets of the applied ops.
                let ops = json["ops"]?.arrayValue ?? json["tx"]?["ops"]?.arrayValue ?? []
                targets = ops.compactMap { Op(json: $0).targetID }
            } else {
                targets = touched
            }
            let applied = Int(number("applied") ?? Double(targets.count))
            let dropped = json["dropped"]?.arrayValue?.count ?? 0
            self = .appliedTransaction(
                label: json["tx"]?["label"]?.stringValue ?? "Edit",
                applied: applied,
                dropped: dropped,
                touched: Self.unique(targets)
            )
        case "preview":
            self = .preview(url: string("url"), width: number("width"), height: number("height"), pageId: string("pageId"))
        case "plan":
            let steps = (json["steps"]?.arrayValue ?? []).compactMap { step -> AIPlanStep? in
                guard let title = step["title"]?.stringValue else { return nil }
                return AIPlanStep(
                    id: step["id"]?.stringValue ?? title,
                    title: title,
                    status: step["status"]?.stringValue ?? "pending",
                    checkpoint: step["checkpoint"]?.boolValue ?? false
                )
            }
            self = .plan(steps)
        case "credits":
            self = .credits(used: number("used") ?? 0, remaining: number("remaining"))
        case "question":
            self = .question(question: string("question") ?? "", options: (json["options"]?.arrayValue ?? []).compactMap(\.stringValue))
        case "answer":
            self = .answer(string("answer") ?? "")
        case "error":
            self = .error(message: string("message") ?? "Something went wrong.", code: string("code"), recoverable: json["recoverable"]?.boolValue ?? false)
        case "done":
            self = .done(
                status: string("status") ?? "completed",
                summary: string("summary") ?? "",
                steps: Int(number("steps") ?? 0),
                credits: number("credits") ?? 0
            )
        case "workflow-step", "workflow-output", "workflow-done":
            self = .workflow(type: type, label: string("title") ?? string("label") ?? string("summary") ?? type)
        default:
            self = .unknown(type: type)
        }
    }

    private static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>()
        return ids.filter { seen.insert($0).inserted }
    }
}

/// A step of the agent's structured plan.
public struct AIPlanStep: Equatable, Hashable, Sendable, Identifiable {
    public let id: String
    public let title: String
    /// `pending` | `running` | `done` | `skipped` | `failed`.
    public let status: String
    public let checkpoint: Bool

    public init(id: String, title: String, status: String, checkpoint: Bool) {
        self.id = id
        self.title = title
        self.status = status
        self.checkpoint = checkpoint
    }
}

/// What the AI dock shows for a run: the request, the agent's words, tool steps with their state, applied changes,
/// previews, the plan, questions and the outcome. Built incrementally from events (`apply`).
public struct AIRunTimeline: Equatable, Sendable {
    public enum ToolState: Equatable, Sendable {
        case running, succeeded, failed
    }

    public enum Tone: Equatable, Sendable {
        case info, warning, error
    }

    public enum Item: Equatable, Sendable, Identifiable {
        case request(id: String, text: String)
        case message(id: String, text: String)
        case thinking(id: String, text: String)
        case tool(id: String, tool: String, title: String, state: ToolState, summary: String?)
        case change(id: String, label: String, count: Int, touched: [String])
        case preview(id: String, url: String, width: Double?, height: Double?)
        case plan(id: String, steps: [AIPlanStep])
        case question(id: String, question: String, options: [String], answer: String?)
        case notice(id: String, text: String, tone: Tone)
        case outcome(id: String, status: String, summary: String, credits: Double)

        public var id: String {
            switch self {
            case let .request(id, _), let .message(id, _), let .thinking(id, _), let .tool(id, _, _, _, _),
                 let .change(id, _, _, _), let .preview(id, _, _, _), let .plan(id, _), let .question(id, _, _, _),
                 let .notice(id, _, _), let .outcome(id, _, _, _):
                id
            }
        }
    }

    public private(set) var items: [Item] = []
    /// Layers the run changed (for the sunrise sweep), in first-touch order.
    public private(set) var touched: [String] = []
    /// Index of the last event folded in (`afterSeq` for the next subscription).
    public private(set) var lastIndex: Int = -1
    /// Latest progress label while the run works ("Queued", "Thinking", tool titles).
    public private(set) var activity: String?
    public private(set) var creditsUsed: Double = 0
    public private(set) var finished = false

    public init(goal: String? = nil) {
        if let goal, !goal.isEmpty {
            items.append(.request(id: "request", text: goal))
        }
    }

    /// Folds events of a `runEvents` page in (events at or before `lastIndex` are skipped, so overlapping pages are
    /// harmless).
    public mutating func apply(page events: [JSONValue]) {
        for raw in events {
            let index = raw["index"]?.intValue ?? (lastIndex + 1)
            guard index > lastIndex else { continue }
            lastIndex = index
            apply(AIRunEvent(json: raw), index: index)
        }
    }

    public mutating func apply(_ event: AIRunEvent, index: Int) {
        let id = "e\(index)"
        switch event {
        case let .progress(label, detail):
            activity = detail.map { "\(label) · \($0)" } ?? label
        case .start:
            activity = "Thinking"
        case .step:
            activity = "Thinking"
        case let .thinking(text):
            guard !text.isEmpty else { return }
            if case let .thinking(lastId, existing)? = items.last {
                items[items.count - 1] = .thinking(id: lastId, text: existing + text)
            } else {
                items.append(.thinking(id: id, text: text))
            }
        case let .text(text):
            guard !text.isEmpty else { return }
            if case let .message(lastId, existing)? = items.last {
                items[items.count - 1] = .message(id: lastId, text: existing + text)
            } else {
                items.append(.message(id: id, text: text))
            }
        case let .toolCall(callId, tool):
            let title = AIToolTitles.title(for: tool)
            activity = title
            items.append(.tool(id: callId.isEmpty ? id : callId, tool: tool, title: title, state: .running, summary: nil))
        case let .toolResult(callId, tool, ok, summary, _):
            let key = callId.isEmpty ? id : callId
            if let position = items.lastIndex(where: { $0.id == key }), case let .tool(_, existingTool, title, _, _) = items[position] {
                items[position] = .tool(id: key, tool: existingTool, title: title, state: ok ? .succeeded : .failed, summary: summary.isEmpty ? nil : summary)
            } else {
                items.append(.tool(id: key, tool: tool, title: AIToolTitles.title(for: tool), state: ok ? .succeeded : .failed, summary: summary.isEmpty ? nil : summary))
            }
        case let .appliedTransaction(label, applied, _, touchedIds):
            for nodeId in touchedIds where !touched.contains(nodeId) {
                touched.append(nodeId)
            }
            guard applied > 0 || !touchedIds.isEmpty else { return }
            items.append(.change(id: id, label: label, count: max(applied, touchedIds.count), touched: touchedIds))
        case let .preview(url, width, height, _):
            guard let url, !url.isEmpty else { return }
            items.append(.preview(id: id, url: url, width: width, height: height))
        case let .plan(steps):
            if let position = items.firstIndex(where: { if case .plan = $0 { return true } else { return false } }) {
                items[position] = .plan(id: items[position].id, steps: steps)
            } else {
                items.append(.plan(id: id, steps: steps))
            }
        case let .credits(used, _):
            creditsUsed = used
        case let .question(question, options):
            activity = nil
            items.append(.question(id: id, question: question, options: options, answer: nil))
        case let .answer(answer):
            if let position = items.lastIndex(where: { if case .question(_, _, _, nil) = $0 { return true } else { return false } }),
               case let .question(questionId, question, options, _) = items[position]
            {
                items[position] = .question(id: questionId, question: question, options: options, answer: answer)
            }
            activity = "Thinking"
        case let .error(message, _, recoverable):
            items.append(.notice(id: id, text: message, tone: recoverable ? .warning : .error))
        case let .done(status, summary, _, credits):
            finished = true
            activity = nil
            creditsUsed = max(creditsUsed, credits)
            // Tools still marked running never got a result (cancelled mid-step).
            items = items.map { item in
                if case let .tool(toolId, tool, title, .running, summary) = item {
                    return .tool(id: toolId, tool: tool, title: title, state: status == "completed" ? .succeeded : .failed, summary: summary)
                }
                return item
            }
            items.append(.outcome(id: id, status: status, summary: summary, credits: credits))
        case let .workflow(_, label):
            items.append(.notice(id: id, text: label, tone: .info))
        case .unknown:
            break
        }
    }

    /// The open question, when the run waits for an answer.
    public var pendingQuestion: (question: String, options: [String])? {
        for item in items.reversed() {
            if case let .question(_, question, options, nil) = item { return (question, options) }
        }
        return nil
    }

    /// Name of the undo step that reverts a run ("AI: Warmer colors"; first line, at most 40 characters).
    public static func undoLabel(goal: String) -> String {
        let line = goal.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return "AI edit" }
        let short = trimmed.count > 40 ? trimmed.prefix(39).trimmingCharacters(in: .whitespaces) + "…" : trimmed
        return "AI: \(short)"
    }

    /// One sentence for an outcome status.
    public static func outcomeTitle(_ status: String) -> String {
        switch status {
        case "completed": "Done"
        case "cancelled": "Stopped"
        case "budget-exceeded": "Stopped at the credit budget"
        case "step-limit": "Stopped at the step limit"
        case "needs-input": "Waiting for your answer"
        default: "The run failed"
        }
    }
}

/// Human titles for agent tools (`packages/ai` tool names).
public enum AIToolTitles {
    static let titles: [String: String] = [
        "read_design": "Reading the design",
        "read_selection": "Looking at the selection",
        "render_preview": "Rendering a preview",
        "query_elements": "Finding layers",
        "create_elements": "Adding layers",
        "update_elements": "Updating layers",
        "delete_elements": "Removing layers",
        "duplicate_elements": "Duplicating layers",
        "group_elements": "Grouping layers",
        "ungroup": "Ungrouping",
        "set_roles": "Labeling layers",
        "arrange": "Arranging layout",
        "set_text": "Writing copy",
        "rewrite_text": "Rewriting copy",
        "translate_text": "Translating",
        "set_style": "Styling",
        "apply_brand": "Applying the brand",
        "add_page": "Adding a page",
        "delete_page": "Removing a page",
        "reorder_pages": "Reordering pages",
        "resize_page": "Resizing the page",
        "generate_image": "Generating an image",
        "generate_svg": "Drawing a vector",
        "remove_background": "Removing the background",
        "inpaint": "Repainting part of an image",
        "outpaint": "Expanding an image",
        "upscale": "Upscaling",
        "mockup": "Creating a mockup",
        "trace_to_vector": "Tracing to vector",
        "search_stock": "Searching stock photos",
        "search_icons": "Searching icons",
        "search_templates": "Searching templates",
        "apply_template": "Applying a template",
        "critique": "Reviewing the design",
        "plan": "Planning",
        "ask_user": "Asking you",
        "run_workflow": "Starting a workflow",
        "finish": "Wrapping up",
    ]

    public static func title(for tool: String) -> String {
        if let title = titles[tool] { return title }
        let words = tool.split(separator: "_").joined(separator: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
