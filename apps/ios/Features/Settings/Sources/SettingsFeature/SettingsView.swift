import DesignSystem
import DesynKit
import FeatureCore
import PanelKit
import SharedKit
import SwiftUI

/// Settings, opened from the avatar in the library: account, appearance, plan and usage, AI providers (a read-only
/// summary; keys are added on the web), devices and sign out. Plans are shown, never sold here (App Store rules:
/// no purchase UI or links to buy outside the app).
public struct SettingsView: View {
    @State private var model: SettingsModel
    @State private var name = ""
    @State private var confirmSignOut = false
    @State private var editingName = false
    @State private var showDeleteAccount = false
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark.rawValue
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    public init(session: AppSession) {
        _model = State(initialValue: SettingsModel(session: session))
    }

    private var session: AppSession { model.session }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.xl) {
                    header
                    if let error = model.errorMessage {
                        InlineNotice(error, tone: .info, actionTitle: "Dismiss") { model.errorMessage = nil }
                    }
                    account
                    appearanceSection
                    plan
                    aiSection
                    devicesSection
                    about
                    DSButton("Sign out", systemImage: "rectangle.portrait.and.arrow.right", kind: .danger) {
                        confirmSignOut = true
                    }
                    deleteAccountSection
                }
                .padding(Spacing.gutter)
                .padding(.bottom, Spacing.xxl)
            }
            .background { OrbsBackground(intensity: 0.25) }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .font(DSFont.sans(16, weight: .semibold, relativeTo: .body))
                        .foregroundStyle(Palette.sun)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
        }
        .tint(Palette.sun)
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.background)
        .task { await model.load() }
        .task { await model.watchProfile() }
        .task { await model.watchCredits() }
        .confirmationDialog("Sign out of Desyn?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign out", role: .destructive) {
                dismiss()
                Task { await session.signOut() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Designs saved on this \(DeviceName.current) for offline use are removed. Unsynced changes are lost.")
        }
        .sheet(isPresented: $showDeleteAccount) {
            DeleteAccountSheet(model: model) {
                showDeleteAccount = false
                dismiss()
            }
        }
        .onChange(of: appearance) { _, value in
            if let preference = AppearancePreference(rawValue: value) {
                Task { await model.syncAppearance(preference) }
            }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Spacing.lg) {
            ZStack {
                Circle().fill(Palette.sunGradient).frame(width: 64, height: 64).blur(radius: 18).opacity(0.5)
                Circle().fill(Palette.surface2).frame(width: 60, height: 60)
                    .overlay(Circle().strokeBorder(Palette.sun.opacity(0.6), lineWidth: 1.5))
                Text(initials).font(DSFont.serif(26)).foregroundStyle(Palette.foreground)
            }
            VStack(alignment: .leading, spacing: 4) {
                SerifHeadline(displayName, size: 28, relativeTo: .title)
                    .lineLimit(1)
                Text(model.profile?.email ?? session.user?.email ?? "").font(.dsCallout).foregroundStyle(Palette.muted).lineLimit(1)
                HStack(spacing: Spacing.xs) {
                    if model.planName.lowercased() == "pro" { ProPill() } else { DSBadge(model.planName, tone: .sun) }
                    DSBadge(session.isOnline ? "Online" : "Offline", tone: session.isOnline ? .success : .neutral)
                }
            }
        }
        .padding(.top, Spacing.sm)
    }

    private var displayName: String {
        model.profile?.displayName ?? session.profile?.displayName ?? "Account"
    }

    private var initials: String {
        let parts = displayName.split(separator: " ").prefix(2)
        let letters = parts.compactMap(\.first).map { String($0).uppercased() }.joined()
        return letters.isEmpty ? "?" : letters
    }

    // MARK: Account

    private var account: some View {
        SettingsCard("Account") {
            if editingName {
                HStack(spacing: Spacing.sm) {
                    DSTextField("", text: $name, prompt: "Your name", kind: .name, submitLabel: .done) {
                        Task { await model.rename(to: name); editingName = false }
                    }
                    DSButton("Save", kind: .primary, size: .small, isLoading: model.savingName) {
                        Task { await model.rename(to: name); editingName = false }
                    }
                    .frame(width: 90)
                }
            } else {
                row("Name", value: displayName) {
                    name = model.profile?.name ?? ""
                    editingName = true
                }
            }
            row("Email", value: model.profile?.email ?? session.user?.email ?? "", action: nil)
            if session.workspaces.count > 1, let current = session.currentWorkspace {
                Menu {
                    ForEach(session.workspaces) { workspace in
                        Button {
                            session.workspaceId = workspace.id
                        } label: {
                            if workspace.id == current.id { Label(workspace.name, systemImage: "checkmark") } else { Text(workspace.name) }
                        }
                    }
                } label: {
                    rowLabel("Workspace", value: current.name, chevron: true)
                }
            }
            linkRow("Password, email and account", url: model.webSettingsURL.appendingPathComponent("profile"))
        }
    }

    // MARK: Appearance

    private var appearanceSection: some View {
        SettingsCard("Appearance") {
            DSSegmentedControl(selection: $appearance, options: AppearancePreference.allCases.map { ($0.rawValue, $0.title) })
            Text("Desyn is designed dark first, like a sun on a night sky. Light is fully designed too.")
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
        }
    }

    // MARK: Plan

    private var plan: some View {
        SettingsCard("Plan and usage") {
            HStack {
                Text(model.planName).font(DSFont.serif(24)).foregroundStyle(Palette.foreground)
                Spacer()
                if let renewal = model.subscription?.renewalDate, model.subscription?.subscription?.cancelAtPeriodEnd != true {
                    Text("Renews \(renewal.formatted(date: .abbreviated, time: .omitted))").font(.dsCaption).foregroundStyle(Palette.muted)
                } else if let end = model.subscription?.renewalDate {
                    Text("Ends \(end.formatted(date: .abbreviated, time: .omitted))").font(.dsCaption).foregroundStyle(Palette.danger)
                }
            }
            if let credits = model.credits {
                CreditsGauge(credits: credits)
            }
            if let usage = model.usage {
                ForEach(SettingsModel.meterOrder.filter { usage.meters[$0] != nil }, id: \.self) { key in
                    if let meter = usage.meters[key] {
                        MeterRow(title: SettingsModel.meterTitle(key), meter: meter, format: { SettingsModel.meterValue(key, $0) })
                    }
                }
            }
            Text(model.isSelfHosted
                ? "This is a self-hosted Desyn: every feature is included."
                : "Your plan is managed in your Desyn account and applies on every device you sign in on.")
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
        }
    }

    // MARK: AI

    private var aiSection: some View {
        SettingsCard("AI providers") {
            if let ai = model.ai {
                let ready = ai.providers.filter(\.available)
                if ready.isEmpty {
                    Text("No AI provider is available yet.").font(.dsCallout).foregroundStyle(Palette.muted)
                }
                ForEach(ready) { provider in
                    HStack(spacing: Spacing.sm) {
                        Image(systemName: provider.local ? "desktopcomputer" : provider.key != nil ? "key.fill" : "cloud")
                            .foregroundStyle(Palette.sun)
                            .frame(width: 24)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.label).font(.dsCallout).foregroundStyle(Palette.foreground)
                            Text(source(provider)).font(.dsCaption).foregroundStyle(Palette.muted)
                        }
                        Spacer()
                        Text(provider.kinds.joined(separator: ", ")).font(.dsCaption).foregroundStyle(Palette.muted).lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
                DSDivider()
                ForEach(ai.tasks.prefix(6)) { task in
                    HStack {
                        Text(task.label).font(.dsFootnote).foregroundStyle(Palette.muted)
                        Spacer()
                        Text(task.model.split(separator: ":").last.map(String.init) ?? task.model)
                            .font(DSFont.mono(11))
                            .foregroundStyle(task.available ? Palette.foreground : Palette.danger)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                if ai.byokAllowed {
                    linkRow("Add your own API keys", url: model.webSettingsURL.appendingPathComponent("ai"))
                    Text("Keys are encrypted on the server and never shown again. Runs with your own key use no credits.")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                }
            } else {
                HStack { SunSpinner(size: 18); Text("Loading").font(.dsFootnote).foregroundStyle(Palette.muted) }
            }
        }
    }

    private func source(_ provider: AIPreferences.Provider) -> String {
        if let key = provider.key {
            return "Your key\(key.last4.map { " ··\($0)" } ?? "")\(key.label.map { " · \($0)" } ?? "")"
        }
        if provider.local { return "Local model" }
        return provider.server ? "Included with Desyn" : "Not set up"
    }

    // MARK: Devices

    private var devicesSection: some View {
        SettingsCard("Signed-in devices") {
            if model.devices.isEmpty {
                Text("Devices load when you're online.").font(.dsFootnote).foregroundStyle(Palette.muted)
            }
            ForEach(model.devices) { device in
                HStack(spacing: Spacing.sm) {
                    Image(systemName: device.current ? "iphone" : "laptopcomputer").foregroundStyle(device.current ? Palette.sun : Palette.muted).frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(SettingsModel.deviceName(device.userAgent) + (device.current ? " · this device" : ""))
                            .font(.dsCallout)
                            .foregroundStyle(Palette.foreground)
                        if let last = device.lastActiveAt {
                            Text("Active \(RelativeDate.string(for: Date(timeIntervalSince1970: last / 1000)).lowercased())").font(.dsCaption).foregroundStyle(Palette.muted)
                        }
                    }
                    Spacer()
                    if !device.current {
                        Button("Sign out") { Task { await model.revoke(device) } }
                            .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                            .foregroundStyle(Palette.danger)
                            .frame(minHeight: Spacing.touchTarget)
                    }
                }
            }
        }
    }

    // MARK: Delete account

    private var deleteAccountSection: some View {
        SettingsCard("Delete account") {
            Text("Removes your account, your designs and uploads for good. Workspaces you share with others stay with them.")
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
            Button {
                showDeleteAccount = true
            } label: {
                Text("Delete account…")
                    .font(DSFont.sans(15, weight: .semibold, relativeTo: .callout))
                    .foregroundStyle(Palette.danger)
                    .frame(minHeight: Spacing.touchTarget)
            }
            .buttonStyle(PressScaleStyle())
        }
    }

    // MARK: About

    private var about: some View {
        SettingsCard("About") {
            row("Version", value: Self.version, action: nil)
            linkRow("Help and docs", url: URL(string: "https://docs.\(model.siteURL.host ?? "desyn.app")") ?? model.siteURL)
            linkRow("Privacy", url: model.siteURL.appendingPathComponent("legal/privacy"))
            linkRow("Terms", url: model.siteURL.appendingPathComponent("legal/terms"))
            linkRow("License", url: model.siteURL.appendingPathComponent("legal/license"))
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = info?["CFBundleVersion"] as? String ?? "1"
        return "\(short) (\(build))"
    }

    // MARK: Rows

    private func row(_ title: String, value: String, action: (() -> Void)?) -> some View {
        Group {
            if let action {
                Button(action: action) { rowLabel(title, value: value, chevron: true) }.buttonStyle(.plain)
            } else {
                rowLabel(title, value: value, chevron: false)
            }
        }
    }

    private func rowLabel(_ title: String, value: String, chevron: Bool) -> some View {
        HStack {
            Text(title).font(.dsCallout).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).font(.dsCallout).foregroundStyle(Palette.foreground).lineLimit(1)
            if chevron { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Palette.muted) }
        }
        .frame(minHeight: Spacing.touchTarget)
        .contentShape(Rectangle())
    }

    private func linkRow(_ title: String, url: URL) -> some View {
        Button {
            openURL(url)
        } label: {
            HStack {
                Text(title).font(.dsCallout).foregroundStyle(Palette.foreground)
                Spacer()
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(Palette.muted)
            }
            .frame(minHeight: Spacing.touchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens in the browser")
    }
}

/// A glass card with an eyebrow title.
private struct SettingsCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    init(_ title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text(title).dsEyebrow().accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                content()
            }
            .padding(Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .dsGlass(cornerRadius: Radius.panel)
        }
    }
}

