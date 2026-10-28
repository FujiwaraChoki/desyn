import Metal

/// Keeps an `MTLTexture` in sync with engine frames, uploading only the damaged rectangles when the texture holds
/// the previous frame.
///
/// The texture is `.rgba8Unorm` with **premultiplied** alpha and sRGB-encoded values (the engine's pixels, copied
/// verbatim). Draw it with premultiplied blending (`sourceRGBBlendFactor = .one`, `destinationRGBBlendFactor =
/// .oneMinusSourceAlpha`) into an `.rgba8Unorm` / `.bgra8Unorm` drawable; a non-sRGB format passes the encoded
/// values through unchanged, which matches the engine's output exactly.
///
/// Not thread-safe: call `update` from the thread that encodes the draw (typically the display-link callback),
/// and avoid writing while the GPU still reads the previous frame (use one instance per in-flight frame, or wait for
/// the command buffer).
public final class MetalFrameTexture {
    public let device: any MTLDevice
    public private(set) var texture: (any MTLTexture)?
    /// Sequence number of the frame the texture shows (0 = none).
    public private(set) var sequence: UInt64 = 0

    public init(device: any MTLDevice) {
        self.device = device
    }

    /// Uploads a frame returned by `render`. Returns the uploaded rectangles (empty when nothing changed).
    @discardableResult
    public func update(with frame: RenderedFrame) -> [PixelRect] {
        frame.pixels.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> [PixelRect] in
            guard let base = raw.baseAddress else { return [] }
            return upload(info: frame.info, bytes: base, bytesPerRow: Int(frame.stride))
        }
    }

    /// Uploads the content of a frame buffer after `render(_:into:)`.
    @discardableResult
    public func update(with buffer: FrameBuffer) -> [PixelRect] {
        buffer.withLastFrame { (info: FrameInfo?, raw: UnsafeRawBufferPointer) -> [PixelRect] in
            guard let info, let base = raw.baseAddress else { return [] }
            return upload(info: info, bytes: base, bytesPerRow: buffer.bytesPerRow)
        }
    }

    /// Drops the texture (e.g. on a memory warning); the next update uploads everything.
    public func reset() {
        texture = nil
        sequence = 0
    }

    private func upload(info: FrameInfo, bytes: UnsafeRawPointer, bytesPerRow: Int) -> [PixelRect] {
        let width = Int(info.width)
        let height = Int(info.height)
        guard width > 0, height > 0 else { return [] }
        if info.sequence != 0, info.sequence == sequence {
            return []
        }
        var target = texture
        if target == nil || target?.width != width || target?.height != height {
            let descriptor = MTLTextureDescriptor.texture2DDescriptor(
                pixelFormat: .rgba8Unorm,
                width: width,
                height: height,
                mipmapped: false
            )
            descriptor.usage = [.shaderRead]
            #if os(macOS)
            descriptor.storageMode = device.hasUnifiedMemory ? .shared : .managed
            #else
            descriptor.storageMode = .shared
            #endif
            target = device.makeTexture(descriptor: descriptor)
            texture = target
            sequence = 0
        }
        guard let target else { return [] }
        // Damage is relative to frame `sequence - 1`; anything else needs the whole frame.
        let incremental = !info.full && info.sequence != 0 && sequence != 0 && info.sequence == sequence + 1
        let rects = incremental
            ? info.damage
            : [PixelRect(x: 0, y: 0, width: info.width, height: info.height)]
        for rect in rects where rect.width > 0 && rect.height > 0 {
            let x = Int(rect.x)
            let y = Int(rect.y)
            let w = min(Int(rect.width), width - x)
            let h = min(Int(rect.height), height - y)
            guard w > 0, h > 0 else { continue }
            target.replace(
                region: MTLRegionMake2D(x, y, w, h),
                mipmapLevel: 0,
                withBytes: bytes + y * bytesPerRow + x * 4,
                bytesPerRow: bytesPerRow
            )
        }
        sequence = info.sequence
        return rects
    }
}
