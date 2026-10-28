import AuthFeature
import DesignSystem
import DesynKit
import EditorFeature
import FeatureCore
import LibraryFeature
import SwiftUI

/// Composition root: the account session plus the screen models that live as long as the app.
@MainActor
@Observable
public final class AppModel {
    public let session: AppSession
    public let auth: AuthModel
    public private(set) var library: LibraryModel
    public var openDesign: DesignRoute?

    public init(environment: AppEnvironment = .from(bundle: .main)) {
        let session = AppSession(environment: environment)
        self.session = session
        auth = AuthModel(session: session)
        library = LibraryModel(session: session)
    }

    public func start() async {
        await session.start()
    }

    /// Universal links and `desyn://` links.
    public func handle(url: URL) async {
        if let handler = Self.linkHandler, await handler(url, self) { return }
        guard let link = DeepLink(url: url, appURL: session.environment.appURL) else { return }
        switch link {
        case let .magicLink(token):
            if session.phase == .signedIn {
                session.toasts.show("You're already signed in.")
            } else {
                await auth.completeMagicLink(token: token)
            }
        case .magicLinkUsedInBrowser:
            if session.phase != .signedIn {
                await auth.magicLinkUsedInBrowser()
            }
        case let .design(id):
            guard session.phase == .signedIn else {
                session.toasts.show("Sign in to open this design.")
                return
            }
            openDesign = DesignRoute(designId: id, name: "Design")
        case let .share(token):
            guard session.phase == .signedIn else {
                session.toasts.show("Sign in to open this shared design.")
                return
            }
            do {
                let joined = try await session.api.joinShare(token: token)
                openDesign = DesignRoute(designId: joined.designId, name: "Shared design", share: ShareAccess(token: token))
            } catch {
                session.toasts.show(DesynError(error).message, tone: .error)
            }
        }
    }

    /// A fresh library for a new account (signing out drops the old one).
    func resetForNewAccount() {
        library = LibraryModel(session: session)
        openDesign = nil
        auth.go(.welcome)
    }
}

/// The app's root: launch, sign-in or the library, with the editor full screen on top.
public struct RootView: View {
    @Bindable private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase
    /// Dark-first; "system" and "light" are fully designed alternatives (Account sheet).
    @AppStorage(AppearancePreference.storageKey) private var appearance = AppearancePreference.dark.rawValue

    public init(model: AppModel) {
        self.model = model
    }

    public var body: some View {
        ZStack {
            Palette.background.ignoresSafeArea()
            switch model.session.phase {
            case .launching:
                ZStack {
                    OrbsBackground()
                    VStack(spacing: Spacing.lg) {
                        SunMark(size: 30)
                        SunSpinner(size: 30)
                    }
                }
                .transition(.opacity)
            case .signedOut:
                AuthRootView(model: model.auth)
                    .transition(.opacity)
            case .signedIn:
                NavigationStack {
                    LibraryView(model: model.library) { route in
                        model.openDesign = route
                    }
                }
                .tint(Palette.sun)
                .transition(.opacity)
            }
        }
        .animation(Motion.easeOut(0.5), value: model.session.phase)
        .fullScreenCover(item: $model.openDesign) { route in
            EditorView(route: route, session: model.session) {
                model.openDesign = nil
            }
            .dsToasts(model.session.toasts)
        }
        .dsToasts(model.session.toasts)
        .onChange(of: model.session.phase) { old, new in
            if old == .signedIn, new == .signedOut {
                model.resetForNewAccount()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active, model.session.phase == .signedIn {
                Task { await model.session.refreshAccount() }
            }
        }
        .task { await model.start() }
        // Universal links (magic links, design and share links on the web app's domain) and desyn:// links.
        .onOpenURL { url in
            Task { await model.handle(url: url) }
        }
        .tint(Palette.sun)
        .preferredColorScheme((AppearancePreference(rawValue: appearance) ?? .dark).colorScheme)
    }
}