/// The month's AI credits as a sun arc.
private struct CreditsGauge: View {
    let credits: CreditBalance

    var body: some View {
        HStack(spacing: Spacing.lg) {
            ZStack {
                Circle().stroke(Palette.surface3, lineWidth: 8)
                Circle()
                    .trim(from: 0, to: CGFloat(credits.usedFraction ?? 0))
                    .stroke(Palette.sunGradient, style: StrokeStyle(lineWidth: 8, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(credits.remaining.map { "\(Int($0))" } ?? "∞").font(DSFont.serif(22)).foregroundStyle(Palette.foreground)
            }
            .frame(width: 72, height: 72)
            VStack(alignment: .leading, spacing: 4) {
                Text("AI credits").font(DSFont.sans(15, weight: .semibold, relativeTo: .subheadline)).foregroundStyle(Palette.foreground)
                if let granted = credits.granted {
                    Text("\(Int(credits.used)) of \(Int(granted)) used this month").font(.dsFootnote).foregroundStyle(Palette.muted)
                } else {
                    Text("Unlimited on this server").font(.dsFootnote).foregroundStyle(Palette.muted)
                }
                if credits.throttled {
                    Text("You're past this month's pool: AI runs a little slower until it renews. Nothing extra is charged.")
                        .font(.dsCaption)
                        .foregroundStyle(Palette.sun)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct MeterRow: View {
    let title: String
    let meter: UsageSummary.Meter
    let format: (Double) -> String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title).font(.dsFootnote).foregroundStyle(Palette.muted)
                Spacer()
                Text(meter.limit.map { "\(format(meter.used)) of \(format($0))" } ?? format(meter.used))
                    .font(DSFont.mono(12))
                    .foregroundStyle(Palette.foreground)
            }
            if let ratio = meter.ratio {
                GeometryReader { proxy in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Palette.surface3)
                        Capsule().fill(ratio > 0.9 ? AnyShapeStyle(Palette.danger) : AnyShapeStyle(Palette.sunGradient))
                            .frame(width: max(6, proxy.size.width * CGFloat(ratio)))
                    }
                }
                .frame(height: 6)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Confirms deleting the account: what goes away, the password (needed unless the person signed in within the last
/// day), and a typed confirmation, so it never happens by accident.
private struct DeleteAccountSheet: View {
    let model: SettingsModel
    let onDeleted: () -> Void
    @State private var password = ""
    @State private var confirmation = ""
    @Environment(\.dismiss) private var dismiss

    private var confirmed: Bool { confirmation.trimmingCharacters(in: .whitespaces).uppercased() == "DELETE" }

    var body: some View {
        VStack(spacing: 0) {
            SheetHeader("delete your *account*", subtitle: model.profile?.email ?? model.session.user?.email) { dismiss() }
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.lg) {
                    Text("This can't be undone. Your designs, uploads, brand kits and AI history are deleted, and you're signed out on every device.")
                        .font(.dsCallout)
                        .foregroundStyle(Palette.foreground)
                    DSTextField("Password", text: $password, prompt: "Your password", kind: .password, submitLabel: .next)
                    Text("Signed in with a link or Google? Leave the password empty. If it's been more than a day since you signed in, sign out and in again first.")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                    DSTextField("Type DELETE to confirm", text: $confirmation, prompt: "DELETE", kind: .plain, submitLabel: .done)
                    if let error = model.deleteError {
                        InlineNotice(error, tone: .error)
                    }
                    DSButton("Delete my account", systemImage: "trash", kind: .danger, isLoading: model.deleting) {
                        Task {
                            if await model.deleteAccount(password: password) { onDeleted() }
                        }
                    }
                    .disabled(!confirmed || model.deleting)
                    .opacity(confirmed ? 1 : 0.5)
                }
                .padding(Spacing.gutter)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(Palette.background)
        .interactiveDismissDisabled(model.deleting)
        .onAppear { model.deleteError = nil }
    }
}
