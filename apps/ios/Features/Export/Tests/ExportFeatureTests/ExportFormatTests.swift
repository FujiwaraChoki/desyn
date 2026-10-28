import DesynEngine
import ExportFeature
import SharedKit
import XCTest

final class ExportFormatTests: XCTestCase {
    func testEveryLocalFormatMapsToTheEngine() {
        XCTAssertEqual(ExportFormatMapping.engineFormat(.png), .png)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.jpeg), .jpeg)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.webp), .webp)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.svg), .svg)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.pdf), .pdf)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.pptx), .pptx)
        XCTAssertEqual(ExportFormatMapping.engineFormat(.gif), .gif)
        // MP4 never renders on the device.
        XCTAssertTrue(FileFormat.mp4.rendersOnServer)
        XCTAssertFalse(FileFormat.allCases.filter { !$0.rendersOnServer }.isEmpty)
    }
}
