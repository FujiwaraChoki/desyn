// Linux harness only (scripts/build-ios-engine.sh --swift-linux): stand-ins for the Apple APIs the DesynEngine
// sources use, with Apple's signatures, so the package's platform-neutral Swift (the generated DesynFFI wrapper,
// the DesynEngine actor, FrameBuffer, geometry and transaction helpers) and its tests compile and run against the
// Linux build of desyn-ffi. Built as a module named `CoreGraphics`; never part of the Apple build.
@_exported import Foundation
@_exported import Dispatch

public struct CGAffineTransform: Equatable, Sendable {
    public var a: CGFloat, b: CGFloat, c: CGFloat, d: CGFloat, tx: CGFloat, ty: CGFloat

    public init(a: CGFloat, b: CGFloat, c: CGFloat, d: CGFloat, tx: CGFloat, ty: CGFloat) {
        (self.a, self.b, self.c, self.d, self.tx, self.ty) = (a, b, c, d, tx, ty)
    }

    public init(rotationAngle angle: CGFloat) {
        self.init(a: cos(angle), b: sin(angle), c: -sin(angle), d: cos(angle), tx: 0, ty: 0)
    }

    public static let identity = CGAffineTransform(a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0)

    /// `self` then `t2` (CoreGraphics semantics: the result applies `self` first).
    public func concatenating(_ t2: CGAffineTransform) -> CGAffineTransform {
        CGAffineTransform(
            a: a * t2.a + b * t2.c, b: a * t2.b + b * t2.d,
            c: c * t2.a + d * t2.c, d: c * t2.b + d * t2.d,
            tx: tx * t2.a + ty * t2.c + t2.tx, ty: tx * t2.b + ty * t2.d + t2.ty
        )
    }

    public func translatedBy(x: CGFloat, y: CGFloat) -> CGAffineTransform {
        CGAffineTransform(a: 1, b: 0, c: 0, d: 1, tx: x, ty: y).concatenating(self)
    }

    public func inverted() -> CGAffineTransform {
        let det = a * d - b * c
        guard det != 0 else { return self }
        return CGAffineTransform(
            a: d / det, b: -b / det, c: -c / det, d: a / det,
            tx: (c * ty - d * tx) / det, ty: (b * tx - a * ty) / det
        )
    }
}

public extension CGPoint {
    func applying(_ t: CGAffineTransform) -> CGPoint {
        CGPoint(x: t.a * x + t.c * y + t.tx, y: t.b * x + t.d * y + t.ty)
    }
}

/// Apple's `DispatchSerialQueue` (a `SerialExecutor`); Linux's libdispatch has no such type.
public final class DispatchSerialQueue: SerialExecutor, @unchecked Sendable {
    let queue: DispatchQueue

    public init(label: String, qos: DispatchQoS = .unspecified) {
        queue = DispatchQueue(label: label, qos: qos)
    }

    public func enqueue(_ job: consuming ExecutorJob) {
        let job = UnownedJob(job)
        queue.async { job.runSynchronously(on: self.asUnownedSerialExecutor()) }
    }
}
