import Foundation
import MetalKit

public enum VideoError: Error {
    case unavailable
    case missingShader
    case invalidGeometry
    case textureAllocation
}

/// Created with its view on the main thread; configure/render/shutdown belong to the core thread.
/// Each texture remains leased until its command buffer completes. No core-owned pixels reach GPU.
public final class MetalRenderer: NSObject, MTKViewDelegate {
    public typealias Frame = (data: Data, width: Int, height: Int, pitch: Int, format: UInt32)
    private let view: MTKView
    private let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let available = DispatchSemaphore(value: 3)
    private var textures: [MTLTexture] = []
    private var pixelFormat: MTLPixelFormat?
    private var maxWidth = 1
    private var maxHeight = 1
    private var nextSlot = 0
    private var pending: (frame: Frame, aspect: Double)?
    private var stopped = false
    private let scalingLock = NSLock()
    private var scaling = "fit"

    public init(view: MTKView) throws {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { throw VideoError.unavailable }
        self.view = view
        self.device = device
        self.queue = queue
        view.device = device
        view.colorPixelFormat = .bgra8Unorm
        view.framebufferOnly = true
        view.isPaused = true
        view.enableSetNeedsDisplay = false
        view.clearColor = MTLClearColorMake(0, 0, 0, 1)
        let library: MTLLibrary
        do {
            library = try device.makeDefaultLibrary(bundle: .module)
        } catch {
            // SwiftPM normally compiles Shaders.metal. Runtime compilation also supports builds
            // that copy the source instead, and simulators without the optional Metal toolchain.
            let source = Bundle.module.url(forResource: "Shaders", withExtension: "metal")
                .flatMap { try? String(contentsOf: $0, encoding: .utf8) } ?? Self.shaderSource
            library = try device.makeLibrary(source: source, options: nil)
        }
        guard let vertex = library.makeFunction(name: "nb_vertex"),
              let fragment = library.makeFunction(name: "nb_fragment") else { throw VideoError.missingShader }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.colorAttachments[0].pixelFormat = view.colorPixelFormat
        pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        super.init()
        view.delegate = self
    }

    public func configure(maxWidth: Int, maxHeight: Int) throws {
        guard maxWidth > 0, maxHeight > 0, maxWidth <= 16384, maxHeight <= 16384 else {
            throw VideoError.invalidGeometry
        }
        guard maxWidth != self.maxWidth || maxHeight != self.maxHeight else { return }
        waitForGPU()
        textures.removeAll()
        pixelFormat = nil
        self.maxWidth = maxWidth
        self.maxHeight = maxHeight
        nextSlot = 0
    }

    public func setScaling(_ mode: String) {
        scalingLock.lock()
        scaling = ["fit", "integer", "stretch"].contains(mode) ? mode : "fit"
        scalingLock.unlock()
    }

    public func render(frame: Frame, aspect: Double) {
        guard !stopped else { return }
        pending = (frame, aspect)
        view.draw()
        pending = nil
    }

