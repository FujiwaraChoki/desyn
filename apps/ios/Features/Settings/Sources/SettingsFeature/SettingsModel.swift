import DesignSystem
import DesynKit
import FeatureCore
import Foundation
import Observation
import SharedKit

/// Settings data: the profile, plan and credits (live), usage, the AI provider summary (no secrets) and devices.
@MainActor
@Observable
public final class SettingsModel {
    public let session: AppSession

    public private(set) var profile: AccountProfile?
    public private(set) var subscription: SubscriptionStatus?
    public private(set) var credits: CreditBalance?
    public private(set) var usage: UsageSummary?
    public private(set) var ai: AIPreferences?
    public private(set) var devices: [DeviceSession] = []
    public var errorMessage: String?
    public var savingName = false

    public init(session: AppSession) {
        self.session = session
    }

    /// The marketing site (legal pages, docs): `app.desyn.app` -> `desyn.app`.
    public var siteURL: URL {
        let app = session.environment.appURL
        guard var components = URLComponents(url: app, resolvingAgainstBaseURL: false), let host = components.host, host.hasPrefix("app.") else {
            return app
        }
        components.host = String(host.dropFirst(4))
        components.path = ""
        return components.url ?? app
    }

    public var webSettingsURL: URL { session.environment.appURL.appendingPathComponent("settings") }

    public var isSelfHosted: Bool {
        (subscription.map { !$0.enabled } ?? false) || profile?.isSelfHosted == true
    }

    /// Loads everything once; the profile and credits stay live while `watch` runs.
    public func load() async {
        async let subscription = try? session.api.subscriptionStatus()
        async let usage = try? session.api.usageSummary()
        async let ai = try? session.api.aiPreferences()
        async let devices = try? session.api.deviceSessions()
        self.subscription = await subscription
        self.usage = await usage
        self.ai = await ai
        self.devices = (await devices ?? []).sorted { ($0.current ? 1 : 0, $0.lastActiveAt ?? 0) > ($1.current ? 1 : 0, $1.lastActiveAt ?? 0) }
        if self.subscription == nil, profile == nil, !session.isOnline {
            errorMessage = "You're offline. Settings that need the server load when you're back online."
        }
    }

    public func watchProfile() async {
        do {
            for try await value in session.api.accountProfileUpdates() {
                profile = value
            }
        } catch {
            // Offline: the cached profile of the session still shows the essentials.
        }
    }

    public func watchCredits() async {
        do {
            for try await value in session.api.creditBalanceUpdates() {
                credits = value
            }
        } catch {
            // Credits are informational; leave the last value.
        }
    }

    public func rename(to name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != profile?.name else { return }
        savingName = true
        defer { savingName = false }
        do {
            try await session.api.updateProfile(name: trimmed)
            await session.refreshAccount()
            Haptics.success()
        } catch {
            errorMessage = DesynError(error).message
        }
    }

    /// Stores the appearance on the account too, so the web app and other devices follow it.
    public func syncAppearance(_ preference: AppearancePreference) async {
        try? await session.api.updateProfile(appearanceTheme: preference.rawValue)
    }

    public func revoke(_ device: DeviceSession) async {
        do {
            try await session.api.revokeDeviceSession(sessionId: device.id)
            devices.removeAll { $0.id == device.id }
            Haptics.light()
        } catch {
            errorMessage = DesynError(error).message
        }
    }

    /// Deletes the account (and signs this device out). Returns false with `deleteError` set when the server
    /// refuses (wrong password, session too old to delete without one).
    public private(set) var deleting = false
    public var deleteError: String?

    @discardableResult
    public func deleteAccount(password: String) async -> Bool {
        guard !deleting else { return false }
        deleting = true
        deleteError = nil
        defer { deleting = false }
        do {
            let trimmed = password.trimmingCharacters(in: .newlines)
            try await session.deleteAccount(password: trimmed.isEmpty ? nil : trimmed)
            return true
        } catch {
            let mapped = DesynError(error)
            deleteError = mapped.isTransient ? "You're offline. Connect to delete your account." : mapped.message
            Haptics.error()
            return false
        }
    }

    // MARK: Formatting

    /// "Pro", "Free", "Self-hosted".
    public var planName: String {
        subscription?.planName ?? profile?.planName ?? session.profile?.planName ?? "Free"
    }

    public static func meterTitle(_ key: String) -> String {
        switch key {
        case "designs": "Designs"
        case "storageBytes": "Storage"
        case "exports": "Exports this month"
        case "brandKits": "Brand kits"
        case "workspaces": "Workspaces"
        case "aiRequests": "AI requests this month"
        case "uploads": "Uploads this month"
        default: key
        }
    }

    public static let meterOrder = ["designs", "storageBytes", "exports", "aiRequests", "uploads", "brandKits", "workspaces"]

    public static func meterValue(_ key: String, _ value: Double) -> String {
        if key == "storageBytes" {
            return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
        }
        return value.rounded() == value ? String(Int(value)) : String(format: "%.1f", value)
    }

    /// "Chrome on macOS", "Desyn for iOS", from a user agent.
    public static func deviceName(_ userAgent: String?) -> String {
        guard let agent = userAgent?.lowercased(), !agent.isEmpty else { return "Unknown device" }
        if agent.contains("desyn-ios") || agent.contains("cfnetwork") { return "Desyn for iPhone and iPad" }
        if agent.contains("desyn-desktop") { return "Desyn desktop" }
        let browser = agent.contains("edg/") ? "Edge" : agent.contains("firefox") ? "Firefox" : agent.contains("chrome") ? "Chrome" : agent.contains("safari") ? "Safari" : "Browser"
        let system = agent.contains("iphone") ? "iPhone" : agent.contains("ipad") ? "iPad" : agent.contains("mac os") ? "macOS" : agent.contains("windows") ? "Windows" : agent.contains("android") ? "Android" : agent.contains("linux") ? "Linux" : nil
        return system.map { "\(browser) on \($0)" } ?? browser
    }
}
