import DesynEngine
import Metal
import QuartzCore
import simd
import UIKit

/// Uniforms shared with `canvasFragment` (layout must match the Metal struct: 96 bytes).
struct CanvasUniforms {
    var canvasColor: SIMD4<Float>
    var dotColor: SIMD4<Float>
    /// Page point at the view's top-left (current viewport).
    var viewOrigin: SIMD2<Float>
    /// Page point at the texture's top-left (viewport the frame was rendered for).
    var frameOrigin: SIMD2<Float>
    /// Device pixels per design px now.
    var viewScale: Float
    /// Device pixels per design px of the frame.
    var frameScale: Float
    var frameSize: SIMD2<Float>
    /// Page px between grid dots (0 = no grid).
    var dotSpacing: Float
    var dotRadius: Float
    var hasFrame: Float
    var shadowBlur: Float
    var pageSize: SIMD2<Float>
    var shadowStrength: Float
    var padding: Float
}

/// Draws the engine's frame into a `CAMetalLayer`: the canvas color with its dot grid, a soft page shadow, and
/// the last rendered frame composited on top (premultiplied). While a new frame renders after a pan or zoom,
/// the previous one is re-projected to the current viewport on the GPU, so navigation stays at display rate.
@MainActor
final class MetalCanvasRenderer {
    let device: any MTLDevice
    private let queue: any MTLCommandQueue
    private let pipeline: any MTLRenderPipelineState
    private let frameTexture: MetalFrameTexture
    private let emptyTexture: any MTLTexture
    private var lastCommandBuffer: (any MTLCommandBuffer)?
    /// Viewport the texture shows.
    private(set) var frameViewport: Viewport?

