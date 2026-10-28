import DesignSystem
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// The AI dock: the conversation with the agent (your request, its words, each tool step with its state, applied
/// changes, previews, its plan and questions) streaming live, and the prompt with mode and selection context. A
/// resizable sheet: at its smallest the canvas stays visible and interactive, so changes land in view.
public struct AIDockSheet: View {
    @State private var model: AIDockModel
    @FocusState private var promptFocused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var answer = ""

    public init(editor: EditorModel) {
        _model = State(initialValue: AIDocks.model(for: editor))
    }

    public var body: some View {
        VStack(spacing: 0) {
            header
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: Spacing.md) {
                        if model.timeline.items.isEmpty, !model.isRunning {
                            suggestions
                        }
                        ForEach(model.timeline.items) { item in
                            TimelineRow(item: item, model: model)
                                .id(item.id)
                                .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                        }
                        if model.isRunning, let activity = model.timeline.activity {
                            HStack(spacing: Spacing.sm) {
                                SunSpinner(size: 16)
                                Text(activity).font(.dsFootnote).foregroundStyle(Palette.muted)
                            }
                            .id("activity")
                        }
                        if let question = model.timeline.pendingQuestion {
                            questionCard(question.question, options: question.options)
                        }
                        if let error = model.errorMessage {
                            InlineNotice(error, tone: .error, actionTitle: "Dismiss") { model.errorMessage = nil }
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .padding(.horizontal, Spacing.gutter)
                    .padding(.vertical, Spacing.md)
                    .animation(Motion.animation(Motion.panel, reduced: reduceMotion), value: model.timeline.items.count)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: model.timeline.items.count) { _, _ in
                    withAnimation(Motion.easeOut(0.4)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
            composer
        }
        .panelSheet([.height(300), .medium, .large], interactiveUpThrough: .medium)
        .task { await model.appear() }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: Spacing.sm) {
            AISun(active: model.isRunning, size: 26)
            VStack(alignment: .leading, spacing: 0) {
                SerifHeadline("design with *ai*", size: 24, relativeTo: .title2)
                if let estimate = model.estimate {
                    Text("About \(Int(estimate.credits)) credits per run · up to \(Int(estimate.maxSteps)) steps")
                        .font(.dsCaption)
                        .foregroundStyle(Palette.muted)
                }
            }
            Spacer()
            Menu {
                Button {
                    model.reset()
                } label: {
                    Label("New conversation", systemImage: "square.and.pencil")
                }
                .disabled(model.isRunning)
                if !model.history.isEmpty {
                    Section("Recent runs") {
                        ForEach(model.history.prefix(8)) { run in
                            Button {
                                model.resume(runId: run.id)
                            } label: {
                                Label(run.goal ?? "Run", systemImage: icon(for: run))
                            }
                        }
                    }
                }
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Palette.foreground)
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
            }
            .accessibilityLabel("Conversations")
            Button {
                dismiss()
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 30, height: 30)
                    .background(Palette.surface2, in: Circle())
                    .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityLabel("Close the AI dock")
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, Spacing.lg)
        .padding(.bottom, Spacing.xs)
    }

    private func icon(for run: AIRun) -> String {
        switch run.phase {
        case .completed: "checkmark.circle"
        case .queued, .running: "sun.max"
        case .waitingForAnswer: "questionmark.circle"
        case .cancelled, .stopped: "stop.circle"
        case .failed: "exclamationmark.triangle"
        }
    }

