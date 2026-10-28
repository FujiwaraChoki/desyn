import SwiftUI
import UIKit

/// Entry point of the design system.
public enum DesignSystem {
    /// Registers fonts and themes UIKit chrome (navigation bars, tab bars, pickers) with the sun palette.
    /// Call once from the app initializer, before the first view renders.
    @MainActor
    public static func bootstrap() {
        DSFont.registerFonts()

        let navigation = UINavigationBarAppearance()
        navigation.configureWithTransparentBackground()
        navigation.backgroundEffect = UIBlurEffect(style: .systemUltraThinMaterial)
        navigation.titleTextAttributes = [
            .foregroundColor: UIPalette.foreground,
            .font: DSFont.uiSans(17, weight: .semibold, textStyle: .headline),
        ]
        navigation.largeTitleTextAttributes = [
            .foregroundColor: UIPalette.foreground,
            .font: UIFontMetrics(forTextStyle: .largeTitle).scaledFont(
                for: UIFont(name: DSFont.serifRegular, size: 36) ?? .systemFont(ofSize: 34)
            ),
        ]
        UINavigationBar.appearance().standardAppearance = navigation
        UINavigationBar.appearance().scrollEdgeAppearance = navigation
        UINavigationBar.appearance().compactAppearance = navigation
        UINavigationBar.appearance().tintColor = UIPalette.sun

        UIRefreshControl.appearance().tintColor = UIPalette.sun
        UISegmentedControl.appearance().selectedSegmentTintColor = UIPalette.surface3
        UIView.appearance(whenContainedInInstancesOf: [UIAlertController.self]).tintColor = UIPalette.sun
    }
}
