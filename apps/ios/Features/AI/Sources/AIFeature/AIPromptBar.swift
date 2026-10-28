import DesignSystem
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// The AI prompt bar anchored above the tool dock: a glass capsule with the sun. While a run works it shows what
/// the agent is doing with a breathing glow and a stop button; tapping opens the AI dock.
public struct AIPromptBar: View {
    private let editor: EditorModel
    @State private var model: AIDockModel
    @State private var context: EditorContext
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(editor: EditorModel) {
        self.editor = editor
        _model = State(initialValue: AIDocks.model(for: editor))
        _context = State(initialValue: EditorContext.for(editor))
    }

    public var body: some View {
        Group {
            if editor.canEdit, editor.editingTextId == nil {
                bar
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .task { await model.refreshHistory() }
    }

    private var bar: some View {
        HStack(spacing: Spacing.sm) {
            Button {
                context.openAIDock()
                Haptics.selection()
            } label: {
                HStack(spacing: Spacing.sm) {
                    AISun(active: model.isRunning, size: 22)
                    if let status = model.statusLine, model.run != nil, !(model.run?.phase.isTerminal ?? true) || model.isRunning {
                        Text(status)
                            .font(DSFont.sans(14, weight: .medium, relativeTo: .callout))
                            .foregroundStyle(Palette.foreground)
                            .lineLimit(1)
                            .contentTransition(.opacity)
                    } else {
                        Text(editor.selection.isEmpty ? "Ask Desyn to change anything" : "Ask Desyn about the selection")
                            .font(DSFont.sans(14, relativeTo: .callout))
                            .foregroundStyle(Palette.muted)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.leading, Spacing.md)
                .frame(minHeight: Spacing.touchTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isRunning ? "AI is working: \(model.statusLine ?? "")" : "Ask the AI")
            .accessibilityHint("Opens the AI dock")
            if model.isRunning {
                Button {
                    Task { await model.cancel() }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Palette.onSun)
                        .frame(width: 32, height: 32)
                        .background(Palette.sun, in: Circle())
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                }
                .buttonStyle(PressScaleStyle())
                .accessibilityLabel("Stop the AI")
            } else if model.isWaiting {
                DSBadge("Answer", tone: .sun).padding(.trailing, Spacing.sm)
            }
        }
        .padding(.trailing, Spacing.xs)
        .frame(maxWidth: 560)
        .dsGlass(cornerRadius: Radius.pill)
        .overlay {
            Capsule()
                .strokeBorder(Palette.sunGradient, lineWidth: model.isRunning ? 1.5 : 1)
                .opacity(model.isRunning ? 0.9 : 0.35)
        }
        .shadow(color: Palette.sun.opacity(model.isRunning ? 0.35 : 0.12), radius: model.isRunning ? 18 : 10)
        .animation(Motion.animation(Motion.panel, reduced: reduceMotion), value: model.isRunning)
    }
}

/// The small sun of the AI: still when idle, rays turning and a corona breathing while a run works.
public struct AISun: View {
    let active: Bool
    let size: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(active: Bool, size: CGFloat = 22) {
        self.active = active
        self.size = size
    }

    public var body: some View {
        if active {
            SunSpinner(size: size)
        } else {
            Circle()
                .fill(Palette.sunGradient)
                .frame(width: size * 0.62, height: size * 0.62)
                .shadow(color: Palette.sun.opacity(0.6), radius: size * 0.3)
                .frame(width: size, height: size)
                .accessibilityHidden(true)
        }
    }
}
