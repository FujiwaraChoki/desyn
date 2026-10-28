import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Comment pins on the canvas: one sun bubble per open thread of the current page (following pan and zoom), the
/// draft pin while a comment is being written, and a tap catcher while a new comment is being placed.
public struct CommentPinsOverlay: View {
    private let editor: EditorModel
    @State private var context: EditorContext

    public init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    private var pins: [CommentThread] {
        guard let pageId = editor.currentPage?.id else { return [] }
        return context.commentThreads.filter { !$0.resolved && $0.hasPin && ($0.pageId == nil || $0.pageId == pageId) }
    }

    public var body: some View {
        ZStack {
            if context.isPlacingComment {
                placementCatcher
            }
            if context.showsCommentPins || context.commentDraftPoint != nil {
                // Re-projected every frame only while pins are visible, so pan and zoom never leave them behind.
                TimelineView(.animation(minimumInterval: 1 / 60, paused: pins.isEmpty && context.commentDraftPoint == nil)) { _ in
                    GeometryReader { _ in
                        if let viewport = editor.canvasViewport {
                            ForEach(pins) { thread in
                                if let x = thread.x, let y = thread.y {
                                    pin(for: thread)
                                        .position(viewport.viewPoint(fromPage: DesignPoint(x: x, y: y)))
                                }
                            }
                            if let draft = context.commentDraftPoint {
                                DraftPin()
                                    .position(viewport.viewPoint(fromPage: DesignPoint(x: draft.x, y: draft.y)))
                                    .allowsHitTesting(false)
                            }
                        }
                    }
                }
            }
        }
        .ignoresSafeArea()
        .task(id: context.showsCommentPins) {
            guard context.showsCommentPins else { return }
            try? await CommentsFeed.watch(editor, context: context, includeResolved: false)
        }
    }

    private func pin(for thread: CommentThread) -> some View {
        let focused = context.focusedThreadId == thread.id
        return Button {
            context.focusedThreadId = thread.id
            context.open(.comments)
        } label: {
            ZStack(alignment: .topTrailing) {
                Text(thread.author.initials)
                    .font(DSFont.sans(11, weight: .bold, relativeTo: .caption2))
                    .foregroundStyle(Palette.onSun)
                    .frame(width: 30, height: 30)
                    .background(
                        UnevenRoundedRectangle(topLeadingRadius: 15, bottomLeadingRadius: 2, bottomTrailingRadius: 15, topTrailingRadius: 15, style: .continuous)
                            .fill(Palette.sunGradient)
                    )
                    .overlay(
                        UnevenRoundedRectangle(topLeadingRadius: 15, bottomLeadingRadius: 2, bottomTrailingRadius: 15, topTrailingRadius: 15, style: .continuous)
                            .strokeBorder(.white.opacity(0.9), lineWidth: focused ? 2.5 : 1.5)
                    )
                    .shadow(color: Palette.sun.opacity(focused ? 0.7 : 0.4), radius: focused ? 12 : 6)
                if !thread.replies.isEmpty {
                    Text("\(thread.replies.count)")
                        .font(DSFont.sans(9, weight: .bold, relativeTo: .caption2))
                        .foregroundStyle(Palette.foreground)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 15, minHeight: 15)
                        .background(Palette.surface1, in: Capsule())
                        .offset(x: 6, y: -6)
                }
            }
            // The bubble's pointed corner sits on the pinned point.
            .offset(x: 15, y: -15)
            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressScaleStyle())
        .accessibilityLabel("Comment by \(thread.author.name): \(thread.body)")
    }

    private var placementCatcher: some View {
        Color.black.opacity(0.001)
            .overlay(alignment: .top) {
                Label("Tap where the comment goes", systemImage: "mappin.and.ellipse")
                    .font(DSFont.sans(14, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(Palette.foreground)
                    .padding(.horizontal, Spacing.lg)
                    .padding(.vertical, Spacing.sm)
                    .dsGlass(cornerRadius: Radius.pill)
                    .padding(.top, 110)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .onTapGesture { location in
                guard let viewport = editor.canvasViewport else { return }
                let point = viewport.pagePoint(fromView: location)
                context.commentDraftPoint = PagePoint(x: point.x, y: point.y)
                context.isPlacingComment = false
                context.showsCommentPins = true
                Haptics.light()
                context.open(.comments)
            }
            .accessibilityElement()
            .accessibilityLabel("Comment placement")
            .accessibilityHint("Double tap to place the comment at the center of the screen")
            .accessibilityAction {
                guard let viewport = editor.canvasViewport else { return }
                let page = viewport.visiblePageRect
                context.commentDraftPoint = PagePoint(x: page.x + page.width / 2, y: page.y + page.height / 2)
                context.isPlacingComment = false
                context.open(.comments)
            }
    }
}

private struct DraftPin: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(paused: reduceMotion)) { timeline in
            let pulse = reduceMotion ? 1 : 1 + 0.12 * sin(timeline.date.timeIntervalSinceReferenceDate * 4)
            ZStack {
                Circle().fill(Palette.sun.opacity(0.25)).frame(width: 40 * pulse, height: 40 * pulse).blur(radius: 6)
                Image(systemName: "plus")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(Palette.onSun)
                    .frame(width: 26, height: 26)
                    .background(Palette.sun, in: Circle())
                    .overlay(Circle().strokeBorder(.white, lineWidth: 2))
            }
        }
        .accessibilityHidden(true)
    }
}
