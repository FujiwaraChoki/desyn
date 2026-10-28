import CoreGraphics
import DesignSystem
import DesynEngine
import EditorFeature
import PanelKit
import SwiftUI

/// Draws the AI's activity on the canvas (DESIGN_SYSTEM section 4): a soft pulsing sun glow on the layers the agent
/// is changing, and a "sunrise" when it finishes — a warm band sweeping across the changed layers, then fading.
/// Follows pan and zoom (the boxes are re-projected every frame while something is highlighted) and never takes
/// touches.
public struct AIHighlightOverlay: View {
    private let editor: EditorModel
    @State private var context: EditorContext
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(editor: EditorModel) {
        self.editor = editor
        _context = State(initialValue: EditorContext.for(editor))
    }

    public var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 60, paused: context.highlights.isEmpty)) { timeline in
            Canvas { gc, _ in
                guard let viewport = editor.canvasViewport else { return }
                let transform = viewport.pageToView
                let now = timeline.date
                for highlight in context.highlights {
                    let boxes = highlight.nodeIds.prefix(60).compactMap { id -> Path? in
                        guard let box = editor.pageBounds(of: id), box.width > 0 || box.height > 0 else { return nil }
                        var path = Path()
                        let corners = box.corners.map { CGPoint(x: $0.x, y: $0.y).applying(transform) }
                        guard let first = corners.first else { return nil }
                        path.move(to: first)
                        for corner in corners.dropFirst() { path.addLine(to: corner) }
                        path.closeSubpath()
                        return path
                    }
                    switch highlight.style {
                    case .pulse:
                        drawPulse(boxes, in: &gc, time: now.timeIntervalSinceReferenceDate)
                    case .sunrise:
                        let progress = min(1, max(0, now.timeIntervalSince(highlight.start) / CanvasHighlight.sunriseDuration))
                        drawSunrise(boxes, in: &gc, progress: progress)
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private func drawPulse(_ boxes: [Path], in gc: inout GraphicsContext, time: TimeInterval) {
        let breathe = reduceMotion ? 0.6 : 0.45 + 0.35 * (sin(time * 2.4) + 1) / 2
        for path in boxes {
            var glow = gc
            glow.addFilter(.blur(radius: 10))
            glow.stroke(path, with: .color(Palette.sun.opacity(0.55 * breathe)), lineWidth: 8)
            gc.fill(path, with: .color(Palette.sun.opacity(0.06 * breathe)))
            gc.stroke(path, with: .color(Palette.sun.opacity(0.9 * breathe)), style: StrokeStyle(lineWidth: 1.5, dash: [6, 4], dashPhase: reduceMotion ? 0 : CGFloat(time * 18)))
        }
    }

    /// The sweep: a diagonal band of sun light crossing the union of the boxes (clipped to them), a rim glow that
    /// rises and fades. With Reduce Motion the boxes glow and fade without moving.
    private func drawSunrise(_ boxes: [Path], in gc: inout GraphicsContext, progress: Double) {
        guard !boxes.isEmpty else { return }
        let union = boxes.reduce(CGRect.null) { $0.union($1.boundingRect) }
        let fade = progress < 0.75 ? 1 : max(0, 1 - (progress - 0.75) / 0.25)
        var clip = Path()
        for path in boxes { clip.addPath(path) }

        // Rim glow.
        var glow = gc
        glow.addFilter(.blur(radius: 14))
        for path in boxes {
            glow.stroke(path, with: .color(Palette.sun.opacity(0.7 * fade)), lineWidth: 10)
        }

        if reduceMotion {
            gc.fill(clip, with: .color(Palette.sun.opacity(0.18 * fade)))
        } else {
            // The band travels from the lower left to the upper right like a sunrise.
            let span = union.width + union.height
            let center = CGFloat(-0.3 + 1.6 * easeOut(progress))
            let alpha = fade
            let start = CGPoint(x: union.minX, y: union.maxY)
            let end = CGPoint(x: union.minX + span * 0.7, y: union.maxY - span * 0.7)
            let stops: [Gradient.Stop] = [
                .init(color: .clear, location: max(0, center - 0.25)),
                .init(color: Palette.sunHi.opacity(0.0), location: max(0, center - 0.18)),
                .init(color: Palette.sunHi.opacity(0.55 * alpha), location: min(1, max(0, center))),
                .init(color: Palette.sunLo.opacity(0.25 * alpha), location: min(1, center + 0.12)),
                .init(color: .clear, location: min(1, center + 0.25)),
            ].sorted { $0.location < $1.location }
            var band = gc
            band.clip(to: clip)
            band.blendMode = .plusLighter
            band.fill(Path(union.insetBy(dx: -4, dy: -4)), with: .linearGradient(Gradient(stops: stops), startPoint: start, endPoint: end))
        }
        for path in boxes {
            gc.stroke(path, with: .color(Palette.sun.opacity(0.85 * fade)), lineWidth: 1.5)
        }
    }

    private func easeOut(_ t: Double) -> Double {
        1 - pow(1 - t, 3)
    }
}