    // MARK: Suggestions

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Text("The AI edits real layers you can tweak afterwards. Try:")
                .font(.dsCallout)
                .foregroundStyle(Palette.muted)
            FlowChips(items: AIDockModel.suggestions.map { $0.title }) { index in
                let suggestion = AIDockModel.suggestions[index]
                model.prompt = suggestion.prompt
                model.mode = suggestion.mode
                promptFocused = true
            }
        }
        .padding(.vertical, Spacing.sm)
    }

    // MARK: Question

    private func questionCard(_ question: String, options: [String]) -> some View {
        VStack(alignment: .leading, spacing: Spacing.md) {
            Label(question, systemImage: "questionmark.bubble")
                .font(.dsBody)
                .foregroundStyle(Palette.foreground)
            if !options.isEmpty {
                FlowChips(items: options) { index in
                    Task { await model.answer(options[index]) }
                }
            }
            HStack(spacing: Spacing.sm) {
                DSTextField("", text: $answer, prompt: "Your answer", kind: .plain, submitLabel: .send) {
                    let text = answer
                    answer = ""
                    Task { await model.answer(text) }
                }
                Button {
                    let text = answer
                    answer = ""
                    Task { await model.answer(text) }
                } label: {
                    Image(systemName: "arrow.up").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.onSun)
                        .frame(width: 36, height: 36).background(Palette.sun, in: Circle())
                }
                .disabled(answer.trimmingCharacters(in: .whitespaces).isEmpty)
                .accessibilityLabel("Send answer")
            }
        }
        .padding(Spacing.md)
        .background(Palette.sun.opacity(0.08), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.sun.opacity(0.4), lineWidth: 1))
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: Spacing.sm) {
            HStack(spacing: Spacing.sm) {
                ForEach(AIMode.allCases, id: \.self) { mode in
                    ChipButton(mode.title, isSelected: model.mode == mode) {
                        model.mode = mode
                        model.modeChanged()
                    }
                }
                Spacer(minLength: 0)
                if !model.editor.selection.isEmpty {
                    Button {
                        model.useSelection.toggle()
                    } label: {
                        Label("\(model.editor.selection.count) selected", systemImage: model.useSelection ? "scope" : "circle.dashed")
                            .font(DSFont.sans(12, weight: .semibold, relativeTo: .caption))
                            .foregroundStyle(model.useSelection ? Palette.sun : Palette.muted)
                            .frame(minHeight: 36)
                    }
                    .accessibilityHint(model.useSelection ? "The AI focuses on the selection" : "The AI looks at the whole page")
                }
            }
            HStack(alignment: .bottom, spacing: Spacing.sm) {
                TextField(placeholder, text: $model.prompt, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.dsBody)
                    .foregroundStyle(Palette.foreground)
                    .tint(Palette.sun)
                    .focused($promptFocused)
                    .submitLabel(.send)
                    .onSubmit { Task { await model.send() } }
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm + 2)
                    .frame(minHeight: Spacing.touchTarget)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(promptFocused ? Palette.sun.opacity(0.6) : Palette.borderSubtle, lineWidth: promptFocused ? 2 : 1))
                if model.isRunning {
                    Button {
                        Task { await model.cancel() }
                    } label: {
                        Image(systemName: "stop.fill").font(.system(size: 15, weight: .bold)).foregroundStyle(Palette.onSun)
                            .frame(width: Spacing.touchTarget, height: Spacing.touchTarget).background(Palette.sun, in: Circle())
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityLabel("Stop")
                } else {
                    Button {
                        Task { await model.send() }
                    } label: {
                        Group {
                            if model.starting {
                                SunSpinner(size: 20, tint: Palette.onSun)
                            } else {
                                Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                            }
                        }
                        .foregroundStyle(Palette.onSun)
                        .frame(width: Spacing.touchTarget, height: Spacing.touchTarget)
                        .background(Palette.sunGradient, in: Circle())
                        .dsGlow(model.canSend, radius: 12)
                    }
                    .buttonStyle(PressScaleStyle())
                    .disabled(!model.canSend)
                    .opacity(model.canSend ? 1 : 0.5)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, Spacing.gutter)
        .padding(.top, Spacing.sm)
        .padding(.bottom, Spacing.md)
        .background(Palette.surface1)
        .overlay(alignment: .top) { DSDivider() }
    }

    private var placeholder: String {
        switch model.mode {
        case .edit: model.editor.selection.isEmpty ? "Describe a change to this page" : "Describe a change to the selection"
        case .generate: "Describe a design to build on this page"
        case .critique: "What should the review focus on?"
        }
    }
}

/// One timeline entry.
private struct TimelineRow: View {
    let item: AIRunTimeline.Item
    let model: AIDockModel

