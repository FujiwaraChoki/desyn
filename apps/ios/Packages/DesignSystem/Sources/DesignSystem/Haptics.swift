import UIKit

/// Haptic feedback with prepared generators (snapping, selection, success and failure).
@MainActor
public enum Haptics {
    private static let selectionGenerator = UISelectionFeedbackGenerator()
    private static let lightGenerator = UIImpactFeedbackGenerator(style: .light)
    private static let rigidGenerator = UIImpactFeedbackGenerator(style: .rigid)
    private static let mediumGenerator = UIImpactFeedbackGenerator(style: .medium)
    private static let notificationGenerator = UINotificationFeedbackGenerator()

    /// Call when a gesture that may produce feedback begins, so the first tick has no latency.
    public static func prepare() {
        selectionGenerator.prepare()
        rigidGenerator.prepare()
    }

    /// Selection changed (tool switch, tab change, segmented control).
    public static func selection() {
        selectionGenerator.selectionChanged()
        selectionGenerator.prepare()
    }

    /// A snap guide engaged while dragging.
    public static func snap() {
        rigidGenerator.impactOccurred(intensity: 0.7)
        rigidGenerator.prepare()
    }

    /// Light tap (insert, toggle).
    public static func light() {
        lightGenerator.impactOccurred()
    }

    /// Medium tap (long-press menus, page reorder).
    public static func medium() {
        mediumGenerator.impactOccurred()
    }

    public static func success() {
        notificationGenerator.notificationOccurred(.success)
    }

    public static func warning() {
        notificationGenerator.notificationOccurred(.warning)
    }

    public static func error() {
        notificationGenerator.notificationOccurred(.error)
    }
}
