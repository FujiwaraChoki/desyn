import DesynKit
import Foundation

/// `AiRunView & { model, billing, creditsCharged, transactions, workflowId, cancelRequested }` (`ai/agent:getRun`).
public struct AIRun: Decodable, Hashable, Sendable, Identifiable {
    public struct Question: Decodable, Hashable, Sendable {
        public let question: String
        public let options: [String]
    }

    public let id: String
    /// `agent` | `asset` | `workflow`.
    public let kind: String
    public let designId: String?
    /// `queued | running | needs-input | completed | cancelled | budget-exceeded | step-limit | failed`.
    public let status: String
    public let mode: String?
    public let goal: String?
    public let question: Question?
    public let error: String?
    public let costCredits: Double
    public let steps: Double
    public let createdAt: Double
    public let updatedAt: Double
    public let finishedAt: Double?
    public let model: String?
    /// `platform` | `byok` | `local`.
    public let billing: String?
    public let creditsCharged: Double?
    public let cancelRequested: Bool?

    public var phase: AIRunPhase { AIRunPhase(status: status) }
}

/// Coarse state of a run for the UI.
public enum AIRunPhase: Equatable, Sendable {
    case queued, running, waitingForAnswer, completed, cancelled, stopped(String), failed

    public init(status: String) {
        switch status {
        case "queued": self = .queued
        case "running": self = .running
        case "needs-input": self = .waitingForAnswer
        case "completed": self = .completed
        case "cancelled": self = .cancelled
        case "budget-exceeded": self = .stopped("The run reached its credit budget.")
        case "step-limit": self = .stopped("The run reached its step limit.")
        default: self = .failed
        }
    }

    public var isActive: Bool { self == .queued || self == .running }
    public var isTerminal: Bool {
        switch self {
        case .queued, .running, .waitingForAnswer: false
        default: true
        }
    }
}

/// `ai/agent:runEvents`.
public struct AIRunEventsPage: Decodable, Sendable {
    public let run: AIRun
    public let events: [JSONValue]
    public let next: Double
    public let done: Bool
}

/// `ai/agent:estimate`.
public struct AIEstimate: Decodable, Hashable, Sendable {
    public let maxSteps: Double
    public let credits: Double
}

/// Agent modes.
public enum AIMode: String, CaseIterable, Sendable {
    case edit, generate, critique

    public var title: String {
        switch self {
        case .edit: "Edit"
        case .generate: "Generate"
        case .critique: "Critique"
        }
    }
}

/// One generated file (`ai/media:*`).
public struct GeneratedMedia: Decodable, Hashable, Sendable, Identifiable {
    /// Convex `assets` id.
    public let assetId: String
    /// `AssetRef.id` to reference from nodes.
    public let refId: String
    public let mime: String
    public let width: Double?
    public let height: Double?
    public let provider: String?
    public let model: String?
    public let costCredits: Double?
    public let url: String?

    public var id: String { assetId }
    public var isSVG: Bool { mime.contains("svg") }
}

/// `ai/media:*` result.
public struct MediaResult: Decodable, Sendable {
    public let runId: String
    public let assets: [GeneratedMedia]
}

/// `ai/prefs:get`: providers (no secrets) and per-task routing, for the read-only settings summary.
public struct AIPreferences: Decodable, Sendable {
    public struct Provider: Decodable, Hashable, Sendable, Identifiable {
        public struct Key: Decodable, Hashable, Sendable {
            public let last4: String?
            public let label: String?
            public let baseUrl: String?
            public let updatedAt: Double?
        }

        public let id: String
        public let label: String
        public let description: String?
        public let kinds: [String]
        public let byok: Bool
        public let local: Bool
        /// The server has a key for this provider (platform billing).
        public let server: Bool
        /// The person's own key (only its last 4 characters).
        public let key: Key?
        public let available: Bool
        public let billing: String?
    }

    public struct Task: Decodable, Hashable, Sendable, Identifiable {
        public let task: String
        public let label: String
        public let description: String?
        public let kind: String
        public let choice: String?
        /// `provider:model` used now.
        public let model: String
        public let source: String?
        public let available: Bool

        public var id: String { task }
    }

    public let byokAllowed: Bool
    public let localAllowed: Bool
    /// `server` | `local`.
    public let keyMode: String
    public let preferByok: Bool
    public let providers: [Provider]
    public let tasks: [Task]
}

private struct StartedRun: Decodable, Sendable {
    let runId: String
}

public extension DesynAPI {
    // MARK: Agent runs

    /// Starts an agent run on a design; events follow through `runEventUpdates`.
    func startAIRun(
        designId: String,
        goal: String,
        mode: AIMode = .edit,
        pageId: String? = nil,
        selection: [String] = [],
        attachments: [String] = [],
        previousRunId: String? = nil
    ) async throws -> String {
        var args: ConvexArgs = ["designId": designId, "goal": goal, "mode": mode.rawValue]
        if let pageId { args["pageId"] = pageId }
        if !selection.isEmpty { args["selection"] = selection.map { $0 as ConvexEncodable? } }
        if !attachments.isEmpty { args["attachments"] = attachments.map { $0 as ConvexEncodable? } }
        if let previousRunId { args["previousRunId"] = previousRunId }
        return try await transport.mutation("ai/agent:startRun", args: args, as: StartedRun.self).runId
    }