    var body: some View {
        switch item {
        case let .request(_, text):
            HStack {
                Spacer(minLength: 48)
                Text(text)
                    .font(.dsBody)
                    .foregroundStyle(Palette.onSun)
                    .padding(.horizontal, Spacing.md)
                    .padding(.vertical, Spacing.sm + 2)
                    .background(Palette.sunGradient, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .accessibilityLabel("You: \(text)")
        case let .message(_, text):
            Text(markdown(text))
                .font(.dsBody)
                .foregroundStyle(Palette.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case let .thinking(_, text):
            DisclosureGroup {
                Text(text).font(.dsFootnote).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label("Thinking", systemImage: "brain").font(.dsFootnote).foregroundStyle(Palette.muted)
            }
            .tint(Palette.muted)
        case let .tool(_, _, title, state, summary):
            HStack(alignment: .top, spacing: Spacing.sm) {
                Group {
                    switch state {
                    case .running: SunSpinner(size: 16)
                    case .succeeded: Image(systemName: "checkmark.circle.fill").foregroundStyle(Palette.success)
                    case .failed: Image(systemName: "xmark.circle.fill").foregroundStyle(Palette.danger)
                    }
                }
                .frame(width: 18, height: 18)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(DSFont.sans(14, weight: .medium, relativeTo: .callout)).foregroundStyle(Palette.foreground)
                    if let summary {
                        Text(summary).font(.dsFootnote).foregroundStyle(Palette.muted).lineLimit(3)
                    }
                }
            }
            .accessibilityElement(children: .combine)
        case let .change(_, label, count, touched):
            Button {
                model.editor.select(touched.filter { model.editor.lookupNode($0) != nil })
                model.context.sunrise(touched)
            } label: {
                HStack(spacing: Spacing.sm) {
                    Text(label.isEmpty ? "Changed \(count) layer\(count == 1 ? "" : "s")" : label)
                        .font(DSFont.sans(13, weight: .medium, relativeTo: .footnote))
                        .foregroundStyle(Palette.foreground)
                        .lineLimit(1)
                    Spacer()
                    Text("\(count)").font(.dsMono).foregroundStyle(Palette.sun)
                }
                .padding(.horizontal, Spacing.md)
                .frame(minHeight: 36)
                .background(Palette.sun.opacity(0.08), in: Capsule())
            }
            .buttonStyle(PressScaleStyle())
            .accessibilityHint("Selects and highlights the changed layers")
        case let .preview(_, url, width, height):
            RemoteImage(url, maxPixel: 900, contentMode: .fit)
                .aspectRatio(CGFloat((width ?? 1) / max(1, height ?? 1)), contentMode: .fit)
                .frame(maxHeight: 240)
                .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Palette.borderSubtle, lineWidth: 1))
                .accessibilityLabel("Preview the AI rendered")
        case let .plan(_, steps):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("Plan").dsEyebrow()
                ForEach(steps) { step in
                    HStack(spacing: Spacing.sm) {
                        Image(systemName: step.status == "done" ? "checkmark.circle.fill" : step.status == "running" ? "circle.dotted" : "circle")
                            .foregroundStyle(step.status == "done" ? Palette.success : step.status == "running" ? Palette.sun : Palette.muted)
                        Text(step.title).font(.dsFootnote).foregroundStyle(step.status == "done" ? Palette.muted : Palette.foreground)
                    }
                }
            }
            .padding(Spacing.md)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        case let .question(_, question, _, answer):
            if let answer {
                VStack(alignment: .leading, spacing: 4) {
                    Label(question, systemImage: "questionmark.bubble").font(.dsFootnote).foregroundStyle(Palette.muted)
                    Text(answer).font(.dsCallout).foregroundStyle(Palette.foreground)
                }
            }
        case let .notice(_, text, tone):
            InlineNotice(text, tone: tone == .error ? .error : tone == .warning ? .warning : .info)
        case let .outcome(_, status, summary, credits):
            VStack(alignment: .leading, spacing: Spacing.xs) {
                HStack(spacing: Spacing.sm) {
                    Image(systemName: status == "completed" ? "sun.max.fill" : "pause.circle")
                        .foregroundStyle(status == "completed" ? Palette.sun : Palette.muted)
                    Text(AIRunTimeline.outcomeTitle(status)).font(DSFont.sans(14, weight: .semibold, relativeTo: .callout)).foregroundStyle(Palette.foreground)
                    Spacer()
                    if credits > 0 {
                        Text("\(Int(credits.rounded())) credits").font(.dsCaption).foregroundStyle(Palette.muted)
                    }
                }
                if !summary.isEmpty {
                    Text(markdown(summary)).font(.dsCallout).foregroundStyle(Palette.foreground)
                }
                if status == "completed" {
                    Text("The changes are ordinary layers: edit, move or delete them like any other.").font(.dsCaption).foregroundStyle(Palette.muted)
                }
                if model.canUndoRun {
                    Button {
                        model.undoRun()
                    } label: {
                        Label("Undo these changes", systemImage: "arrow.uturn.backward")
                            .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                            .foregroundStyle(Palette.sun)
                            .frame(minHeight: Spacing.touchTarget)
                    }
                    .buttonStyle(PressScaleStyle())
                    .accessibilityHint("Reverts every change of this run in one step")
                }
            }
            .padding(Spacing.md)
            .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
    }

    private func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
    }
}

/// Wrapping chips (suggestions, answer options).
struct FlowChips: View {
    let items: [String]
    let onTap: (Int) -> Void

    var body: some View {
        WrapLayout(spacing: Spacing.sm) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                ChipButton(item) { onTap(index) }
            }
        }
    }
}

/// A layout that flows children into rows.
struct WrapLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 360
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: min(width, widest), height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
