import SwiftUI

/// The app's color scheme choice (dark-first, like every Desyn surface).
public enum AppearancePreference: String, CaseIterable, Sendable {
    case dark, light, system

    /// `@AppStorage` key.
    public static let storageKey = "appearance"

    public var title: String {
        switch self {
        case .dark: "Dark"
        case .light: "Light"
        case .system: "System"
        }
    }

    /// nil follows the system setting.
    public var colorScheme: ColorScheme? {
        switch self {
        case .dark: .dark
        case .light: .light
        case .system: nil
        }
    }
}
