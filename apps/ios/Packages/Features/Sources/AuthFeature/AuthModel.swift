import DesignSystem
import DesynKit
import FeatureCore
import Foundation
import Observation
import UIKit

/// State of the sign-in screens. Every method reports failures through `errorMessage` (a sentence that says
/// what to do next) and never throws to the view.
@MainActor
@Observable
public final class AuthModel {
    public enum Screen: Equatable, Sendable {
        case welcome
        case signIn
        case signUp
        case magicLinkSent(email: String)
        case verifyEmail(email: String)
        case forgotPassword
        case resetSent(email: String)
    }

    public enum Field: Hashable, Sendable {
        case name, email, password
    }

    public var screen: Screen = .welcome
    public var name = ""
    public var email = ""
    public var password = ""
    public private(set) var isWorking = false
    public var errorMessage: String?
    public private(set) var fieldErrors: [Field: String] = [:]

    public let session: AppSession
    @ObservationIgnored private let web = WebAuthenticator()

    public init(session: AppSession) {
        self.session = session
    }

    public var methods: AuthMethods {
        session.config?.authMethods ?? AuthMethods(emailPassword: true, magicLink: true, google: false, github: false)
    }

    public func go(_ screen: Screen) {
        errorMessage = nil
        fieldErrors = [:]
        self.screen = screen
    }

    // MARK: Email + password

    public func signIn() async {
        guard validate([.email, .password]) else { return }
        await run {
            do {
                let stored = try await self.session.auth.signIn(email: self.normalizedEmail, password: self.password)
                try await self.session.completeSignIn(stored)
                self.password = ""
            } catch let error as DesynError where error.code == "EMAIL_NOT_VERIFIED" {
                self.screen = .verifyEmail(email: self.normalizedEmail)
            }
        }
    }

    public func signUp() async {
        guard validate([.name, .email, .password]) else { return }
        await run {
            let outcome = try await self.session.auth.signUp(
                name: self.name.trimmingCharacters(in: .whitespacesAndNewlines),
                email: self.normalizedEmail,
                password: self.password
            )
            switch outcome {
            case let .signedIn(stored):
                try await self.session.completeSignIn(stored)
                self.password = ""
            case let .verificationRequired(email):
                self.screen = .verifyEmail(email: email)
            }
        }
    }

    /// After verifying in the browser: sign in with the password still in memory.
    public func continueAfterVerification() async {
        if password.isEmpty {
            go(.signIn)
            return
        }
        await signIn()
    }

    public func resendVerification(email: String) async {
        await run {
            try await self.session.auth.resendVerification(email: email)
            self.session.toasts.show("We sent a new verification email.", tone: .success)
        }
    }

    // MARK: Magic link

    public func sendMagicLink() async {
        guard validate([.email]) else { return }
        await run {
            try await self.session.auth.sendMagicLink(email: self.normalizedEmail)
            self.screen = .magicLinkSent(email: self.normalizedEmail)
        }
    }

    /// A magic link opened the app (universal link).
    public func completeMagicLink(token: String) async {
        await run {
            let stored = try await self.session.auth.verifyMagicLink(token: token)
            try await self.session.completeSignIn(stored)
        }
    }

    /// The link was opened in the browser instead of the app: finish with the browser flow, which reuses the
    /// browser's fresh session.
    public func magicLinkUsedInBrowser() async {
        await continueInBrowser()
    }

    // MARK: Browser (OAuth providers, SSO, passkeys on the web)

    /// Native flow (convex/accounts/nativeAuth.ts): PKCE + `/native/authorize` in an authentication session, then the code
    /// exchange at `/auth/native/token`.
    public func continueInBrowser() async {
        await run {
            let pkce = PKCE()
            let callback: URL
            do {
                callback = try await self.web.authenticate(
                    url: self.session.environment.nativeAuthorizeURL(pkce: pkce),
                    callbackScheme: AppEnvironment.callbackScheme
                )
            } catch is CancellationError {
                return
            }
            let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let value = { (name: String) in items.first { $0.name == name }?.value }
            guard value("state") == pkce.state else {
                throw DesynError.server(code: "STATE_MISMATCH", message: "The sign-in response didn't match this request. Try again.")
            }
            if let error = value("error") {
                throw DesynError.server(
                    code: error,
                    message: error == "access_denied" ? "Sign-in was cancelled in the browser." : "The browser sign-in failed. Try again."
                )
            }
            guard let code = value("code") else {
                throw DesynError.unexpected("The browser didn't return a sign-in code.")
            }
            let stored = try await self.session.auth.exchangeNativeCode(
                code: code,
                verifier: pkce.verifier,
                deviceName: UIDevice.current.name
            )
            try await self.session.completeSignIn(stored)
        }
    }

    // MARK: Password reset

    public func requestPasswordReset() async {
        guard validate([.email]) else { return }
        await run {
            try await self.session.auth.requestPasswordReset(email: self.normalizedEmail)
            self.screen = .resetSent(email: self.normalizedEmail)
        }
    }

    // MARK: Helpers

    private var normalizedEmail: String {
        email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Checks the given fields and records inline errors.
    func validate(_ fields: [Field]) -> Bool {
        var errors: [Field: String] = [:]
        for field in fields {
            switch field {
            case .name:
                if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    errors[.name] = "Tell us what to call you."
                }
            case .email:
                if !AuthValidation.isEmail(normalizedEmail) {
                    errors[.email] = "Enter an email address like you@example.com."
                }
            case .password:
                if password.count < 8 {
                    errors[.password] = "Use at least 8 characters."
                } else if password.count > 128 {
                    errors[.password] = "Use at most 128 characters."
                }
            }
        }
        fieldErrors = errors
        errorMessage = nil
        if !errors.isEmpty { Haptics.warning() }
        return errors.isEmpty
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) async {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await operation()
        } catch {
            errorMessage = DesynError(error).message
            Haptics.error()
        }
    }
}

/// Input checks shared by the sign-in screens.
public enum AuthValidation {
    /// A pragmatic address check (one `@`, a dot in the domain, no spaces); the server validates for real.
    public static func isEmail(_ value: String) -> Bool {
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, !parts[0].isEmpty, !value.contains(" ") else { return false }
        let domain = parts[1]
        guard let dot = domain.lastIndex(of: "."), dot != domain.startIndex else { return false }
        return domain.distance(from: dot, to: domain.endIndex) > 2
    }
}
