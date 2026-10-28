import AIFeature
import DesynKit
import SharedKit
import XCTest

final class AIDockTests: XCTestCase {
    @MainActor
    func testErrorsSayWhatToDoNext() {
        XCTAssertEqual(AIDockModel.message(for: .server(code: "LIMIT_REACHED", message: "x")), "You've used this month's AI credits. They renew at the start of next month.")
        XCTAssertTrue(AIDockModel.message(for: .server(code: "CONFLICT", message: "x")).contains("already working"))
        XCTAssertEqual(AIDockModel.message(for: .server(code: "OTHER", message: "Exact server text.")), "Exact server text.")
        XCTAssertEqual(AIDockModel.message(for: .unauthenticated), DesynError.unauthenticated.message)
    }

    @MainActor
    func testSuggestionsAreCompletePrompts() {
        XCTAssertGreaterThanOrEqual(AIDockModel.suggestions.count, 4)
        for suggestion in AIDockModel.suggestions {
            XCTAssertFalse(suggestion.title.isEmpty)
            XCTAssertTrue(suggestion.prompt.hasSuffix("."), suggestion.prompt)
        }
        XCTAssertTrue(AIDockModel.suggestions.contains { $0.mode == .critique })
    }
}
