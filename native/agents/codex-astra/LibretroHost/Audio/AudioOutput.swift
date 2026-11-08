import AVFoundation
import LibretroC

/// Owned and controlled by the serial core thread. The AV render thread only touches C state.
public final class AudioOutput {
    private let engine: AVAudioEngine
    private let source: AVAudioSourceNode
    private let renderer: OpaquePointer
    private let ring: OpaquePointer

    public init(ring: OpaquePointer, sampleRate: Double) throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.ambient, mode: .default, options: [])
        try audioSession.setActive(true)
        let engine = AVAudioEngine()
        let hardwareRate = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let outputRate = hardwareRate > 0 ? hardwareRate : 48000
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: outputRate,
                                         channels: 2, interleaved: false),
              let renderer = nb_audio_renderer_create(ring, sampleRate, outputRate) else {
            throw AudioOutputError.invalidFormat
        }
        // Capture only a raw pointer. All realtime sample work and resampling live in C.
        let source = AVAudioSourceNode(format: format) { _, _, frames, buffers in
            nb_audio_render(renderer, frames, buffers)
        }
        self.engine = engine
        self.source = source
        self.renderer = renderer
        self.ring = ring
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: format)
        engine.prepare()
    }

    public func start() throws {
        nb_audio_renderer_set_running(renderer, true)
        do { try engine.start() }
        catch {
            nb_audio_renderer_set_running(renderer, false)
            throw error
        }
    }

    public func pause() {
        nb_audio_renderer_set_running(renderer, false)
        engine.pause()
    }

    public func stop() {
        nb_audio_renderer_set_running(renderer, false)
        engine.stop()
    }

    /// Call before prefill, while the core producer is also stopped.
    public func reset() {
        stop()
        nb_ring_clear(ring)
        nb_audio_renderer_reset(renderer)
    }

    public var underruns: UInt64 { nb_ring_underruns(ring) }

    deinit {
        stop()
        engine.disconnectNodeOutput(source)
        engine.detach(source)
        nb_audio_renderer_destroy(renderer)
    }
}

public enum AudioOutputError: Error {
    case invalidFormat
}