    public func draw(in view: MTKView) {
        guard !stopped, let pending = pending else { return }
        let frame = pending.frame
        let format: MTLPixelFormat
        let bytesPerPixel: Int
        switch frame.format {
        case 0: format = .bgr5A1Unorm; bytesPerPixel = 2
        case 1: format = .bgra8Unorm; bytesPerPixel = 4
        case 2: format = .b5g6r5Unorm; bytesPerPixel = 2
        default: return
        }
        guard frame.width > 0, frame.height > 0, frame.width <= 16384, frame.height <= 16384,
              frame.pitch >= frame.width * bytesPerPixel,
              frame.pitch <= Int.max / frame.height,
              frame.data.count >= frame.pitch * frame.height else { return }
        if frame.width > maxWidth || frame.height > maxHeight {
            do { try configure(maxWidth: max(frame.width, maxWidth), maxHeight: max(frame.height, maxHeight)) }
            catch { return }
        }
        if pixelFormat != format || textures.isEmpty {
            do { try allocateTextures(format: format) }
            catch { return }
        }
        // If all GPU slots are in flight, skip presenting this frame rather than stall emulation.
        guard available.wait(timeout: .now()) == .success else { return }
        var submitted = false
        defer { if !submitted { available.signal() } }
        guard let drawable = view.currentDrawable,
              let pass = view.currentRenderPassDescriptor,
              let command = queue.makeCommandBuffer(),
              let encoder = command.makeRenderCommandEncoder(descriptor: pass) else { return }
        let texture = textures[nextSlot]
        frame.data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            texture.replace(region: MTLRegionMake2D(0, 0, frame.width, frame.height), mipmapLevel: 0,
                            withBytes: base, bytesPerRow: frame.pitch)
        }
        scalingLock.lock()
        let mode = scaling
        scalingLock.unlock()
        let size = CGSize(width: drawable.texture.width, height: drawable.texture.height)
        let scale = Self.viewportScale(width: frame.width, height: frame.height,
                                       aspect: pending.aspect, drawableSize: size, mode: mode)
        var uniforms = Uniforms(scale: scale,
                                uvMax: SIMD2(Float(frame.width) / Float(maxWidth),
                                             Float(frame.height) / Float(maxHeight)))
        encoder.setRenderPipelineState(pipeline)
        encoder.setVertexBytes(&uniforms, length: MemoryLayout<Uniforms>.stride, index: 0)
        encoder.setFragmentTexture(texture, index: 0)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 6)
        encoder.endEncoding()
        command.present(drawable)
        let semaphore = available
        command.addCompletedHandler { _ in semaphore.signal() }
        command.commit()
        submitted = true
        nextSlot = (nextSlot + 1) % 3
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    public func shutdown() {
        guard !stopped else { return }
        stopped = true
        pending = nil
        waitForGPU()
        textures.removeAll()
    }

    private func allocateTextures(format: MTLPixelFormat) throws {
        waitForGPU()
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: format, width: maxWidth, height: maxHeight, mipmapped: false)
        descriptor.usage = .shaderRead
        descriptor.storageMode = .shared
        var replacement: [MTLTexture] = []
        for _ in 0..<3 {
            guard let texture = device.makeTexture(descriptor: descriptor) else { throw VideoError.textureAllocation }
            replacement.append(texture)
        }
        textures = replacement
        pixelFormat = format
        nextSlot = 0
    }

    private func waitForGPU() {
        for _ in 0..<3 { available.wait() }
        for _ in 0..<3 { available.signal() }
    }

    private struct Uniforms {
        var scale: SIMD2<Float>
        var uvMax: SIMD2<Float>
    }

    // Kept separate from GPU work so scaling can be checked without a Metal device.
    static func viewportScale(width: Int, height: Int, aspect: Double,
                              drawableSize: CGSize, mode: String) -> SIMD2<Float> {
        let dw = Double(drawableSize.width), dh = Double(drawableSize.height)
        guard width > 0, height > 0, dw > 0, dh > 0 else { return SIMD2(1, 1) }
        if mode == "stretch" { return SIMD2(1, 1) }
        let ratio = aspect.isFinite && aspect > 0 ? aspect : Double(width) / Double(height)
        var targetHeight = min(dh, dw / ratio)
        if mode == "integer" {
            let steps = floor(min(dh / Double(height), dw / (Double(height) * ratio)))
            if steps >= 1 { targetHeight = Double(height) * steps }
        }
        return SIMD2(Float(targetHeight * ratio / dw), Float(targetHeight / dh))
    }

    // Same shader as Shaders.metal, used only if no compiled library/source resource is usable.
    private static let shaderSource = """
    #include <metal_stdlib>
    using namespace metal;
    struct NBVertex { float4 position [[position]]; float2 uv; };
    struct NBUniforms { float2 scale; float2 uvMax; };
    vertex NBVertex nb_vertex(uint id [[vertex_id]], constant NBUniforms &u [[buffer(0)]]) {
        const float2 p[6] = {float2(-1,1),float2(-1,-1),float2(1,-1),float2(-1,1),float2(1,-1),float2(1,1)};
        const float2 uv[6] = {float2(0,0),float2(0,1),float2(1,1),float2(0,0),float2(1,1),float2(1,0)};
        NBVertex out; out.position = float4(p[id] * u.scale, 0, 1); out.uv = uv[id] * u.uvMax; return out;
    }
    fragment float4 nb_fragment(NBVertex in [[stage_in]], texture2d<float> frame [[texture(0)]]) {
        constexpr sampler s(coord::normalized,address::clamp_to_edge,filter::nearest);
        return float4(frame.sample(s,in.uv).rgb,1);
    }
    """
}
