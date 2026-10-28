import DesignSystem
import DesynKit
import FeatureCore
import SwiftUI

/// Sign-in flow root: welcome, email + password, sign up, magic link, verification and password reset.
public struct AuthRootView: View {
    @Bindable private var model: AuthModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: AuthModel) {
        self.model = model
    }

    public var body: some View {
        ZStack {
            OrbsBackground()
            ScrollView {
                VStack(spacing: 0) {
                    content
                        .id(screenKey)
                        .transition(reduceMotion ? .opacity : .asymmetric(
                            insertion: .move(edge: .trailing).combined(with: .opacity),
                            removal: .opacity
                        ))
                }
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, Spacing.gutter)
                .padding(.vertical, Spacing.xxl)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
        }
        .animation(Motion.animation(Motion.easeOut(0.45), reduced: reduceMotion), value: screenKey)
        .tint(Palette.sun)
    }

    private var screenKey: String {
        switch model.screen {
        case .welcome: "welcome"
        case .signIn: "signIn"
        case .signUp: "signUp"
        case .magicLinkSent: "magic"
        case .verifyEmail: "verify"
        case .forgotPassword: "forgot"
        case .resetSent: "reset"
        }
    }

    @ViewBuilder private var content: some View {
        switch model.screen {
        case .welcome: WelcomeScreen(model: model)
        case .signIn: SignInScreen(model: model)
        case .signUp: SignUpScreen(model: model)
        case let .magicLinkSent(email): MagicLinkSentScreen(model: model, email: email)
        case let .verifyEmail(email): VerifyEmailScreen(model: model, email: email)
        case .forgotPassword: ForgotPasswordScreen(model: model)
        case let .resetSent(email): ResetSentScreen(model: model, email: email)
        }
    }
}

// MARK: Welcome

private struct WelcomeScreen: View {
    let model: AuthModel
    @State private var appeared = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: Spacing.xl) {
            SunHero(diameter: 132)
                .padding(.top, Spacing.xl)
                .opacity(appeared ? 1 : 0)
                .scaleEffect(appeared || reduceMotion ? 1 : 0.85)
            VStack(spacing: Spacing.md) {
                SunMark(size: 22)
                SerifHeadline("design at the speed of *light*.", size: 44, relativeTo: .largeTitle)
                    .multilineTextAlignment(.center)
                Text("Make posters, posts, slides and more. Your designs follow you between the web, desktop and this \(DeviceName.current).")
                    .font(.dsBody)
                    .foregroundStyle(Palette.muted)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared || reduceMotion ? 0 : 16)

            VStack(spacing: Spacing.md) {
                DSButton("Continue with email", systemImage: "envelope", size: .large) {
                    model.go(.signIn)
                }
                DSButton(browserTitle, systemImage: "safari", kind: .secondary, size: .large, isLoading: model.isWorking) {
                    Task { await model.continueInBrowser() }
                }
                Button("New to Desyn? Create an account") {
                    model.go(.signUp)
                }
                .buttonStyle(DSButtonStyle(.ghost))
                if let error = model.errorMessage {
                    ErrorBanner(message: error)
                }
            }
            .opacity(appeared ? 1 : 0)
            .offset(y: appeared || reduceMotion ? 0 : 24)

            Text("By continuing you agree to the Terms and Privacy Policy at desyn.app.")
                .font(.dsFootnote)
                .foregroundStyle(Palette.muted)
                .multilineTextAlignment(.center)
                .padding(.top, Spacing.sm)
        }
        .onAppear {
            withAnimation(Motion.animation(Motion.easeOut(0.9), reduced: reduceMotion)) { appeared = true }
        }
    }

    private var browserTitle: String {
        switch (model.methods.google, model.methods.github) {
        case (true, true): "Continue with Google or GitHub"
        case (true, false): "Continue with Google"
        case (false, true): "Continue with GitHub"
        case (false, false): "Continue in browser"
        }
    }
}

// MARK: Email + password

private struct SignInScreen: View {
    @Bindable var model: AuthModel
    @FocusState private var focus: AuthModel.Field?

    var body: some View {
        AuthCard(title: "welcome *back*.", subtitle: "Sign in to pick up where you left off.", onBack: { model.go(.welcome) }) {
            DSTextField("Email", text: $model.email, prompt: "you@example.com", kind: .email, error: model.fieldErrors[.email]) {
                focus = .password
            }
            .focused($focus, equals: .email)
            DSTextField("Password", text: $model.password, prompt: "At least 8 characters", kind: .password, error: model.fieldErrors[.password], submitLabel: .go) {
                Task { await model.signIn() }
            }
            .focused($focus, equals: .password)
            HStack {
                Spacer()
                Button("Forgot password?") { model.go(.forgotPassword) }
                    .font(.dsSubheadline)
                    .foregroundStyle(Palette.sun)
                    .frame(minHeight: Spacing.touchTarget)
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            DSButton("Sign in", size: .large, isLoading: model.isWorking) {
                focus = nil
                Task { await model.signIn() }
            }
            if model.methods.magicLink {
                DSButton("Email me a sign-in link", systemImage: "envelope", kind: .secondary, isLoading: false) {
                    focus = nil
                    Task { await model.sendMagicLink() }
                }
                .disabled(model.isWorking)
            }
            Button("New here? Create an account") { model.go(.signUp) }
                .buttonStyle(DSButtonStyle(.ghost))
        }
        .onAppear { focus = model.email.isEmpty ? .email : .password }
    }
}

private struct SignUpScreen: View {
    @Bindable var model: AuthModel
    @FocusState private var focus: AuthModel.Field?

