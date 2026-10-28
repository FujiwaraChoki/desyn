import DesynKit
import Foundation

/// The fields of `accounts/profiles:me` the settings screens show (DesynKit's `Profile` holds the core ones).
public struct AccountProfile: Decodable, Hashable, Sendable {
    public struct Appearance: Decodable, Hashable, Sendable {
        public let theme: String?
        public let reducedMotion: Bool?
        public let canvasGrid: Bool?
        public let snapping: Bool?
    }

    public let userId: String
    public let email: String
    public let name: String?
    public let image: String?
    public let emailVerified: Bool?
    public let edition: String?
    public let plan: String?
    public let planName: String?
    /// Plan features resolved for this person (plan + feature flags).
    public let features: [String: Bool]?
    public let role: String?
    public let isAdmin: Bool?
    public let locale: String?
    public let timezone: String?
    public let appearance: Appearance?
    public let marketingOptIn: Bool?
    public let createdAt: Double?

    public var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return email.split(separator: "@").first.map(String.init) ?? email
    }

    /// Self-hosters get every feature; billing never shows there.
    public var isSelfHosted: Bool { edition != nil && edition != "hosted" }
}

/// `billing/subscription:status`.
public struct SubscriptionStatus: Decodable, Hashable, Sendable {
    public struct Subscription: Decodable, Hashable, Sendable {
        public let status: String
        public let interval: String?
        public let currentPeriodEnd: Double?
        public let cancelAtPeriodEnd: Bool?
    }

    public let edition: String
    public let plan: String
    public let planName: String
    public let overridden: Bool?
    /// False on self-host (no billing UI at all).
    public let enabled: Bool
    public let subscription: Subscription?

    public var renewalDate: Date? { subscription?.currentPeriodEnd.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

/// `billing/credits:balance`.
public struct CreditBalance: Decodable, Hashable, Sendable {
    public let period: String
    public let plan: String
    /// Monthly pool; nil = unlimited (self-host).
    public let granted: Double?
    public let used: Double
    public let reserved: Double
    public let overage: Double
    public let remaining: Double?
    public let throttled: Bool

    /// Share of the pool used, 0...1 (nil when unlimited).
    public var usedFraction: Double? {
        guard let granted, granted > 0 else { return nil }
        return min(1, max(0, (used + reserved) / granted))
    }
}

/// `billing/usage:summary`.
public struct UsageSummary: Decodable, Sendable {
    public struct Meter: Decodable, Hashable, Sendable {
        public let used: Double
        /// nil = unlimited.
        public let limit: Double?
        public let ratio: Double?
    }

    public let period: String
    public let plan: String
    public let planName: String
    public let meters: [String: Meter]
}

/// `accounts/sessions:list` item.
public struct DeviceSession: Decodable, Hashable, Sendable, Identifiable {
    public let id: String
    public let current: Bool
    public let createdAt: Double
    public let lastActiveAt: Double?
    public let expiresAt: Double?
    public let ipAddress: String?
    public let userAgent: String?
}

public extension DesynAPI {
    /// The signed-in profile with settings fields (live).
    func accountProfileUpdates() -> AsyncThrowingStream<AccountProfile?, Error> {
        transport.subscribe("accounts/profiles:me", args: [:], as: AccountProfile?.self)
    }

    func updateProfile(name: String? = nil, appearanceTheme: String? = nil, reducedMotion: Bool? = nil, marketingOptIn: Bool? = nil) async throws {
        var args: ConvexArgs = [:]
        if let name { args["name"] = name }
        var appearance: ConvexArgs = [:]
        if let appearanceTheme { appearance["theme"] = appearanceTheme }
        if let reducedMotion { appearance["reducedMotion"] = reducedMotion }
        if !appearance.isEmpty { args["appearance"] = appearance }
        if let marketingOptIn { args["marketingOptIn"] = marketingOptIn }
        guard !args.isEmpty else { return }
        _ = try await transport.mutation("accounts/profiles:update", args: args, as: JSONValue.self)
    }

    func subscriptionStatus() async throws -> SubscriptionStatus {
        try await transport.query("billing/subscription:status", args: [:], as: SubscriptionStatus.self)
    }

    /// Credit balance (live: AI runs settle while the screen is open).
    func creditBalanceUpdates() -> AsyncThrowingStream<CreditBalance, Error> {
        transport.subscribe("billing/credits:balance", args: [:], as: CreditBalance.self)
    }

    func usageSummary() async throws -> UsageSummary {
        try await transport.query("billing/usage:summary", args: [:], as: UsageSummary.self)
    }

    func deviceSessions() async throws -> [DeviceSession] {
        try await transport.query("accounts/sessions:list", args: [:], as: [DeviceSession].self)
    }

    func revokeDeviceSession(sessionId: String) async throws {
        _ = try await transport.mutation("accounts/sessions:revoke", args: ["sessionId": sessionId], as: JSONValue.self)
    }
}
