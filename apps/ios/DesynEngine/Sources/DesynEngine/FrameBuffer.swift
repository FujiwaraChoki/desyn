import Foundation

/// Pixel memory the engine renders into directly (`Engine.renderInto`), so a frame never crosses the FFI as a
/// copy: premultiplied RGBA8, `bytesPerRow` bytes per row (rows are 64-byte aligned by default, which suits
/// Metal linear textures and Core Video).
///
/// The buffer remembers which engine frame it shows, so only the damaged rectangles are copied into it on the
/// next render, even when several buffers rotate (double / triple buffering). Reads (`withPixels`, `makeCGImage`)
/// and renders are serialized by an internal lock.
public final class FrameBuffer: @unchecked Sendable {
    public let width: Int
    public let height: Int
    public let bytesPerRow: Int
    /// Start of the pixel memory (`bytesPerRow * height` bytes).
    public let baseAddress: UnsafeMutableRawPointer

    private let release: (() -> Void)?
    private let owned: Bool
    private let lock = NSLock()
    private var sequence: UInt64 = 0
    private var info: FrameInfo?

    /// Allocates zeroed memory for a `width x height` frame.
    public init(width: Int, height: Int, rowAlignment: Int = 64) {
        precondition(width > 0 && height > 0, "empty frame buffer")
        precondition(rowAlignment > 0 && rowAlignment.nonzeroBitCount == 1, "alignment must be a power of two")
        self.width = width
        self.height = height
        bytesPerRow = (width * 4 + rowAlignment - 1) & ~(rowAlignment - 1)
        baseAddress = UnsafeMutableRawPointer.allocate(byteCount: bytesPerRow * height, alignment: rowAlignment)
        baseAddress.initializeMemory(as: UInt8.self, repeating: 0, count: bytesPerRow * height)
        owned = true
        release = nil
    }

    /// Wraps memory owned elsewhere (`MTLBuffer.contents()`, a locked `CVPixelBuffer`). `release` runs when the
    /// frame buffer is deallocated; capture the owner in it to keep the memory alive.
    public init(
        wrapping baseAddress: UnsafeMutableRawPointer,
        width: Int,
        height: Int,
        bytesPerRow: Int,
        release: (() -> Void)? = nil
    ) {
        precondition(width > 0 && height > 0 && bytesPerRow >= width * 4, "invalid frame buffer geometry")
        self.width = width
        self.height = height
        self.bytesPerRow = bytesPerRow
        self.baseAddress = baseAddress
        owned = false
        self.release = release
    }

    deinit {
        if owned {
            baseAddress.deallocate()
        }
        release?()
    }

    /// Info of the last frame rendered into this buffer.
    public var lastFrame: FrameInfo? {
        lock.withLock { info }
    }

    /// Renders `request` into the buffer. The viewport must match the buffer size.
    func render(core: Engine, request: RenderRequest, copyAll: Bool) throws -> FrameInfo {
        guard Int(request.viewport.width) == width, Int(request.viewport.height) == height else {
            throw EngineError.InvalidArgument(
                detail: "viewport \(request.viewport.width)x\(request.viewport.height) does not match the \(width)x\(height) buffer"
            )
        }
        return try lock.withLock {
            let result = try core.renderInto(
                request: request,
                address: UInt64(UInt(bitPattern: baseAddress)),
                length: UInt64(bytesPerRow * height),
                stride: UInt32(bytesPerRow),
                bufferSequence: copyAll ? 0 : sequence
            )
            sequence = result.sequence
            info = result
            return result
        }
    }

    /// Read access to the pixels (no render runs meanwhile).
    public func withPixels<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try lock.withLock {
            try body(UnsafeRawBufferPointer(start: baseAddress, count: bytesPerRow * height))
        }
    }

    /// Read access to the pixels together with the info of the frame they show (both read under one lock, so a
    /// concurrent render cannot slip in between). `nil` info before the first render.
    public func withLastFrame<R>(_ body: (FrameInfo?, UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try lock.withLock {
            try body(info, UnsafeRawBufferPointer(start: baseAddress, count: bytesPerRow * height))
        }
    }
}
