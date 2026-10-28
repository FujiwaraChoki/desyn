import UIKit

/// "iPhone" or "iPad" for copy such as "saved on this iPad" (never the user-assigned device name).
public enum DeviceName {
    @MainActor
    public static var current: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }
}
