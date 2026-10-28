import AssetsFeature
import DesynKit
import XCTest

final class IconPreviewTests: XCTestCase {
    func testPreviewIdsAreStableValidAndDistinct() {
        let ids = ["lucide:sun", "lucide:moon", "ph:arrow-right", "tabler:star", "lucide:sun-dim"].map(IconPreviewID.nodeId(for:))
        XCTAssertEqual(Set(ids).count, ids.count)
        for id in ids {
            XCTAssertTrue(DesynID.isValid(id), id)
        }
        XCTAssertEqual(IconPreviewID.nodeId(for: "lucide:sun"), IconPreviewID.nodeId(for: "lucide:sun"))
    }
}
