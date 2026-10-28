import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI
import UIKit

/// Share links of the open design: create view / comment / edit links with an optional password and expiry, copy
/// or send them, change or revoke them. People who cannot manage the design get the members' link.
public struct SharePanel: View {
    private let editor: EditorModel
    @State private var links: [DesignShareLink] = []
    @State private var loaded = false
    @State private var canManage = true
    @State private var error: String?
    @State private var composing = false
    @State private var editing: DesignShareLink?
    @State private var copiedId: String?
    @Environment(\.dismiss) private var dismiss

    public init(editor: EditorModel) {
        self.editor = editor
    }

    private var membersLink: URL {
        editor.session.environment.appURL.appendingPathComponent("design").appendingPathComponent(editor.designId)
    }

    public var body: some View {
        VStack(spacing: 0) {
            SheetHeader("share your *design*", subtitle: editor.name) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    teammates
                    if canManage {
                        linksSection
                    } else {
                        InlineNotice("Only people who manage this design can create share links. Ask its owner for a link.", tone: .info)
                    }
                    if let error {
                        InlineNotice(error, tone: .error, actionTitle: "Dismiss") { self.error = nil }
                    }
                }
                .padding(Spacing.gutter)
            }
        }
        .panelSheet([.medium, .large], interactiveUpThrough: nil)
        .task { await watch() }
        .sheet(isPresented: $composing) {
            LinkEditor(editor: editor, link: nil) { message in error = message }
        }
        .sheet(item: $editing) { link in
            LinkEditor(editor: editor, link: link) { message in error = message }
        }
    }

    private func watch() async {
        do {
            for try await value in editor.session.api.shareLinkUpdates(designId: editor.designId) {
                links = value.sorted { $0.createdAt > $1.createdAt }
                loaded = true
            }
        } catch {
            let mapped = DesynError(error)
            loaded = true
            if mapped.code == "FORBIDDEN" || mapped.code == "NOT_FOUND" {
                canManage = false
            } else if !mapped.isTransient {
                self.error = mapped.message
            } else {
                self.error = "You're offline. Share links appear when you're back online."
            }
        }
    }

    // MARK: Sections

    private var teammates: some View {
        PanelSection("Your team") {
            HStack(spacing: Spacing.sm) {
                Image(systemName: "person.2").foregroundStyle(Palette.sun).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Workspace members").font(.dsCallout).foregroundStyle(Palette.foreground)
                    Text("Open it with their own access").font(.dsCaption).foregroundStyle(Palette.muted)
                }
                Spacer()
                copyButton(id: "members", url: membersLink)
                ShareLink(item: membersLink) {
                    Image(systemName: "square.and.arrow.up").frame(width: 36, height: 36)
                }
                .foregroundStyle(Palette.foreground)
                .accessibilityLabel("Send the members link")
            }
            .padding(Spacing.md)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
    }

    private var linksSection: some View {
        PanelSection("Links", trailing: {
            Button {
                composing = true
            } label: {
                Label("New link", systemImage: "plus").font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
            }
            .foregroundStyle(Palette.sun)
        }) {
            if !loaded {
                HStack { Spacer(); SunSpinner(size: 22); Spacer() }.padding(.vertical, Spacing.lg)
            } else if links.isEmpty {
                VStack(alignment: .leading, spacing: Spacing.md) {
                    Text("Anyone with a link can open the design without an account. Choose whether they can view, comment or edit.")
                        .font(.dsCallout)
                        .foregroundStyle(Palette.muted)
                    DSButton("Create a link", systemImage: "link", kind: .primary) { composing = true }
                }
            } else {
                ForEach(links) { link in
                    linkRow(link)
                }
            }
        }
    }

    private func linkRow(_ link: DesignShareLink) -> some View {
        VStack(alignment: .leading, spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                Image(systemName: Self.icon(link.permission))
                    .foregroundStyle(link.expired ? Palette.muted : Palette.sun)
                    .frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(link.label?.isEmpty == false ? link.label! : Self.title(link.permission))
                        .font(DSFont.sans(15, weight: .semibold, relativeTo: .subheadline))
                        .foregroundStyle(Palette.foreground)
                    Text(details(link)).font(.dsCaption).foregroundStyle(link.expired ? Palette.danger : Palette.muted).lineLimit(2)
                }
                Spacer()
                if let url = URL(string: link.url), !link.expired {
                    copyButton(id: link.id, url: url)
                    ShareLink(item: url) {
                        Image(systemName: "square.and.arrow.up").frame(width: 36, height: 36)
                    }
                    .foregroundStyle(Palette.foreground)
                    .accessibilityLabel("Send this link")
                }
                Menu {
                    Button { editing = link } label: { Label("Change", systemImage: "slider.horizontal.3") }
                    Button(role: .destructive) { Task { await revoke(link) } } label: { Label("Turn off link", systemImage: "link.badge.plus") }
                } label: {
                    Image(systemName: "ellipsis").frame(width: 36, height: 36).foregroundStyle(Palette.muted)
                }
                .accessibilityLabel("Link options")
            }
            Text(link.url)
                .font(DSFont.mono(11))
                .foregroundStyle(Palette.muted)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
        }
        .padding(Spacing.md)
        .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
    }

    private func copyButton(id: String, url: URL) -> some View {
        Button {
            UIPasteboard.general.url = url
            copiedId = id
            Haptics.success()
            Task {
                try? await Task.sleep(for: .seconds(2))
                if copiedId == id { copiedId = nil }
            }
        } label: {
            Image(systemName: copiedId == id ? "checkmark" : "doc.on.doc")
                .foregroundStyle(copiedId == id ? Palette.success : Palette.foreground)
                .frame(width: 36, height: 36)
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityLabel(copiedId == id ? "Copied" : "Copy link")
    }

    private func details(_ link: DesignShareLink) -> String {
        var parts: [String] = []
        if link.hasPassword { parts.append("Password") }
        if link.expired {
            parts.append("Expired")
        } else if let expiry = link.expiryDate {
            parts.append("Until \(expiry.formatted(date: .abbreviated, time: .omitted))")
        } else {
            parts.append("No expiry")
        }
        if let used = link.lastUsedAt {
            parts.append("Opened \(RelativeDateTimeFormatter().localizedString(for: Date(timeIntervalSince1970: used / 1000), relativeTo: Date()))")
        }
        return parts.joined(separator: " · ")
    }

    private func revoke(_ link: DesignShareLink) async {
        do {
            try await editor.session.api.revokeShareLink(shareId: link.id)
            Haptics.light()
        } catch {
            self.error = DesynError(error).message
        }
    }

    public static func title(_ permission: String) -> String {
        switch permission {
        case "edit": "Can edit"
        case "comment": "Can comment"
        default: "Can view"
        }
    }

    public static func icon(_ permission: String) -> String {
        switch permission {
        case "edit": "pencil.circle"
        case "comment": "text.bubble"
        default: "eye.circle"
        }
    }
}

