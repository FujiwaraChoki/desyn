import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Where comments about a layer are pinned: the top-right corner of its (rotated) box, so the pin never covers
/// the content.
public enum CommentAnchor {
    public static func pin(corners: [PagePoint]) -> PagePoint {
        PagePoint(x: corners.map(\.x).max() ?? 0, y: corners.map(\.y).min() ?? 0)
    }
}

/// Keeps `context.commentThreads` live while a view that shows comments is on screen.
@MainActor
enum CommentsFeed {
    static func watch(_ editor: EditorModel, context: EditorContext, includeResolved: Bool) async throws {
        for try await threads in editor.session.api.commentUpdates(designId: editor.designId, includeResolved: includeResolved, share: editor.route.share) {
            context.commentThreads = threads
        }
    }
}

/// Comments of the open design: threads pinned to the canvas or attached to layers, replies with @mentions,
/// resolve / reopen, edit and delete your own. New comments go on the selection or on a point you tap.
public struct CommentsPanel: View {
    private let editor: EditorModel
    @State private var context: EditorContext
    @State private var showResolved = false
    @State private var error: String?
    @State private var loaded = false
    @State private var draft = ""
    @State private var members: [MentionableMember] = []
    @State private var sending = false
    /// The caller's access (comment links allow commenting without edit access).
    @State private var access: DesignDetail?
    @FocusState private var composerFocused: Bool
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    private var threads: [CommentThread] {
        context.commentThreads.filter { showResolved || !$0.resolved }
    }

    private var focused: CommentThread? {
        context.focusedThreadId.flatMap { id in context.commentThreads.first { $0.id == id } }
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader(focused == nil ? "*comments*" : "thread", subtitle: subtitle) {
                if focused != nil {
                    context.focusedThreadId = nil
                } else {
                    dismiss()
                }
            }
            if let focused {
                ThreadView(editor: editor, thread: focused, members: members) { message in error = message }
            } else {
                list
            }
            if let error {
                InlineNotice(error, tone: .error, actionTitle: "Dismiss") { self.error = nil }
                    .padding(.horizontal, Spacing.gutter)
                    .padding(.bottom, Spacing.sm)
            }
            if focused == nil, access?.canComment ?? editor.canEdit {
                composer
            }
        }
        .panelSheet([.medium, .large], interactiveUpThrough: .medium)
        .task(id: showResolved) {
            do {
                try await CommentsFeed.watch(editor, context: context, includeResolved: showResolved)
            } catch {
                let mapped = DesynError(error)
                self.error = mapped.code == "FEATURE_UNAVAILABLE" ? "Comments aren't included in this workspace's plan." : (mapped.isTransient ? "You're offline. Comments load when you're back online." : mapped.message)
            }
        }
        .task {
            context.showsCommentPins = true
            access = try? await editor.session.api.design(designId: editor.designId, share: editor.route.share)
            members = (try? await editor.session.api.mentionableMembers(designId: editor.designId)) ?? []
            loaded = true
        }
    }

    private var subtitle: String? {
        if let focused { return "\(focused.replies.count) repl\(focused.replies.count == 1 ? "y" : "ies") · \(focused.resolved ? "resolved" : "open")" }
        let open = context.commentThreads.filter { !$0.resolved }.count
        return open == 0 ? "No open threads" : "\(open) open thread\(open == 1 ? "" : "s")"
    }

    // MARK: List

    private var list: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Spacing.md) {
                HStack {
                    PanelToggle("Show resolved", isOn: showResolved) { showResolved = $0 }
                }
                PanelToggle("Pins on the canvas", isOn: context.showsCommentPins) { context.showsCommentPins = $0 }
                if threads.isEmpty {
                    VStack(spacing: Spacing.sm) {
                        Image(systemName: "text.bubble").font(.system(size: 28, weight: .light)).foregroundStyle(Palette.sun)
                        Text("No comments yet. Select a layer or tap \u{201C}Pin\u{201D} to place one on the canvas.")
                            .font(.dsCallout)
                            .foregroundStyle(Palette.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Spacing.xl)
                }
                ForEach(threads) { thread in
                    Button {
                        open(thread)
                    } label: {
                        ThreadSummary(thread: thread, pageNumber: pageNumber(thread.pageId))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(Spacing.gutter)
        }
    }

    private func pageNumber(_ pageId: String?) -> Int? {
        guard let pageId, let index = editor.pages.firstIndex(where: { $0.id == pageId }) else { return nil }
        return index + 1
    }

    private func open(_ thread: CommentThread) {
        context.focusedThreadId = thread.id
        if let pageId = thread.pageId, editor.pages.contains(where: { $0.id == pageId }) {
            editor.showPage(pageId)
        }
        if let nodeId = thread.nodeId, editor.lookupNode(nodeId) != nil {
            editor.select([nodeId])
        }
    }

    // MARK: Composer

    private var target: String {
        if let point = context.commentDraftPoint {
            return "Pinned at \(Int(point.x)), \(Int(point.y))"
        }
        if let node = editor.selectedNodes.first {
            return "On \(node.displayName)"
        }
        return "On this page"
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Label(target, systemImage: context.commentDraftPoint != nil ? "mappin" : editor.selectedNodes.isEmpty ? "doc" : "square.dashed")
                    .font(.dsCaption)
                    .foregroundStyle(Palette.muted)
                    .lineLimit(1)
                Spacer()
                Button {
                    context.isPlacingComment = true
                    composerFocused = false
                    Haptics.selection()
                } label: {
                    Label("Pin", systemImage: "mappin.and.ellipse").font(DSFont.sans(12, weight: .semibold, relativeTo: .caption))
                }
                .foregroundStyle(Palette.sun)
                .frame(minHeight: 32)
                .accessibilityHint("Tap the canvas to place the comment")
            }
            if let query = CommentMentions.activeQuery(in: draft), !members.isEmpty {
                MentionSuggestions(members: members, query: query) { member in
                    draft = CommentMentions.complete(draft, with: member)
                }
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                TextField("Add a comment… use @ to mention", text: $draft, axis: .vertical)
                    .lineLimit(1...4)
                    .font(.dsBody)
                    .focused($composerFocused)
                    .tint(Palette.sun)
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm + 2)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                Button {
                    Task { await send() }
                } label: {
                    Group {
                        if sending { SunSpinner(size: 18, tint: Palette.onSun) } else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
                    }
                    .foregroundStyle(Palette.onSun)
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                    .background(Palette.sun, in: Circle())
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sending)
                .accessibilityLabel("Post comment")
            }
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.vertical, Spacing.md)
        .background(Palette.surface1)
        .overlay(alignment: .top) { DSDivider() }
    }

    private func send() async {
        let body = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        sending = true
        defer { sending = false }
        let node = context.commentDraftPoint == nil ? editor.selectedNodes.first : nil
        var point = context.commentDraftPoint
        if point == nil, let node, let box = editor.pageBounds(of: node.id) {
            point = CommentAnchor.pin(corners: box.corners.map { PagePoint(x: $0.x, y: $0.y) })
        }
        do {
            let id = try await editor.session.api.createComment(
                designId: editor.designId,
                body: body,
                nodeId: node?.id,
                pageId: editor.currentPage?.id,
                point: point,
                mentions: CommentMentions.resolve(in: body, members: members),
                share: editor.route.share
            )
            draft = ""
            context.commentDraftPoint = nil
            context.focusedThreadId = id
            Haptics.success()
        } catch {
            let mapped = DesynError(error)
            self.error = mapped.code == "FEATURE_UNAVAILABLE" ? "Comments aren't included in this workspace's plan." : mapped.message
        }
    }
}

