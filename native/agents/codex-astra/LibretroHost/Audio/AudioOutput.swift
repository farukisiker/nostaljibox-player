import AVFoundation
import LibretroC

/// Owned and controlled by the serial core thread. The AV render thread only touches C state.
public final class AudioOutput {
    private let engine: AVAudioEngine
    private var source: AVAudioSourceNode
    private var renderer: OpaquePointer
    private let ring: OpaquePointer
    private let sampleRate: Double
    private var configurationObserver: NSObjectProtocol?
    /// Posted (on an arbitrary thread) when the engine's hardware format changed and it stopped;
    /// the owner must call `reconnect()` from the core thread and then restart if allowed.
    public var onConfigurationChange: (() -> Void)?

    public init(ring: OpaquePointer, sampleRate: Double) throws {
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.ambient, mode: .default, options: [])
        try audioSession.setActive(true)
        let engine = AVAudioEngine()
        let (source, renderer) = try Self.makeSource(engine: engine, ring: ring, sampleRate: sampleRate)
        self.engine = engine
        self.source = source
        self.renderer = renderer
        self.ring = ring
        self.sampleRate = sampleRate
        engine.prepare()
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.onConfigurationChange?()
        }
    }

    private static func makeSource(engine: AVAudioEngine, ring: OpaquePointer,
                                   sampleRate: Double) throws -> (AVAudioSourceNode, OpaquePointer) {
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
        engine.attach(source)
        engine.connect(source, to: engine.mainMixerNode, format: format)
        return (source, renderer)
    }

    public func start() throws {
        // Re-activate every time: backgrounding or an interruption deactivates the session and
        // engine.start() then throws.
        try AVAudioSession.sharedInstance().setActive(true)
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

    /// Rebuilds the source node at the current hardware format (AVAudioEngineConfigurationChange).
    /// The engine is stopped first, so the old render callback is quiescent before its state dies.
    public func reconnect() throws {
        stop()
        let (source, renderer) = try Self.makeSource(engine: engine, ring: ring, sampleRate: sampleRate)
        engine.disconnectNodeOutput(self.source)
        engine.detach(self.source)
        nb_audio_renderer_destroy(self.renderer)
        self.source = source
        self.renderer = renderer
        engine.prepare()
    }

    /// Call before prefill, while the core producer is also stopped.
    public func reset() {
        stop()
        nb_ring_clear(ring)
        nb_audio_renderer_reset(renderer)
    }

    public var underruns: UInt64 { nb_ring_underruns(ring) }

    deinit {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer) }
        stop()
        engine.disconnectNodeOutput(source)
        engine.detach(source)
        nb_audio_renderer_destroy(renderer)
    }
}

public enum AudioOutputError: Error {
    case invalidFormat
}