    func cancelAIRun(runId: String) async throws {
        _ = try await transport.mutation("ai/agent:cancelRun", args: ["runId": runId], as: JSONValue.self)
    }

    /// Answers the run's question (`ask_user`) and resumes it.
    func answerAIRun(runId: String, answer: String) async throws {
        _ = try await transport.mutation("ai/agent:answer", args: ["runId": runId, "answer": answer], as: JSONValue.self)
    }

    /// Events after `afterSeq` (live). Re-subscribe with the page's `next` when `events` is non-empty and not done.
    func runEventUpdates(runId: String, afterSeq: Int?) -> AsyncThrowingStream<AIRunEventsPage, Error> {
        var args: ConvexArgs = ["runId": runId, "limit": 200.0]
        if let afterSeq { args["afterSeq"] = Double(afterSeq) }
        return transport.subscribe("ai/agent:runEvents", args: args, as: AIRunEventsPage.self)
    }

    /// Recent runs on a design (everyone who can view it).
    func aiRuns(designId: String, limit: Int = 20) async throws -> [AIRun] {
        try await transport.query("ai/agent:listRuns", args: ["designId": designId, "limit": Double(limit)], as: [AIRun].self)
    }

    func aiEstimate(mode: AIMode) async throws -> AIEstimate {
        try await transport.query("ai/agent:estimate", args: ["mode": mode.rawValue], as: AIEstimate.self)
    }

    // MARK: Media

    func generateImage(
        prompt: String,
        designId: String?,
        width: Double? = nil,
        height: Double? = nil,
        style: String? = nil,
        withText: Bool = false,
        useBrand: Bool = false,
        count: Int = 1
    ) async throws -> MediaResult {
        var args: ConvexArgs = ["prompt": prompt]
        if let designId { args["designId"] = designId }
        if let width { args["width"] = width.rounded() }
        if let height { args["height"] = height.rounded() }
        if let style { args["style"] = style }
        if withText { args["withText"] = true }
        if useBrand { args["useBrand"] = true }
        if count > 1 { args["n"] = Double(min(4, count)) }
        return try await transport.action("ai/media:generateImage", args: args, as: MediaResult.self)
    }

    func generateSVG(prompt: String, designId: String?, kind: String? = nil, useBrand: Bool = false, strokeOnly: Bool = false) async throws -> MediaResult {
        var args: ConvexArgs = ["prompt": prompt]
        if let designId { args["designId"] = designId }
        if let kind { args["kind"] = kind }
        if useBrand { args["useBrand"] = true }
        if strokeOnly { args["strokeOnly"] = true }
        return try await transport.action("ai/media:generateSvg", args: args, as: MediaResult.self)
    }

    func removeBackground(assetId: String, designId: String?) async throws -> MediaResult {
        var args: ConvexArgs = ["assetId": assetId]
        if let designId { args["designId"] = designId }
        return try await transport.action("ai/media:removeBackground", args: args, as: MediaResult.self)
    }

    /// Extends an image to `width x height` (generative expand).
    func expandImage(assetId: String, width: Double, height: Double, prompt: String?, designId: String?) async throws -> MediaResult {
        var args: ConvexArgs = ["assetId": assetId, "width": width.rounded(), "height": height.rounded()]
        if let prompt, !prompt.isEmpty { args["prompt"] = prompt }
        if let designId { args["designId"] = designId }
        return try await transport.action("ai/media:outpaint", args: args, as: MediaResult.self)
    }

    func upscaleImage(assetId: String, factor: Double, designId: String?) async throws -> MediaResult {
        var args: ConvexArgs = ["assetId": assetId, "factor": factor]
        if let designId { args["designId"] = designId }
        return try await transport.action("ai/media:upscale", args: args, as: MediaResult.self)
    }

    /// Places an image (or the design's page when `assetId` is nil) into a generated scene.
    func mockup(scene: String, assetId: String?, pageId: String?, designId: String?, aspectRatio: String? = nil) async throws -> MediaResult {
        var args: ConvexArgs = ["scene": scene]
        if let assetId { args["assetId"] = assetId }
        if let pageId { args["pageId"] = pageId }
        if let designId { args["designId"] = designId }
        if let aspectRatio { args["aspectRatio"] = aspectRatio }
        return try await transport.action("ai/media:mockup", args: args, as: MediaResult.self)
    }

    // MARK: Settings

    func aiPreferences() async throws -> AIPreferences {
        try await transport.query("ai/prefs:get", args: [:], as: AIPreferences.self)
    }
}
