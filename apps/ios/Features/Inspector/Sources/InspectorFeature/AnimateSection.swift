import CoreGraphics
import DesignSystem
import DesynEngine
import DesynKit
import EditorFeature
import PanelKit
import SharedKit
import SwiftUI

/// Animate: entrance, exit and loop animations of layers (presentations and video), page transitions and timing,
/// with a preview rendered by the engine.
struct AnimateSection: View {
    let model: InspectorModel

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xl) {
            AnimationPreview(model: model)
            if model.isPageMode {
                PageTiming(model: model)
            } else {
                PhaseEditor(model: model, phase: "in", title: "Entrance", presets: NodeEditing.animationPresets.filter { !NodeEditing.loopPresets.contains($0) })
                PhaseEditor(model: model, phase: "loop", title: "Emphasis", presets: Array(NodeEditing.loopPresets).sorted())
                PhaseEditor(model: model, phase: "out", title: "Exit", presets: NodeEditing.animationPresets.filter { !NodeEditing.loopPresets.contains($0) && $0 != "typewriter" })
            }
        }
    }
}

private struct PhaseEditor: View {
    let model: InspectorModel
    let phase: String
    let title: String
    let presets: [String]

    private var current: [String: JSONValue]? {
        guard let node = model.first else { return nil }
        return NodeEditing.animations(of: node).first { $0["phase"]?.stringValue == phase }
    }

    var body: some View {
        PanelSection(title, trailing: {
            if model.context.isLocked("presentation") { ProPill() }
        }) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ChipButton("None", isSelected: current == nil) {
                        model.edit("Remove \(title.lowercased())", final: true) { NodeEditing.setAnimation(phase: phase, preset: nil, on: $0) }
                    }
                    ForEach(presets, id: \.self) { preset in
                        ChipButton(Self.title(preset), isSelected: current?["preset"]?.stringValue == preset) {
                            guard model.context.require("presentation") else { return }
                            model.edit("\(title) \(Self.title(preset).lowercased())", final: true) { NodeEditing.setAnimation(phase: phase, preset: preset, on: $0) }
                        }
                    }
                }
            }
            if let current, let preset = current["preset"]?.stringValue {
                HStack(spacing: Spacing.sm) {
                    ScrubField("Time", value: (current["durationMs"]?.doubleValue ?? 600) / 1000, in: 0.05...60, step: 0.05, unit: "s", decimals: 2) { value, final in
                        model.edit("Change animation timing", final: final) { NodeEditing.setAnimation(phase: phase, preset: preset, durationMs: value * 1000, on: $0) }
                    }
                    ScrubField("Delay", value: (current["startMs"]?.doubleValue ?? 0) / 1000, in: 0...600, step: 0.1, unit: "s", decimals: 1) { value, final in
                        model.edit("Change animation delay", final: final) { NodeEditing.setAnimation(phase: phase, preset: preset, startMs: value * 1000, on: $0) }
                    }
                }
                Menu {
                    ForEach(NodeEditing.easings, id: \.self) { easing in
                        Button {
                            model.edit("Change easing", final: true) { NodeEditing.setAnimation(phase: phase, preset: preset, easing: easing, on: $0) }
                        } label: {
                            if current["easing"]?.stringValue == easing { Label(Self.title(easing), systemImage: "checkmark") } else { Text(Self.title(easing)) }
                        }
                    }
                } label: {
                    HStack {
                        Text("Easing").font(.dsSubheadline).foregroundStyle(Palette.muted)
                        Spacer()
                        Text(Self.title(current["easing"]?.stringValue ?? "ease-out")).font(.dsCallout).foregroundStyle(Palette.foreground)
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
                    }
                    .padding(.horizontal, Spacing.md)
                    .frame(minHeight: Spacing.touchTarget)
                    .background(Palette.surface2, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
                }
            }
        }
    }

    static func title(_ value: String) -> String {
        value.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }
}

private struct PageTiming: View {
    let model: InspectorModel

    private static let transitions = ["none", "fade", "slide", "push", "zoom", "dissolve"]

    private var page: Node? { model.first }
    private var transition: [String: JSONValue] { page?.object("transition") ?? [:] }