    init?(layer: CAMetalLayer) {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return nil }
        self.device = device
        self.queue = queue
        layer.device = device
        layer.pixelFormat = .bgra8Unorm
        layer.framebufferOnly = true
        layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        layer.isOpaque = true
        do {
            let library = try device.makeLibrary(source: Self.shaderSource, options: nil)
            let descriptor = MTLRenderPipelineDescriptor()
            descriptor.label = "Desyn canvas"
            descriptor.vertexFunction = library.makeFunction(name: "canvasVertex")
            descriptor.fragmentFunction = library.makeFunction(name: "canvasFragment")
            descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            assertionFailure("canvas shader failed: \(error)")
            return nil
        }
        let emptyDescriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: 1, height: 1, mipmapped: false)
        emptyDescriptor.usage = [.shaderRead]
        guard let empty = device.makeTexture(descriptor: emptyDescriptor) else { return nil }
        var clear: UInt32 = 0
        empty.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &clear, bytesPerRow: 4)
        emptyTexture = empty
        frameTexture = MetalFrameTexture(device: device)
    }

    /// Uploads the damaged part of a freshly rendered frame (waits for the GPU to finish reading the texture).
    func upload(_ buffer: FrameBuffer, viewport: Viewport) {
        if let lastCommandBuffer, lastCommandBuffer.status != .completed, lastCommandBuffer.status != .error {
            lastCommandBuffer.waitUntilCompleted()
        }
        frameTexture.update(with: buffer)
        frameViewport = viewport
    }

    /// Forgets the texture (page switch, memory warning).
    func reset() {
        frameTexture.reset()
        frameViewport = nil
    }

    func draw(
        in layer: CAMetalLayer,
        viewport: Viewport,
        canvasColor: UIColor,
        dotColor: UIColor,
        pageSize: CGSize,
        traits: UITraitCollection
    ) {
        guard let drawable = layer.nextDrawable(), let commandBuffer = queue.makeCommandBuffer() else { return }
        let canvas = Self.components(canvasColor.resolvedColor(with: traits))
        let dots = Self.components(dotColor.resolvedColor(with: traits))
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        pass.colorAttachments[0].clearColor = MTLClearColor(red: Double(canvas.x), green: Double(canvas.y), blue: Double(canvas.z), alpha: 1)
        guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass) else { return }

        let viewScale = Float(viewport.zoom * viewport.deviceScale)
        let frame = frameViewport
        let texture = frameTexture.texture
        var uniforms = CanvasUniforms(
            canvasColor: canvas,
            dotColor: dots,
            viewOrigin: SIMD2(Float(viewport.x), Float(viewport.y)),
            frameOrigin: SIMD2(Float(frame?.x ?? 0), Float(frame?.y ?? 0)),
            viewScale: viewScale,
            frameScale: Float((frame?.zoom ?? 1) * (frame?.deviceScale ?? 1)),
            frameSize: SIMD2(Float(texture?.width ?? 1), Float(texture?.height ?? 1)),
            dotSpacing: Float(CanvasGeometry.dotSpacing(zoom: viewport.zoom)),
            dotRadius: Float(0.9 * viewport.deviceScale),
            hasFrame: frame != nil && texture != nil ? 1 : 0,
            shadowBlur: Float(26 * viewport.deviceScale),
            pageSize: SIMD2(Float(pageSize.width), Float(pageSize.height)),
            shadowStrength: traits.userInterfaceStyle == .light ? 0.16 : 0.5,
            padding: 0
        )
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentBytes(&uniforms, length: MemoryLayout<CanvasUniforms>.stride, index: 0)
        encoder.setFragmentTexture(texture ?? emptyTexture, index: 0)
        encoder.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
        lastCommandBuffer = commandBuffer
    }

    private static func components(_ color: UIColor) -> SIMD4<Float> {
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        return SIMD4(Float(r), Float(g), Float(b), Float(a))
    }

    static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;

    struct CanvasUniforms {
        float4 canvasColor;
        float4 dotColor;
        float2 viewOrigin;
        float2 frameOrigin;
        float viewScale;
        float frameScale;
        float2 frameSize;
        float dotSpacing;
        float dotRadius;
        float hasFrame;
        float shadowBlur;
        float2 pageSize;
        float shadowStrength;
        float padding;
    };

    struct VertexOut {
        float4 position [[position]];
    };

    vertex VertexOut canvasVertex(uint vid [[vertex_id]]) {
        const float2 corners[4] = { float2(-1.0, -1.0), float2(1.0, -1.0), float2(-1.0, 1.0), float2(1.0, 1.0) };
        VertexOut out;
        out.position = float4(corners[vid], 0.0, 1.0);
        return out;
    }

    fragment float4 canvasFragment(VertexOut in [[stage_in]],
                                   constant CanvasUniforms& u [[buffer(0)]],
                                   texture2d<float> frame [[texture(0)]]) {
        float2 pixel = in.position.xy;
        float2 page = u.viewOrigin + pixel / u.viewScale;
        float3 color = u.canvasColor.rgb;

        if (u.dotSpacing > 0.0) {
            float2 nearest = round(page / u.dotSpacing) * u.dotSpacing;
            float dist = length((page - nearest) * u.viewScale);
            float a = clamp(u.dotRadius + 0.5 - dist, 0.0, 1.0) * u.dotColor.a;
            color = mix(color, u.dotColor.rgb, a);
        }

        // Soft shadow under the page (drawn outside it; the frame covers the inside).
        float2 shadowPoint = page - float2(0.0, u.shadowBlur * 0.35 / u.viewScale);
        float2 outside = max(max(-shadowPoint, shadowPoint - u.pageSize), float2(0.0));
        float edge = length(outside) * u.viewScale;
        float shadow = u.shadowStrength * (1.0 - smoothstep(0.0, u.shadowBlur, edge));
        color = mix(color, float3(0.0), shadow);

        if (u.hasFrame > 0.5) {
            float2 fp = (page - u.frameOrigin) * u.frameScale;
            if (fp.x >= 0.0 && fp.y >= 0.0 && fp.x < u.frameSize.x && fp.y < u.frameSize.y) {
                constexpr sampler s(coord::pixel, filter::linear, address::clamp_to_edge);
                float4 c = frame.sample(s, fp);
                color = c.rgb + color * (1.0 - c.a);
            }
        }
        return float4(color, 1.0);
    }
    """
}