/// One thread in the list.
private struct ThreadSummary: View {
    let thread: CommentThread
    let pageNumber: Int?

    var body: some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            Avatar(person: thread.author, size: 32)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(thread.author.name).font(DSFont.sans(14, weight: .semibold, relativeTo: .callout)).foregroundStyle(Palette.foreground)
                    Text(thread.lastActivityDate, style: .relative).font(.dsCaption).foregroundStyle(Palette.muted)
                    Spacer()
                    if thread.resolved {
                        DSBadge("Resolved", tone: .success)
                    } else if let pageNumber {
                        DSBadge("Page \(pageNumber)")
                    }
                }
                Text(thread.deleted ? "Deleted comment" : thread.body)
                    .font(.dsCallout)
                    .foregroundStyle(thread.deleted ? Palette.muted : Palette.foreground)
                    .lineLimit(3)
                if !thread.replies.isEmpty {
                    Text("\(thread.replies.count) repl\(thread.replies.count == 1 ? "y" : "ies")")
                        .font(DSFont.sans(12, weight: .semibold, relativeTo: .caption))
                        .foregroundStyle(Palette.sun)
                }
            }
        }
        .padding(Spacing.md)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
        .opacity(thread.resolved ? 0.7 : 1)
        .accessibilityElement(children: .combine)
    }
}

/// A thread with its replies and a reply composer.
private struct ThreadView: View {
    let editor: EditorModel
    let thread: CommentThread
    let members: [MentionableMember]
    let onError: (String) -> Void