    var body: some View {
        PanelSection("Page transition") {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Spacing.sm) {
                    ForEach(Self.transitions, id: \.self) { kind in
                        ChipButton(kind.capitalized, isSelected: (transition["kind"]?.stringValue ?? "none") == kind) {
                            guard let page else { return }
                            let duration = transition["durationMs"]?.doubleValue ?? 500
                            Task { await model.editor.apply(NodeEditing.setPageTransition(kind: kind, durationMs: duration, on: page), label: "Page transition") }
                        }
                    }
                }
            }
            if let kind = transition["kind"]?.stringValue, kind != "none" {
                ScrubField("Transition", value: (transition["durationMs"]?.doubleValue ?? 500) / 1000, in: 0.1...5, step: 0.1, unit: "s", decimals: 1) { value, final in
                    guard let page else { return }
                    let ops = NodeEditing.setPageTransition(kind: kind, durationMs: value * 1000, on: page)
                    Task {
                        if final { await model.editor.apply(ops, label: "Transition timing") } else { await model.editor.applyPreview(ops) }
                    }
                }
            }
            PanelToggle("Advance automatically", detail: "For videos and self-running slides.", isOn: page?.number("durationMs") != nil) { on in
                guard let page else { return }
                Task { await model.editor.apply(NodeEditing.setPageDuration(on ? 5000 : nil, on: page), label: "Page timing") }
            }
            if let duration = page?.number("durationMs") {
                ScrubField("Show for", value: duration / 1000, in: 0.5...600, step: 0.5, unit: "s", decimals: 1) { value, final in
                    guard let page else { return }
                    let ops = NodeEditing.setPageDuration(value * 1000, on: page)
                    Task {
                        if final { await model.editor.apply(ops, label: "Page timing") } else { await model.editor.applyPreview(ops) }
                    }
                }
            }
        }
    }
}

/// Plays the page's animations: frames rendered by the editor's engine at 15 fps over the longest animation.
private struct AnimationPreview: View {
    let model: InspectorModel

    @State private var frames: [CGImage] = []
    @State private var rendering = false
    @State private var playing = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        PanelSection("Preview", trailing: {
            Button {
                Task { await play() }
            } label: {
                Label(playing ? "Playing" : "Play", systemImage: playing ? "waveform" : "play.fill")
                    .font(DSFont.sans(13, weight: .semibold, relativeTo: .footnote))
                    .foregroundStyle(Palette.sun)
                    .frame(minHeight: 36)
            }
            .disabled(rendering || playing)
        }) {
            ZStack {
                RoundedRectangle(cornerRadius: Radius.card, style: .continuous).fill(Palette.canvas)
                if !frames.isEmpty {
                    TimelineView(.animation(minimumInterval: 1.0 / 15, paused: !playing)) { context in
                        let image = frame(at: context.date)
                        Image(decorative: image, scale: 1).resizable().scaledToFit().padding(Spacing.sm)
                    }
                } else if rendering {
                    SunSpinner(size: 24)
                } else {
                    Text("Play to see entrances, emphasis and exits.")
                        .font(.dsFootnote)
                        .foregroundStyle(Palette.muted)
                        .padding()
                }
            }
            .frame(height: 170)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Animation preview")
        }
    }

    @State private var started = Date()

    private func frame(at date: Date) -> CGImage {
        let index = min(frames.count - 1, Int(date.timeIntervalSince(started) * 15))
        return frames[max(0, index)]
    }

    /// Longest `startMs + durationMs` of the page's animations (at least 1 s, at most 6 s).
    private func duration(pageId: String) -> Double {
        var longest = 1000.0
        for node in model.editor.lookupSubtree(pageId) {
            for anim in NodeEditing.animations(of: node) {
                let end = (anim["startMs"]?.doubleValue ?? 0) + (anim["durationMs"]?.doubleValue ?? 0)
                longest = max(longest, end)
            }
        }
        return min(6000, longest)
    }

    private func play() async {
        guard let page = model.editor.currentPage else { return }
        rendering = true
        let total = duration(pageId: page.id)
        let scale = min(1, 360 / max(page.width, page.height))
        var rendered: [CGImage] = []
        let count = reduceMotion ? 1 : Int(total / 1000 * 15) + 1
        for index in 0..<count {
            let time = reduceMotion ? total : Double(index) / 15 * 1000
            if let frame = try? await model.editor.designEngine.renderPage(PageImageRequest(pageId: page.id, scale: scale, timeMs: time)),
               let image = frame.makeCGImage()
            {
                rendered.append(image)
            }
        }
        frames = rendered
        rendering = false
        started = Date()
        guard !rendered.isEmpty, !reduceMotion else { return }
        playing = true
        try? await Task.sleep(for: .seconds(Double(rendered.count) / 15 + 0.2))
        playing = false
    }
}