/// Create or change a link.
private struct LinkEditor: View {
    let editor: EditorModel
    let link: DesignShareLink?
    let onError: (String) -> Void

    @State private var permission = "view"
    @State private var usePassword = false
    @State private var password = ""
    @State private var expiry: TimeInterval?
    @State private var expiryChanged = false
    @State private var label = ""
    @State private var saving = false
    @State private var created: ShareLinkResult?
    @Environment(\.dismiss) private var dismiss

    private static let expiries: [(title: String, seconds: TimeInterval?)] = [
        ("Never", nil), ("1 day", 86_400), ("7 days", 604_800), ("30 days", 2_592_000),
    ]

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader(link == nil ? "new *link*" : "change *link*", subtitle: nil) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    if let created, let url = URL(string: created.url) {
                        VStack(alignment: .leading, spacing: Spacing.md) {
                            Label("Link ready", systemImage: "checkmark.seal.fill").font(.dsHeadline).foregroundStyle(Palette.sun)
                            Text(created.url).font(.dsMono).foregroundStyle(Palette.foreground).textSelection(.enabled)
                            ShareLink(item: url) {
                                Label("Send link", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(DSButtonStyle(.primary))
                            DSButton("Copy", systemImage: "doc.on.doc", kind: .secondary) {
                                UIPasteboard.general.url = url
                                Haptics.success()
                            }
                        }
                    } else {
                        PanelSection("People with the link") {
                            DSSegmentedControl(selection: $permission, options: [("view", "Can view"), ("comment", "Can comment"), ("edit", "Can edit")])
                            Text(permission == "edit" ? "They can change the design after signing in." : permission == "comment" ? "They can leave comments after signing in." : "They see the design; no account needed.")
                                .font(.dsFootnote)
                                .foregroundStyle(Palette.muted)
                        }
                        PanelSection("Protection") {
                            PanelToggle(link?.hasPassword == true && !usePassword ? "Remove password" : "Password", isOn: usePassword) { usePassword = $0 }
                            if usePassword {
                                DSTextField("", text: $password, prompt: link?.hasPassword == true ? "New password (leave empty to keep)" : "Password", kind: .newPassword)
                            }
                            Text("Expires").font(.dsFootnote).foregroundStyle(Palette.muted)
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: Spacing.sm) {
                                    ForEach(Self.expiries, id: \.title) { option in
                                        ChipButton(option.title, isSelected: expiry == option.seconds) {
                                            expiry = option.seconds
                                            expiryChanged = true
                                        }
                                    }
                                }
                            }
                        }
                        PanelSection("Name (optional)") {
                            DSTextField("", text: $label, prompt: "e.g. Client review", kind: .plain)
                        }
                        DSButton(link == nil ? "Create link" : "Save", systemImage: "link", kind: .primary, isLoading: saving) {
                            Task { await save() }
                        }
                        .disabled(usePassword && link?.hasPassword != true && password.count < 4)
                    }
                }
                .padding(Spacing.gutter)
            }
        }
        .dsSheet()
        .presentationDetents([.large])
        .onAppear {
            guard let link else { return }
            permission = link.permission
            usePassword = link.hasPassword
            label = link.label ?? ""
            expiry = nil
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let passwordValue: String?? = {
            if !usePassword { return link?.hasPassword == true ? .some(nil) : nil }
            if password.isEmpty { return nil }
            return .some(password)
        }()
        // An existing link keeps its expiry unless a new one was picked.
        let expiryValue: Date??
        if let expiry {
            expiryValue = .some(Date().addingTimeInterval(expiry))
        } else {
            expiryValue = link != nil && expiryChanged ? .some(nil) : nil
        }
        do {
            let result = try await editor.session.api.setShareLink(
                designId: editor.designId,
                shareId: link?.id,
                permission: permission,
                password: passwordValue,
                expiresAt: expiryValue,
                label: label.trimmingCharacters(in: .whitespaces).isEmpty ? nil : label.trimmingCharacters(in: .whitespaces)
            )
            Haptics.success()
            if link == nil {
                created = result
            } else {
                dismiss()
            }
        } catch {
            let mapped = DesynError(error)
            onError(mapped.code == "FEATURE_UNAVAILABLE" ? "Your plan doesn't include this kind of link. See your plan in Settings." : mapped.message)
            dismiss()
        }
    }
}
