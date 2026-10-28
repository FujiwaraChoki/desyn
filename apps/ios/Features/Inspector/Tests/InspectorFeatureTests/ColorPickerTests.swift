import InspectorFeature
import SharedKit
import XCTest

final class ColorPickerTests: XCTestCase {
    @MainActor
    func testPaletteIsValidAndDistinct() {
        XCTAssertEqual(Set(SunColorPicker.palette).count, SunColorPicker.palette.count)
        for hex in SunColorPicker.palette {
            XCTAssertEqual(RGBA(hex: hex)?.hex, hex, hex)
        }
        // The sun is in the palette.
        XCTAssertTrue(SunColorPicker.palette.contains("#ffb02e"))
    }

    @MainActor
    func testSectionsHaveTitlesAndSymbols() {
        for section in InspectorModel.Section.allCases {
            XCTAssertFalse(section.title.isEmpty)
            XCTAssertFalse(section.systemImage.isEmpty)
        }
    }
}
