import SettingsFeature
import XCTest

final class SettingsFormattingTests: XCTestCase {
    @MainActor
    func testMeterTitlesAndValues() {
        XCTAssertEqual(SettingsModel.meterTitle("storageBytes"), "Storage")
        XCTAssertEqual(SettingsModel.meterTitle("aiRequests"), "AI requests this month")
        XCTAssertEqual(SettingsModel.meterTitle("custom"), "custom")
        XCTAssertEqual(SettingsModel.meterValue("designs", 12), "12")
        XCTAssertEqual(SettingsModel.meterValue("designs", 2.5), "2.5")
        XCTAssertTrue(SettingsModel.meterValue("storageBytes", 2_500_000).contains("MB"))
        XCTAssertEqual(SettingsModel.meterOrder.first, "designs")
    }

    @MainActor
    func testDeviceNames() {
        XCTAssertEqual(SettingsModel.deviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"), "Chrome on macOS")
        XCTAssertEqual(SettingsModel.deviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone")
        XCTAssertEqual(SettingsModel.deviceName("Desyn/1 CFNetwork/1568 Darwin/24.0.0"), "Desyn for iPhone and iPad")
        XCTAssertEqual(SettingsModel.deviceName(nil), "Unknown device")
        XCTAssertEqual(SettingsModel.deviceName("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0"), "Firefox on Windows")
    }
}
