import DesignSystem
import DesynKit
import Foundation
import Observation

/// The app's account state: who is signed in, the Convex client authenticated as them, their workspaces, the
/// per-account offline store, connectivity and the toast queue. Offline-first: with a session in the keychain the
/// app opens straight into the (cached) library and authenticates in the background.
@MainActor
@Observable
public final class AppSession {
    public enum Phase: Equatable, Sendable {
        case launching
        case signedOut
        case signedIn
    }

    public let environment: AppEnvironment
    public let auth: AuthClient
    public let api: DesynAPI
    public let toasts = ToastCenter()

    public private(set) var phase: Phase = .launching
    public private(set) var user: StoredSession.User?
    public private(set) var profile: Profile?
    public private(set) var workspaces: [Workspace] = []
    public private(set) var config: BackendConfig?
    /// The Convex websocket is connected.
    public private(set) var isOnline = true
    /// The Convex client holds a valid identity (queries run as the user).
    public private(set) var isAuthenticated = false
    public private(set) var store: OfflineStore?
    /// The design an editor is syncing right now (background work leaves it alone).
    public var openDesignId: String?

    public var workspaceId: String? {
        didSet {
            guard let workspaceId, let user else { return }
            UserDefaults.standard.set(workspaceId, forKey: "workspace.\(user.id)")
        }
    }

    @ObservationIgnored private let sessionStore: SecureStore
    @ObservationIgnored private let provider: DesynAuthProvider
    @ObservationIgnored private let transport: ConvexTransportClient
    @ObservationIgnored private var connectionTask: Task<Void, Never>?

    public init(environment: AppEnvironment, sessionStore: SecureStore = KeychainSessionStore()) {
        self.environment = environment
        self.sessionStore = sessionStore
        auth = AuthClient(environment: environment)
        provider = DesynAuthProvider(auth: auth, store: sessionStore)
        transport = ConvexTransportClient(deploymentURL: environment.convexURL, authProvider: provider)
        api = DesynAPI(transport: transport)
        provider.onSessionEnded = { [weak self] in
            Task { @MainActor in await self?.sessionEnded() }
        }
    }

    public var currentWorkspace: Workspace? {
        workspaces.first { $0.id == workspaceId } ?? workspaces.first
    }

    // MARK: Launch

    /// Restores the stored session (or shows sign-in) and starts watching connectivity.
    public func start() async {
        watchConnection()
        Task { [weak self] in await self?.loadConfig() }
        guard let stored = try? sessionStore.load() else {
            phase = .signedOut
            return
        }
        enterSignedIn(user: stored.user)
        await authenticate()
    }

    /// Auth methods the server offers (Google / GitHub buttons appear only when configured).
    public func loadConfig() async {
        if let config = try? await api.config() {
            self.config = config
        }
    }

    // MARK: Sign in / out

    /// Stores a new session (from any sign-in method) and opens the library.
    public func completeSignIn(_ session: StoredSession) async throws {
        do {
            try sessionStore.save(session)
        } catch {
            throw DesynError.unexpected(error.localizedDescription)
        }
        enterSignedIn(user: session.user)
        await authenticate()
    }

    /// Signs out on the server (best effort), forgets the keychain session and this account's cached data.
    public func signOut() async {
        let stored = try? sessionStore.load()
        if let token = stored?.sessionToken {
            try? await auth.signOut(sessionToken: token)
        }
        await resetLocalState(clearCache: true)
    }

    /// Deletes the account on the server, then clears everything this device keeps for it (keychain session,
    /// offline cache). Throws the server's reason (wrong password, session too old) and changes nothing then.
    /// Added by the ios features agent (settings, App Store guideline 5.1.1(v)).
    public func deleteAccount(password: String?) async throws {
        guard let token = try sessionStore.load()?.sessionToken else { throw DesynError.unauthenticated }
        try await auth.deleteAccount(sessionToken: token, password: password)
        await resetLocalState(clearCache: true)
    }

    /// The server ended the session (revoked, expired). The user did not ask to sign out, so this account's
    /// cache stays on the device: offline edits that have not synced yet go out after the next sign-in.
    private func sessionEnded() async {
        guard phase == .signedIn else { return }
        toasts.show("Your session ended. Sign in again to continue.", tone: .error)
        await resetLocalState(clearCache: false)
    }

    private func resetLocalState(clearCache: Bool) async {
        await transport.client.logout()
        try? sessionStore.clear()
        if clearCache { store?.clearAll() }
        store = nil
        profile = nil
        user = nil
        workspaces = []
        workspaceId = nil
        isAuthenticated = false
        phase = .signedOut
    }

    private func enterSignedIn(user: StoredSession.User) {
        self.user = user
        let store = OfflineStore(userId: user.id)
        self.store = store
        if let cached = store.loadList(CachedAccount.self, key: "account") {
            workspaces = cached.workspaces
            profile = cached.profile
        }
        workspaceId = UserDefaults.standard.string(forKey: "workspace.\(user.id)") ?? profile?.defaultWorkspaceId ?? workspaces.first?.id
        phase = .signedIn
    }

    /// Hands the keychain session to the Convex client, then loads the profile and workspaces.
    private func authenticate() async {
        switch await transport.client.loginFromCache() {
        case .success:
            isAuthenticated = true
            await refreshAccount()
        case let .failure(error):
            let mapped = DesynError(error)
            if mapped == .unauthenticated {
                await sessionEnded()
            } else {
                // Offline: keep the cached library; retry when the connection returns.
                isAuthenticated = false
            }
        }
    }

    /// Reloads profile and workspaces (provisioning the account on first sign-in).
    public func refreshAccount() async {
        do {
            var me = try await api.me()
            if me?.provisioned == false {
                _ = try await api.ensureProfile()
                me = try await api.me()
            }
            profile = me
            workspaces = try await api.workspaces()
            if workspaceId == nil || !workspaces.contains(where: { $0.id == workspaceId }) {
                workspaceId = profile?.defaultWorkspaceId ?? workspaces.first(where: \.isDefault)?.id ?? workspaces.first?.id
            }
            if let profile {
                store?.saveList(CachedAccount(profile: profile, workspaces: workspaces), key: "account")
            }
        } catch {
            let mapped = DesynError(error)
            if mapped == .unauthenticated {
                await sessionEnded()
            } else if !mapped.isTransient {
                toasts.show(mapped.message, tone: .error)
            }
        }
    }

    // MARK: Connectivity

    private func watchConnection() {
        guard connectionTask == nil else { return }
        let states = transport.connectionStates()
        connectionTask = Task { [weak self] in
            for await connected in states {
                guard let self else { return }
                let wasOnline = self.isOnline
                self.isOnline = connected
                if connected, !wasOnline, self.phase == .signedIn, !self.isAuthenticated {
                    await self.authenticate()
                }
            }
        }
    }
}

/// Profile + workspaces cached for offline launches.
private struct CachedAccount: Codable {
    let profile: Profile
    let workspaces: [Workspace]
}
