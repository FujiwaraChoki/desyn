import AuthFeature
import DesynEngine
import DesynKit
import EditorFeature
import FeatureCore
import SwiftUI
import XCTest

final class AppPreferenceTests: XCTestCase {
    func testAppearanceDefaultsToDark() {
        XCTAssertEqual(AppearancePreference(rawValue: "dark"), .dark)
        XCTAssertEqual(AppearancePreference.dark.colorScheme, ColorScheme.dark)
        XCTAssertNil(AppearancePreference.system.colorScheme)
    }

    func testEmailValidation() {
        XCTAssertTrue(AuthValidation.isEmail("ada@desyn.app"))
        XCTAssertTrue(AuthValidation.isEmail("first.last+tag@sub.example.co"))
        XCTAssertFalse(AuthValidation.isEmail("ada@desyn"))
        XCTAssertFalse(AuthValidation.isEmail("ada desyn@x.io"))
        XCTAssertFalse(AuthValidation.isEmail("@x.io"))
        XCTAssertFalse(AuthValidation.isEmail("a@b@c.io"))
    }
}

final class CanvasGeometryTests: XCTestCase {
    func testRotationKeepsSizeAndCenter() {
        let box = OrientedBox(DesignRect(x: 100, y: 100, width: 200, height: 100))
        let rotated = CanvasGeometry.rotate(box, degrees: 90, around: box.center)
        XCTAssertEqual(rotated.width, 200)
        XCTAssertEqual(rotated.height, 100)
        XCTAssertEqual(rotated.center.x, 200, accuracy: 1e-9)
        XCTAssertEqual(rotated.center.y, 150, accuracy: 1e-9)
        // Clockwise in y-down space: the top-left corner moves to the right side.
        XCTAssertEqual(rotated.corners[0].x, 250, accuracy: 1e-9)
        XCTAssertEqual(rotated.corners[0].y, 50, accuracy: 1e-9)
        XCTAssertEqual(rotated.transform.rotationDegrees, 90, accuracy: 1e-9)
    }

    func testRotationSnapsToFifteenDegrees() {
        XCTAssertEqual(CanvasGeometry.snappedRotation(startRotation: 0, delta: 44), 45)
        XCTAssertEqual(CanvasGeometry.snappedRotation(startRotation: 10, delta: 4), 5)
        XCTAssertNil(CanvasGeometry.snappedRotation(startRotation: 0, delta: 40))
    }

    func testGridDotsStayReadableAtAnyZoom() {
        for zoom in [0.02, 0.1, 0.5, 1, 2.5, 10, 64] {
            let spacing = CanvasGeometry.dotSpacing(zoom: zoom)
            XCTAssertGreaterThanOrEqual(spacing * zoom, 16 - 1e-9, "zoom \(zoom)")
            XCTAssertLessThanOrEqual(spacing * zoom, 48 + 1e-9, "zoom \(zoom)")
        }
        XCTAssertEqual(CanvasGeometry.dotSpacing(zoom: 0), 0)
    }

    func testUniformsMatchTheShaderLayout() {
        XCTAssertEqual(CanvasGeometry.uniformsStride, 96)
    }
}
