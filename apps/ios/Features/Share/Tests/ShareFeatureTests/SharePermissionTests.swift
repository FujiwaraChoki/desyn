import ShareFeature
import XCTest

final class SharePermissionTests: XCTestCase {
    @MainActor
    func testPermissionLabels() {
        XCTAssertEqual(SharePanel.title("view"), "Can view")
        XCTAssertEqual(SharePanel.title("comment"), "Can comment")
        XCTAssertEqual(SharePanel.title("edit"), "Can edit")
        XCTAssertEqual(SharePanel.title("unknown"), "Can view")
        XCTAssertNotEqual(SharePanel.icon("edit"), SharePanel.icon("view"))
    }
}
