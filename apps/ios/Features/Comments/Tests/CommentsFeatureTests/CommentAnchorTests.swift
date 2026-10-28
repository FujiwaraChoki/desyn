import CommentsFeature
import DesynKit
import XCTest

final class CommentAnchorTests: XCTestCase {
    func testPinsAtTheTopRightOfTheBox() {
        let corners = [PagePoint(x: 10, y: 20), PagePoint(x: 110, y: 20), PagePoint(x: 110, y: 70), PagePoint(x: 10, y: 70)]
        XCTAssertEqual(CommentAnchor.pin(corners: corners), PagePoint(x: 110, y: 20))
        // Rotated boxes pin at their bounding box's top-right.
        let rotated = [PagePoint(x: 50, y: 0), PagePoint(x: 100, y: 50), PagePoint(x: 50, y: 100), PagePoint(x: 0, y: 50)]
        XCTAssertEqual(CommentAnchor.pin(corners: rotated), PagePoint(x: 100, y: 0))
    }
}
