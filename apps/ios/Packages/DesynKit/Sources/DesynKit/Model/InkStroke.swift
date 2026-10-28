import Foundation

/// A sample of a pen / finger stroke in page coordinates. `pressure` is normalized 0...1 (Apple Pencil force /
/// maximum force; fingers use a constant).
public struct InkSample: Hashable, Sendable {
    public var x: Double
    public var y: Double
    public var pressure: Double

    public init(x: Double, y: Double, pressure: Double) {
        self.x = x
        self.y = y
        self.pressure = pressure
    }
}

/// Turns a stroke into a filled outline (variable width from pressure, round caps) so it becomes an ordinary
/// `path` node every client renders identically.
public enum InkStroke {
    /// The outline of `samples` drawn with `width` (the width at full pressure; zero pressure draws 35% of it).
    /// Returns the node frame (page coordinates) and the SVG path data in the node's local box, or nil when the
    /// stroke is empty.
    public static func outline(_ samples: [InkSample], width: Double) -> (frame: PageRect, d: String)? {
        let points = smooth(dedupe(samples, minDistance: max(0.35, width * 0.08)))
        guard let first = points.first else { return nil }
        let radius: (InkSample) -> Double = { max(0.25, width * (0.35 + 0.65 * min(1, max(0, $0.pressure)))) / 2 }

        var polygon: [PagePoint] = []
        if points.count == 1 {
            polygon = arc(center: PagePoint(x: first.x, y: first.y), radius: radius(first), from: 0, sweep: 2 * .pi)
        } else {
            var left: [PagePoint] = []
            var right: [PagePoint] = []
            for i in points.indices {
                let prev = points[max(0, i - 1)]
                let next = points[min(points.count - 1, i + 1)]
                var tx = next.x - prev.x
                var ty = next.y - prev.y
                let length = (tx * tx + ty * ty).squareRoot()
                if length > 0 {
                    tx /= length
                    ty /= length
                } else {
                    tx = 1
                    ty = 0
                }
                let r = radius(points[i])
                left.append(PagePoint(x: points[i].x - ty * r, y: points[i].y + tx * r))
                right.append(PagePoint(x: points[i].x + ty * r, y: points[i].y - tx * r))
            }
            let last = points[points.count - 1]
            let endAngle = angle(of: left[left.count - 1], around: last)
            let startAngle = angle(of: right[0], around: first)
            polygon += left
            // Round cap at the end: from the left side around to the right side (clockwise in y-down space).
            polygon += arc(center: PagePoint(x: last.x, y: last.y), radius: radius(last), from: endAngle, sweep: -.pi).dropFirst()
            polygon += right.reversed()
            polygon += arc(center: PagePoint(x: first.x, y: first.y), radius: radius(first), from: startAngle, sweep: -.pi).dropFirst()
        }

        let minX = polygon.map(\.x).min() ?? 0
        let minY = polygon.map(\.y).min() ?? 0
        let maxX = polygon.map(\.x).max() ?? 0
        let maxY = polygon.map(\.y).max() ?? 0
        let local = polygon.map { PagePoint(x: $0.x - minX, y: $0.y - minY) }
        let frame = PageRect(x: minX, y: minY, width: max(maxX - minX, 0.5), height: max(maxY - minY, 0.5))
        return (frame, pathData(local))
    }

    /// Drops samples closer than `minDistance` to the previous kept one (keeps the last sample).
    static func dedupe(_ samples: [InkSample], minDistance: Double) -> [InkSample] {
        var kept: [InkSample] = []
        for sample in samples where sample.x.isFinite && sample.y.isFinite {
            if let last = kept.last {
                let dx = sample.x - last.x
                let dy = sample.y - last.y
                if (dx * dx + dy * dy).squareRoot() < minDistance { continue }
            }
            kept.append(sample)
        }
        if let last = samples.last, let kept0 = kept.last, last != kept0, last.x.isFinite, last.y.isFinite, kept.count > 1 {
            kept[kept.count - 1] = last
        }
        return kept
    }

    /// Moving average over 3 samples (ends fixed) to calm digitizer jitter.
    static func smooth(_ samples: [InkSample]) -> [InkSample] {
        guard samples.count > 2 else { return samples }
        var out = samples
        for i in 1..<(samples.count - 1) {
            let a = samples[i - 1]
            let b = samples[i]
            let c = samples[i + 1]
            out[i] = InkSample(
                x: (a.x + 2 * b.x + c.x) / 4,
                y: (a.y + 2 * b.y + c.y) / 4,
                pressure: (a.pressure + 2 * b.pressure + c.pressure) / 4
            )
        }
        return out
    }

    private static func angle(of point: PagePoint, around center: InkSample) -> Double {
        atan2(point.y - center.y, point.x - center.x)
    }

    private static func arc(center: PagePoint, radius: Double, from start: Double, sweep: Double) -> [PagePoint] {
        let steps = max(6, Int(abs(sweep) / (.pi / 8)))
        return (0...steps).map { step in
            let a = start + sweep * Double(step) / Double(steps)
            return PagePoint(x: center.x + cos(a) * radius, y: center.y + sin(a) * radius)
        }
    }

    /// Closed path through the outline points using quadratic curves between midpoints (smooth, compact).
    static func pathData(_ points: [PagePoint]) -> String {
        guard points.count > 2 else {
            return points.isEmpty ? "" : "M\(fmt(points[0].x)) \(fmt(points[0].y))Z"
        }
        func mid(_ a: PagePoint, _ b: PagePoint) -> PagePoint { PagePoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
        let start = mid(points[points.count - 1], points[0])
        var d = "M\(fmt(start.x)) \(fmt(start.y))"
        for i in points.indices {
            let control = points[i]
            let end = mid(points[i], points[(i + 1) % points.count])
            d += "Q\(fmt(control.x)) \(fmt(control.y)) \(fmt(end.x)) \(fmt(end.y))"
        }
        return d + "Z"
    }

    /// Two decimals, no trailing zeros, no `-0`.
    static func fmt(_ value: Double) -> String {
        let rounded = (value * 100).rounded() / 100
        if rounded == 0 { return "0" }
        if rounded.rounded() == rounded { return String(Int(rounded)) }
        var text = String(format: "%.2f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        return text
    }
}