    var body: some View {
        AuthCard(title: "start something *bright*.", subtitle: "Create your Desyn account. It's free to start.", onBack: { model.go(.welcome) }) {
            DSTextField("Name", text: $model.name, prompt: "Ada Lovelace", kind: .name, error: model.fieldErrors[.name]) {
                focus = .email
            }
            .focused($focus, equals: .name)
            DSTextField("Email", text: $model.email, prompt: "you@example.com", kind: .email, error: model.fieldErrors[.email]) {
                focus = .password
            }
            .focused($focus, equals: .email)
            DSTextField("Password", text: $model.password, prompt: "At least 8 characters", kind: .newPassword, error: model.fieldErrors[.password], submitLabel: .join) {
                Task { await model.signUp() }
            }
            .focused($focus, equals: .password)
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            DSButton("Create account", size: .large, isLoading: model.isWorking) {
                focus = nil
                Task { await model.signUp() }
            }
            Button("Already have an account? Sign in") { model.go(.signIn) }
                .buttonStyle(DSButtonStyle(.ghost))
        }
        .onAppear { focus = .name }
    }
}

// MARK: Confirmation screens

private struct MagicLinkSentScreen: View {
    let model: AuthModel
    let email: String
    @Environment(\.openURL) private var openURL

    var body: some View {
        AuthCard(title: "check your *inbox*.", subtitle: "We sent a sign-in link to \(email). Open it on this \(DeviceName.current) and you're in. It works for 15 minutes.", onBack: { model.go(.signIn) }) {
            MailGlyph()
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            DSButton("Open Mail", systemImage: "envelope.open", size: .large) {
                if let url = URL(string: "message://") { openURL(url) }
            }
            DSButton("Send another link", kind: .secondary, isLoading: model.isWorking) {
                Task { await model.sendMagicLink() }
            }
            Button("Use a different email") { model.go(.signIn) }
                .buttonStyle(DSButtonStyle(.ghost))
        }
    }
}

private struct VerifyEmailScreen: View {
    let model: AuthModel
    let email: String

    var body: some View {
        AuthCard(title: "verify your *email*.", subtitle: "We sent a link to \(email). Open it, then come back here to continue.", onBack: { model.go(.signIn) }) {
            MailGlyph()
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            DSButton("I've verified, continue", size: .large, isLoading: model.isWorking) {
                Task { await model.continueAfterVerification() }
            }
            DSButton("Resend the email", kind: .secondary) {
                Task { await model.resendVerification(email: email) }
            }
            .disabled(model.isWorking)
        }
    }
}

private struct ForgotPasswordScreen: View {
    @Bindable var model: AuthModel

    var body: some View {
        AuthCard(title: "reset your *password*.", subtitle: "We'll email you a link to choose a new one.", onBack: { model.go(.signIn) }) {
            DSTextField("Email", text: $model.email, prompt: "you@example.com", kind: .email, error: model.fieldErrors[.email], submitLabel: .send) {
                Task { await model.requestPasswordReset() }
            }
            if let error = model.errorMessage {
                ErrorBanner(message: error)
            }
            DSButton("Send reset link", size: .large, isLoading: model.isWorking) {
                Task { await model.requestPasswordReset() }
            }
        }
    }
}

private struct ResetSentScreen: View {
    let model: AuthModel
    let email: String

    var body: some View {
        AuthCard(title: "link *sent*.", subtitle: "If \(email) has an account, a reset link is on its way. Choose a new password in the browser, then sign in here.", onBack: { model.go(.signIn) }) {
            MailGlyph()
            DSButton("Back to sign in", size: .large) { model.go(.signIn) }
        }
    }
}

// MARK: Building blocks

/// Glass card with a back button, serif title and the form.
private struct AuthCard<Content: View>: View {
    let title: String
    let subtitle: String
    let onBack: () -> Void
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.lg) {
            Button(action: onBack) {
                Label("Back", systemImage: "chevron.left")
                    .font(.dsCallout)
                    .foregroundStyle(Palette.muted)
                    .frame(minHeight: Spacing.touchTarget)
            }
            .buttonStyle(.plain)
            VStack(alignment: .leading, spacing: Spacing.sm) {
                SerifHeadline(title, size: 40, relativeTo: .largeTitle)
                Text(subtitle)
                    .font(.dsBody)
                    .foregroundStyle(Palette.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: Spacing.md) {
                content
            }
            .padding(Spacing.xl)
            .dsGlass(cornerRadius: Radius.sheet)
        }
    }
}

private struct ErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.dsCallout)
            .foregroundStyle(Palette.danger)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.md)
            .background(Palette.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .accessibilityAddTraits(.isStaticText)
    }
}

private struct MailGlyph: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(Palette.sun.opacity(0.18))
                .frame(width: 96, height: 96)
                .blur(radius: 18)
            Image(systemName: "envelope.badge")
                .font(.system(size: 40, weight: .light))
                .foregroundStyle(Palette.sun)
                .symbolEffect(.pulse, options: .repeating)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 104)
        .accessibilityHidden(true)
    }
}
