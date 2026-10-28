import SwiftUI

/// What a field holds; sets keyboard, content type and autocorrection.
public enum DSFieldKind: Sendable {
    case plain
    case name
    case email
    case password
    case newPassword
    case search
    case number
}

/// Labeled text field: surface-2 fill, 1 pt border, 2 pt sun focus ring at 60%, inline error text.
public struct DSTextField: View {
    private let label: String
    private let prompt: String
    @Binding private var text: String
    private let kind: DSFieldKind
    private let error: String?
    private let submitLabel: SubmitLabel
    private let onSubmit: () -> Void

    @FocusState private var focused: Bool
    @State private var revealed = false

    public init(
        _ label: String,
        text: Binding<String>,
        prompt: String = "",
        kind: DSFieldKind = .plain,
        error: String? = nil,
        submitLabel: SubmitLabel = .next,
        onSubmit: @escaping () -> Void = {}
    ) {
        self.label = label
        _text = text
        self.prompt = prompt
        self.kind = kind
        self.error = error
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs + 2) {
            if !label.isEmpty {
                Text(label)
                    .font(.dsSubheadline)
                    .foregroundStyle(Palette.muted)
            }
            HStack(spacing: Spacing.sm) {
                if kind == .search {
                    Image(systemName: "magnifyingglass")
                        .foregroundStyle(Palette.muted)
                        .accessibilityHidden(true)
                }
                input
                    .font(.dsBody)
                    .foregroundStyle(Palette.foreground)
                    .tint(Palette.sun)
                    .focused($focused)
                    .submitLabel(submitLabel)
                    .onSubmit(onSubmit)
                if isSecure {
                    Button {
                        revealed.toggle()
                    } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                            .foregroundStyle(Palette.muted)
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(revealed ? "Hide password" : "Show password")
                }
                if kind == .search, !text.isEmpty {
                    Button {
                        text = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Palette.muted)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, Spacing.md + 2)
            .frame(minHeight: Spacing.touchTarget + 4)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: Radius.field, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: focused ? 2 : 1)
            }
            .animation(Motion.quick, value: focused)
            if let error, !error.isEmpty {
                Label(error, systemImage: "exclamationmark.circle")
                    .font(.dsFootnote)
                    .foregroundStyle(Palette.danger)
                    .transition(.opacity)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var isSecure: Bool { kind == .password || kind == .newPassword }

    private var borderColor: Color {
        if let error, !error.isEmpty { return Palette.danger.opacity(0.7) }
        return focused ? Palette.sun.opacity(0.6) : Palette.border
    }

    @ViewBuilder private var input: some View {
        let placeholder = Text(prompt).foregroundStyle(Palette.muted)
        switch kind {
        case .password, .newPassword:
            Group {
                if revealed {
                    TextField(label, text: $text, prompt: placeholder)
                } else {
                    SecureField(label, text: $text, prompt: placeholder)
                }
            }
            .textContentType(kind == .password ? .password : .newPassword)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
        case .email:
            TextField(label, text: $text, prompt: placeholder)
                .textContentType(.username)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        case .name:
            TextField(label, text: $text, prompt: placeholder)
                .textContentType(.name)
                .textInputAutocapitalization(.words)
        case .search:
            TextField(label, text: $text, prompt: placeholder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
        case .number:
            TextField(label, text: $text, prompt: placeholder)
                .keyboardType(.decimalPad)
                .font(.dsMono)
        case .plain:
            TextField(label, text: $text, prompt: placeholder)
        }
    }
}
