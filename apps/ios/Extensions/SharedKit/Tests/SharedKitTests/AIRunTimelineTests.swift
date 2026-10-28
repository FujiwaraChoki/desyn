import DesynKit
import XCTest
import SharedKit

final class AIRunTimelineTests: XCTestCase {
    private func event(_ json: String) -> JSONValue {
        try! JSONValue.parse(json)
    }

    func testFoldsAStreamedRunIntoItems() {
        var timeline = AIRunTimeline(goal: "Make it more premium")
        timeline.apply(page: [
            event(#"{"index":0,"type":"progress","label":"Queued"}"#),
            event(#"{"index":1,"type":"start","mode":"edit","model":"openrouter:x"}"#),
            event(#"{"index":2,"type":"text","text":"Let me "}"#),
            event(#"{"index":3,"type":"text","text":"look."}"#),
            event(#"{"index":4,"type":"tool-call","callId":"c1","tool":"read_design","input":{}}"#),
            event(#"{"index":5,"type":"tool-result","callId":"c1","tool":"read_design","ok":true,"summary":"3 layers","output":{}}"#),
            event(#"{"index":6,"type":"tool-call","callId":"c2","tool":"update_elements","input":{}}"#),
            event(#"{"index":7,"type":"applied-tx","tx":{"label":"AI: restyle"},"applied":2,"dropped":[],"ops":[],"touched":["aaaaaaaaaaaa","bbbbbbbbbbbb","aaaaaaaaaaaa"]}"#),
            event(#"{"index":8,"type":"tool-result","callId":"c2","tool":"update_elements","ok":true,"summary":"","output":{}}"#),
            event(#"{"index":9,"type":"credits","used":3,"remaining":597}"#),
            event(#"{"index":10,"type":"done","status":"completed","summary":"Darker palette, serif headline.","steps":3,"credits":3}"#),
        ])
        XCTAssertEqual(timeline.items.count, 6)
        XCTAssertEqual(timeline.items[0], .request(id: "request", text: "Make it more premium"))
        XCTAssertEqual(timeline.items[1], .message(id: "e2", text: "Let me look."))
        XCTAssertEqual(timeline.items[2], .tool(id: "c1", tool: "read_design", title: "Reading the design", state: .succeeded, summary: "3 layers"))
        XCTAssertEqual(timeline.items[3], .tool(id: "c2", tool: "update_elements", title: "Updating layers", state: .succeeded, summary: nil))
        XCTAssertEqual(timeline.items[4], .change(id: "e7", label: "AI: restyle", count: 2, touched: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]))
        XCTAssertEqual(timeline.touched, ["aaaaaaaaaaaa", "bbbbbbbbbbbb"])
        XCTAssertEqual(timeline.lastIndex, 10)
        XCTAssertTrue(timeline.finished)
        XCTAssertEqual(timeline.creditsUsed, 3)
        XCTAssertNil(timeline.activity)
        guard case let .outcome(_, status, summary, credits) = timeline.items[5] else { return XCTFail("no outcome") }
        XCTAssertEqual(status, "completed")
        XCTAssertEqual(summary, "Darker palette, serif headline.")
        XCTAssertEqual(credits, 3)
    }

    func testOverlappingPagesAreIdempotent() {
        var timeline = AIRunTimeline()
        let page = [event(#"{"index":0,"type":"text","text":"Hi"}"#), event(#"{"index":1,"type":"text","text":"!"}"#)]
        timeline.apply(page: page)
        timeline.apply(page: page)
        XCTAssertEqual(timeline.items, [.message(id: "e0", text: "Hi!")])
    }

    func testCompactedAppliedTxFallsBackToOpTargets() {
        let parsed = AIRunEvent(json: event(#"{"type":"applied-tx","applied":1,"ops":[{"op":"update","id":"cccccccccccc","set":{"opacity":0.5}},{"op":"delete","id":"dddddddddddd"}]}"#))
        XCTAssertEqual(parsed, .appliedTransaction(label: "Edit", applied: 1, dropped: 0, touched: ["cccccccccccc", "dddddddddddd"]))
    }

    func testQuestionAndAnswer() {
        var timeline = AIRunTimeline()
        timeline.apply(page: [
            event(#"{"index":0,"type":"question","question":"Which color?","options":["Warm","Cool"]}"#),
        ])
        XCTAssertEqual(timeline.pendingQuestion?.question, "Which color?")
        XCTAssertEqual(timeline.pendingQuestion?.options, ["Warm", "Cool"])
        timeline.apply(page: [event(#"{"index":1,"type":"answer","answer":"Warm"}"#)])
        XCTAssertNil(timeline.pendingQuestion)
        XCTAssertEqual(timeline.items, [.question(id: "e0", question: "Which color?", options: ["Warm", "Cool"], answer: "Warm")])
    }

    func testDoneClosesToolsThatNeverReported() {
        var timeline = AIRunTimeline()
        timeline.apply(page: [
            event(#"{"index":0,"type":"tool-call","callId":"c9","tool":"generate_image"}"#),
            event(#"{"index":1,"type":"done","status":"cancelled","summary":"","steps":1,"credits":0}"#),
        ])
        XCTAssertEqual(timeline.items.first, .tool(id: "c9", tool: "generate_image", title: "Generating an image", state: .failed, summary: nil))
    }

    func testPlanIsReplacedInPlaceAndErrorsBecomeNotices() {
        var timeline = AIRunTimeline()
        timeline.apply(page: [
            event(#"{"index":0,"type":"plan","steps":[{"id":"a","title":"Layout","status":"running"}]}"#),
            event(#"{"index":1,"type":"error","message":"Provider busy","recoverable":true}"#),
            event(#"{"index":2,"type":"plan","steps":[{"id":"a","title":"Layout","status":"done"},{"id":"b","title":"Copy","status":"running","checkpoint":true}]}"#),
        ])
        XCTAssertEqual(timeline.items.count, 2)
        XCTAssertEqual(timeline.items[0], .plan(id: "e0", steps: [
            AIPlanStep(id: "a", title: "Layout", status: "done", checkpoint: false),
            AIPlanStep(id: "b", title: "Copy", status: "running", checkpoint: true),
        ]))
        XCTAssertEqual(timeline.items[1], .notice(id: "e1", text: "Provider busy", tone: .warning))
    }

    func testToolTitlesFallBackToWords() {
        XCTAssertEqual(AIToolTitles.title(for: "remove_background"), "Removing the background")
        XCTAssertEqual(AIToolTitles.title(for: "brand_new_tool"), "Brand new tool")
    }

    func testRunPhase() {
        XCTAssertEqual(AIRunPhase(status: "needs-input"), .waitingForAnswer)
        XCTAssertTrue(AIRunPhase(status: "running").isActive)
        XCTAssertTrue(AIRunPhase(status: "step-limit").isTerminal)
        XCTAssertEqual(AIRunPhase(status: "weird"), .failed)
    }

    func testUndoLabelIsTheFirstLineShortened() {
        XCTAssertEqual(AIRunTimeline.undoLabel(goal: "Warmer colors"), "AI: Warmer colors")
        XCTAssertEqual(AIRunTimeline.undoLabel(goal: "  Line one \nline two"), "AI: Line one")
        XCTAssertEqual(AIRunTimeline.undoLabel(goal: String(repeating: "a", count: 60)), "AI: " + String(repeating: "a", count: 39) + "…")
        XCTAssertEqual(AIRunTimeline.undoLabel(goal: "\n"), "AI edit")
    }
}