    @State private var reply = ""
    @State private var editingId: String?
    @State private var editText = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    message(id: thread.id, author: thread.author, body: thread.body, deleted: thread.deleted, date: thread.createdDate, edited: thread.editedAt != nil)
                    ForEach(thread.replies) { item in
                        message(id: item.id, author: item.author, body: item.body, deleted: item.deleted, date: item.createdDate, edited: item.editedAt != nil)
                    }
                    if let resolver = thread.resolvedBy, thread.resolved {
                        Label("Resolved by \(resolver.name)", systemImage: "checkmark.circle").font(.dsFootnote).foregroundStyle(Palette.success)
                    }
                }
                .padding(Spacing.gutter)
            }
            VStack(spacing: Spacing.sm) {
                if let query = CommentMentions.activeQuery(in: reply), !members.isEmpty {
                    MentionSuggestions(members: members, query: query) { member in
                        reply = CommentMentions.complete(reply, with: member)
                    }
                }
                HStack(spacing: Spacing.sm) {
                    TextField("Reply", text: $reply, axis: .vertical)
                        .lineLimit(1...4)
                        .font(.dsBody)
                        .tint(Palette.sun)
                        .padding(.horizontal, Spacing.md)
                        .padding(.vertical, Spacing.sm + 2)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    Button {
                        Task { await sendReply() }
                    } label: {
                        Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).foregroundStyle(Palette.onSun)
                            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget).background(Palette.sun, in: Circle())
                    }
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send reply")
                }
                DSButton(thread.resolved ? "Reopen" : "Resolve", systemImage: thread.resolved ? "arrow.uturn.backward" : "checkmark", kind: .secondary, size: .small) {
                    Task {
                        do {
                            try await editor.session.api.resolveThread(threadId: thread.id, resolved: !thread.resolved, share: editor.route.share)
                            Haptics.success()
                        } catch {
                            onError(DesynError(error).message)
                        }
                    }
                }
            }
            .padding(.horizontal, Spacing.gutter)
            .padding(.vertical, Spacing.md)
            .background(Palette.surface1)
            .overlay(alignment: .top) { DSDivider() }
        }
    }

    private var myId: String? { editor.session.user?.id }

    @ViewBuilder
    private func message(id: String, author: CommentPerson, body: String, deleted: Bool, date: Date, edited: Bool) -> some View {
        HStack(alignment: .top, spacing: Spacing.md) {
            Avatar(person: author, size: 30)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: Spacing.sm) {
                    Text(author.name).font(DSFont.sans(14, weight: .semibold, relativeTo: .callout)).foregroundStyle(Palette.foreground)
                    Text(date, style: .relative).font(.dsCaption).foregroundStyle(Palette.muted)
                    if edited { Text("edited").font(.dsCaption).foregroundStyle(Palette.muted) }
                }
                if editingId == id {
                    TextField("Comment", text: $editText, axis: .vertical)
                        .font(.dsBody)
                        .padding(Spacing.sm)
                        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                    HStack {
                        Button("Cancel") { editingId = nil }.foregroundStyle(Palette.muted)
                        Button("Save") {
                            let text = editText
                            editingId = nil
                            Task {
                                // Mentions follow the edited text (members unknown, e.g. on a share link: keep them).
                                let mentions = members.isEmpty ? nil : CommentMentions.resolve(in: text, members: members)
                                do { try await editor.session.api.editComment(commentId: id, body: text, mentions: mentions, share: editor.route.share) } catch { onError(DesynError(error).message) }
                            }
                        }
                        .foregroundStyle(Palette.sun)
                    }
                    .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                } else {
                    Text(deleted ? "Deleted comment" : highlighted(body))
                        .font(.dsBody)
                        .foregroundStyle(deleted ? Palette.muted : Palette.foreground)
                        .textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
            if author.id == myId, !deleted {
                Menu {
                    Button { editingId = id; editText = body } label: { Label("Edit", systemImage: "pencil") }
                    Button(role: .destructive) {
                        Task {
                            do { try await editor.session.api.deleteComment(commentId: id, share: editor.route.share) } catch { onError(DesynError(error).message) }
                        }
                    } label: { Label("Delete", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis").foregroundStyle(Palette.muted).frame(width: 32, height: 32)
                }
                .accessibilityLabel("Comment options")
            }
        }
    }

    /// Mentions in the sun color.
    private func highlighted(_ text: String) -> AttributedString {
        var result = AttributedString(text)
        for member in members where !member.name.isEmpty {
            var search = result.startIndex
            while let range = result[search...].range(of: "@" + member.name, options: .caseInsensitive) {
                result[range].foregroundColor = Palette.sun
                search = range.upperBound
            }
        }
        return result
    }

    private func sendReply() async {
        let body = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        do {
            _ = try await editor.session.api.replyToComment(threadId: thread.id, body: body, mentions: CommentMentions.resolve(in: body, members: members), share: editor.route.share)
            reply = ""
            Haptics.success()
        } catch {
            onError(DesynError(error).message)
        }
    }
}

/// @mention suggestions while typing.
private struct MentionSuggestions: View {
    let members: [MentionableMember]
    let query: String
    let onPick: (MentionableMember) -> Void

    var body: some View {
        let matches = members.filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }.prefix(5)
        if !matches.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(Array(matches)) { member in
                        ChipButton("@\(member.name)") { onPick(member) }
                    }
                }
            }
        }
    }
}

/// Initials in a sun ring.
struct Avatar: View {
    let person: CommentPerson
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(Palette.surface3)
            if let image = person.image, let url = URL(string: image) {
                RemoteImage(url, maxPixel: size * 3).clipShape(Circle())
            } else {
                Text(person.initials).font(DSFont.sans(size * 0.38, weight: .semibold, relativeTo: .caption)).foregroundStyle(Palette.foreground)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().strokeBorder(Palette.sun.opacity(0.5), lineWidth: 1.2))
        .accessibilityHidden(true)
    }
}
