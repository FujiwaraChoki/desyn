import Observation
import SwiftUI

/// One toast message.
public struct Toast: Identifiable, Equatable, Sendable {
    public enum Tone: Sendable { case info, success, error }

    public let id = UUID()
    public let message: String
    public let tone: Tone

    public init(_ message: String, tone: Tone = .info) {
        self.message = message
        self.tone = tone
    }
}

/// Queue of transient messages shown bottom-center (DESIGN_SYSTEM: toasts bottom center).
@MainActor
@Observable
public final class ToastCenter {
    public private(set) var current: Toast?
    private var queue: [Toast] = []
    private var dismissTask: Task<Void, Never>?

    public init() {}

    public func show(_ message: String, tone: Toast.Tone = .info) {
        let toast = Toast(message, tone: tone)
        if current == nil {
            present(toast)
        } else {
            queue.append(toast)
        }
        switch tone {
        case .error: Haptics.error()
        case .success: Haptics.success()
        case .info: break
        }
    }

    public func dismiss() {
        dismissTask?.cancel()
        current = nil
        if !queue.isEmpty {
            let next = queue.removeFirst()
            dismissTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
                self?.present(next)
            }
        }
    }

    private func present(_ toast: Toast) {
        current = toast
        dismissTask?.cancel()
        let duration: Duration = toast.tone == .error ? .seconds(5) : .seconds(3)
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: duration)
            guard !Task.isCancelled else { return }
            self?.dismiss()
        }
    }
}

private struct ToastOverlay: ViewModifier {
    let center: ToastCenter
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let toast = center.current {
                HStack(spacing: Spacing.sm) {
                    Image(systemName: icon(for: toast.tone))
                        .foregroundStyle(color(for: toast.tone))
                    Text(toast.message)
                        .font(.dsCallout)
                        .foregroundStyle(Palette.foreground)
                        .multilineTextAlignment(.leading)
                }
                .padding(.horizontal, Spacing.lg)
                .padding(.vertical, Spacing.md)
                .dsGlass(cornerRadius: Radius.panel)
                .padding(.horizontal, Spacing.gutter)
                .padding(.bottom, 96)
                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                .onTapGesture { center.dismiss() }
                .accessibilityAddTraits(.isStaticText)
                .onAppear {
                    UIAccessibility.post(notification: .announcement, argument: toast.message)
                }
                .id(toast.id)
            }
        }
        .animation(Motion.animation(Motion.panel, reduced: reduceMotion), value: center.current)
    }

    private func icon(for tone: Toast.Tone) -> String {
        switch tone {
        case .info: "sun.max"
        case .success: "checkmark.circle"
        case .error: "exclamationmark.triangle"
        }
    }

    private func color(for tone: Toast.Tone) -> Color {
        switch tone {
        case .info: Palette.sun
        case .success: Palette.success
        case .error: Palette.danger
        }
    }
}

public extension View {
    /// Shows `center`'s toasts over this view.
    func dsToasts(_ center: ToastCenter) -> some View {
        modifier(ToastOverlay(center: center))
    }
}
