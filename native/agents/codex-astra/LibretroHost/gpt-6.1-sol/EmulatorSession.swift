import AVFoundation
import Foundation
import LibretroC

public struct SessionError: Error, LocalizedError {
    public let code: String
    public let message: String
    public var errorDescription: String? { message }
    public init(code: String, message: String) { self.code = code; self.message = message }
}

/// A dedicated Thread and RunLoop serialize every interaction with the libretro singleton.
public final class EmulatorSession {
    public var onEvent: ((String, [String: Any]) -> Void)?
    private let worker: Thread
    private let loop: CFRunLoop
    private var core: LibretroCore?
    private var audio: AudioOutput?
    private var renderer: MetalRenderer?
    private var clock: FrameClock?
    private var input: InputSource?
    private let buttons = UnsafeMutablePointer<UInt16>.allocate(capacity: 1)
    private var storage: SaveStoring?
    private var romHash = ""
    private var gameId = ""
    private var savedRAM: Data?
    private var pauses = PauseCoordinator()
    private var producing = false
    private var started = false
    /// The last start attempt failed on the audio engine; the "interruption" reason it added is
    /// cleared (and the start retried) on the next pause/resume transition.
    private var audioRetry = false
    private var statsVisible = false
    private var frame: UInt64 = 0
    private var fps = 0.0
    private var targetFps = 0.0
    private var tickStats = TickStats()
    private var linkHz = 0.0, coreMs = 0.0, uploadMs = 0.0
    private var sampleFrames: UInt64 = 0
    private var sampleTime = 0.0
    private var saveTime = 0.0
    private var geometry: [String: Any] = [:]
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var routeRecovery = RouteRecovery()

    public init() {
        let ready = DispatchSemaphore(value: 0)
        var captured: CFRunLoop!
        let thread = Thread {
            let runLoop = CFRunLoopGetCurrent()!
            let port = Port()
            RunLoop.current.add(port, forMode: .default)
            captured = runLoop
            ready.signal()
            CFRunLoopRun()
            withExtendedLifetime(port) {}
        }
        thread.name = "NostaljiBox.libretro"
        thread.qualityOfService = .userInteractive
        thread.stackSize = 8 << 20 // Mednafen cores keep large frame/sound arrays on the stack
        thread.start()
        ready.wait()
        loop = captured
        worker = thread
        buttons.initialize(to: 0)
    }

    private func enqueue(_ action: @escaping () -> Void) {
        CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue, action)
        CFRunLoopWakeUp(loop)
    }
    private func main(_ action: @escaping () -> Void) { DispatchQueue.main.async(execute: action) }
    private func emit(_ name: String, _ value: [String: Any]) {
        main { [weak self] in self?.onEvent?(name, value) }
    }
    private func report(_ error: Error) {
        let value = Self.error(error)
        emit("error", ["code": value.code, "message": value.message])
    }
    private static func error(_ error: Error) -> SessionError {
        if let error = error as? SessionError { return error }
        if let error = error as? LibretroCoreError {
            switch error {
            case .coreLoad(let message): return SessionError(code: "core-load", message: message)
            case .romRejected(let message): return SessionError(code: "rom-rejected", message: message)
            }
        }
        return SessionError(code: "internal", message: error.localizedDescription)
    }

    public func start(coreURL: URL, romURL: URL, romHash: String, gameId: String = "", storage: SaveStoring,
                      input: InputSource? = nil, renderer: MetalRenderer? = nil,
                      completion: @escaping (Result<[String: Any], Error>) -> Void) {
        enqueue { [self] in
            if core != nil { _ = teardown(reason: "user") }
            self.storage = storage; self.romHash = romHash
            self.gameId = gameId.isEmpty ? romHash : gameId
            self.input = input; self.renderer = renderer
            do {
                let loaded = try LibretroCore(executableURL: coreURL, systemDirectory: storage.systemDirectory,
                                              saveDirectory: storage.saveDirectory)
                core = loaded
                try loaded.loadGame(path: romURL.path)
                loaded.setInputPointer(UnsafePointer(buttons))
                if let memory = loaded.saveRAM(), let saved = storage.loadSRAM(romHash: romHash) {
                    saved.withUnsafeBytes { bytes in
                        if let base = bytes.baseAddress { memory.baseAddress?.copyMemory(from: base, byteCount: min(memory.count, bytes.count)) }
                    }
                }
                savedRAM = loaded.saveRAM().map { Data($0) }
                let av = loaded.avInfo
                let rate = av.timing.fps
                guard rate.isFinite, rate > 0, av.timing.sample_rate.isFinite, av.timing.sample_rate > 0 else {
                    throw SessionError(code: "core-load", message: "Core returned invalid timing")
                }
                try renderer?.configure(maxWidth: Int(av.geometry.max_width), maxHeight: Int(av.geometry.max_height))
                guard let ring = nb_bridge_audio_ring() else { throw SessionError(code: "audio", message: "Missing audio ring") }
                do { audio = try AudioOutput(ring: ring, sampleRate: av.timing.sample_rate) }
                catch { throw SessionError(code: "audio", message: error.localizedDescription) }
                audio?.onConfigurationChange = { [weak self] in self?.handleConfigurationChange() }
                observeInterruptions()
                frame = 0; fps = 0; sampleFrames = 0; targetFps = rate
                linkHz = 0; coreMs = 0; uploadMs = 0; tickStats = TickStats()
                sampleTime = ProcessInfo.processInfo.systemUptime; saveTime = sampleTime
                clock = FrameClock(fps: rate) { [weak self] count in self?.tick(count) }
                // Seed geometry from av info so the first renderFrame only emits a real change.
                geometry = ["width": Int(av.geometry.base_width), "height": Int(av.geometry.base_height), "aspect": aspect()]
                let result: [String: Any] = ["width": Int(av.geometry.base_width), "height": Int(av.geometry.base_height),
                    "maxWidth": Int(av.geometry.max_width), "maxHeight": Int(av.geometry.max_height),
                    "fps": rate, "sampleRate": av.timing.sample_rate, "aspect": aspect()]
                started = true
                emit("started", result) // before the first "state"/"geometry"
                pauses.begin()
                updateRunning() // an audio start failure here pauses instead of failing the start
                main { completion(.success(result)) }
            } catch {
                let failure = Self.error(error)
                _ = teardown(reason: "error")
                report(failure)
                main { completion(.failure(failure)) }
            }
        }
    }

    public func stop(reason: String = "user", completion: @escaping (Bool) -> Void) {
        enqueue { [self] in let saved = teardown(reason: reason); main { completion(saved) } }
    }
    @discardableResult private func teardown(reason: String) -> Bool {
        let existed = started
        started = false; audioRetry = false
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer); interruptionObserver = nil }
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer); routeObserver = nil }
        routeRecovery = RouteRecovery()
        clock?.stop(); clock = nil; producing = false; fps = 0; targetFps = 0
        linkHz = 0; coreMs = 0; uploadMs = 0
        audio?.stop(); audio = nil // detach source and destroy renderer before bridge frees its ring
        renderer?.shutdown(); renderer = nil
        let saved = saveSRAM()
        core?.setInputPointer(nil)
        core?.unloadGame(); core?.deinitCore(); core = nil
        input = nil; storage = nil; gameId = ""; savedRAM = nil; geometry = [:]
        pauses.end()
        if existed { emit("stopped", ["reason": reason]) }
        return saved
    }
    public func pause(completion: @escaping () -> Void = {}) { setPauseReason("user", active: true, completion: completion) }
    public func resume(completion: @escaping () -> Void = {}) {
        enqueue { [self] in routeRecovery = RouteRecovery(); transition { pauses.resume() }; main(completion) }
    }
    public func setPauseReason(_ reason: String, active: Bool, completion: @escaping () -> Void = {}) {
        enqueue { [self] in transition { pauses.set(reason, active: active) }; main(completion) }
    }
    /// Every pause/resume change goes through here so a failed audio start is retried once the
    /// reasons change again (the "interruption" it added is removed before the change applies).
    private func transition(_ change: () -> Void) {
        if audioRetry { audioRetry = false; pauses.set("interruption", active: false) }
        change()
        updateRunning()
    }
    private func updateRunning() {
        do { try reevaluate() }
        catch {
            // The core and session survive; only the engine failed (session not active, route
            // busy...). Stay paused under "interruption" and retry on the next transition. No
            // "error" event: JS treats every error as fatal and falls back to EmulatorJS.
            audioRetry = true
            pauses.set("interruption", active: true)
            producing = false
            if pauses.active { emit("state", ["state": "paused", "reasons": pauses.reasons.sorted()]) }
        }
    }
    private func reevaluate() throws {
        let policy = pauses
        producing = try policy.reconcile(currentlyRunning: producing, start: { [self] in
            audio?.reset()
            if let core = core, let ring = nb_bridge_audio_ring() {
                let target = Int(core.avInfo.timing.sample_rate * 0.064)
                // A broken core producing no audio must not trap the serial executor.
                for _ in 0..<32 { if nb_ring_fill(ring) >= target { break }; runFrame() }
            }
            renderFrame()
            try audio?.start()
            clock?.start()
            sampleTime = ProcessInfo.processInfo.systemUptime; sampleFrames = frame; tickStats = TickStats()
        }, pause: { [self] in
            clock?.pause(); audio?.pause(); fps = 0; linkHz = 0; coreMs = 0; uploadMs = 0; _ = saveSRAM()
        })
        if pauses.active { emit("state", ["state": producing ? "running" : "paused", "reasons": pauses.reasons.sorted()]) }
    }

    // MARK: Audio session events (PLAN §1.5). Notifications arrive on arbitrary threads; all
    // state changes are enqueued onto the core RunLoop.
    private func observeInterruptions() {
        observeRouteChanges()
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: nil) { [weak self] note in
            guard let self = self, let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            switch type {
            case .began:
                self.setPauseReason("interruption", active: true)
            case .ended:
                let options = AVAudioSession.InterruptionOptions(
                    rawValue: note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
                self.enqueue {
                    guard self.started else { return }
                    self.transition {
                        self.pauses.set("interruption", active: false)
                        // The interruption is over, but the game only resumes by itself when iOS says so.
                        if !options.contains(.shouldResume) { self.pauses.set("user", active: true) }
                    }
                }
            @unknown default: break
            }
        }
    }
    private func observeRouteChanges() {
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer) }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: AVAudioSession.sharedInstance(), queue: nil) { [weak self] note in
            guard let self = self, let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
            let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
            let oldOutputs = Set(previous?.outputs.map { $0.uid } ?? [])
            let currentOutputs = Set(AVAudioSession.sharedInstance().currentRoute.outputs.map { $0.uid })
            let now = ProcessInfo.processInfo.systemUptime
            self.enqueue {
                guard self.started else { return }
                switch reason {
                case .oldDeviceUnavailable:
                    self.routeRecovery.lost(outputs: oldOutputs, at: now)
                    self.transition { self.pauses.set("route", active: true) }
                case .newDeviceAvailable:
                    if self.routeRecovery.returned(outputs: currentOutputs, at: now) {
                        self.transition { self.pauses.set("route", active: false) }
                    }
                default: break
                }
            }
        }
    }
    private func handleConfigurationChange() {
        enqueue { [self] in
            guard started, let audio = audio else { return }
            transition { pauses.set("configChange", active: true) } // stops the clock and engine
            do { try audio.reconnect() } catch { report(SessionError(code: "audio", message: error.localizedDescription)) }
            transition { pauses.set("configChange", active: false) } // restarts only if nothing else pauses
        }
    }

    public func reset(completion: @escaping () -> Void = {}) {
        enqueue { [self] in core?.reset(); main(completion) }
    }

    // State operations share the core executor with ticks, so serialization never races retro_run.
    private func stateOperation<T>(_ completion: @escaping (Result<T, Error>) -> Void,
                                   action: @escaping () throws -> T) {
        enqueue { [self] in
            let result: Result<T, Error>
            do {
                guard started, core != nil else { throw SessionError(code: "no-session", message: "No active game") }
                result = .success(try action())
            } catch { result = .failure(Self.error(error)) }
            main { completion(result) }
        }
    }
    private func stateURL(slot: Int) throws -> URL {
        guard (1...3).contains(slot) else { throw SessionError(code: "internal", message: "State slot must be 1, 2 or 3") }
        guard let storage = storage else { throw SessionError(code: "no-session", message: "No active save store") }
        return storage.stateURL(gameId: gameId, slot: slot)
    }
    private func serializedState() throws -> Data {
        guard let data = core?.serialize(), !data.isEmpty else {
            throw SessionError(code: "internal", message: "Core could not serialize state")
        }
        return data
    }
    private func restoreState(_ data: Data) throws {
        guard !data.isEmpty else { throw SessionError(code: "internal", message: "Empty state data") }
        let wasProducing = producing
        clock?.pause()
        // reset stops the engine before clearing both the queued samples and resampler history.
        audio?.reset()
        producing = false
        defer {
            // Do not use reevaluate: its startup prefill advances the newly restored core.
            // All pause reasons remain intact, including when the core rejects the state.
            if wasProducing {
                do {
                    try audio?.start()
                    producing = true
                    clock?.start()
                    sampleTime = ProcessInfo.processInfo.systemUptime; sampleFrames = frame
                    tickStats = TickStats()
                } catch {
                    audioRetry = true
                    pauses.set("interruption", active: true)
                    fps = 0; linkHz = 0; coreMs = 0; uploadMs = 0
                    emit("state", ["state": "paused", "reasons": pauses.reasons.sorted()])
                }
            }
        }
        guard core?.unserialize(data) == true else {
            throw SessionError(code: "internal", message: "Core rejected state data")
        }
    }
    public func saveState(slot: Int, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        stateOperation(completion) { [self] in
            let url = try stateURL(slot: slot)
            let data = try serializedState()
            try data.write(to: url, options: .atomic)
            return ["bytes": data.count]
        }
    }
    public func loadState(slot: Int, completion: @escaping (Result<Void, Error>) -> Void) {
        stateOperation(completion) { [self] in
            let url = try stateURL(slot: slot)
            let data: Data
            do { data = try Data(contentsOf: url) }
            catch let error as CocoaError where error.code == .fileReadNoSuchFile {
                throw SessionError(code: "no-state", message: "No saved state in slot \(slot)")
            }
            try restoreState(data)
        }
    }
    public func listStates(completion: @escaping (Result<[[String: Any]], Error>) -> Void) {
        stateOperation(completion) { [self] in
            guard let storage = storage else { throw SessionError(code: "no-session", message: "No active save store") }
            return storage.listStates(gameId: gameId).map { ["slot": $0.slot, "mtime": $0.mtime.timeIntervalSince1970 * 1000] }
        }
    }
    public func serializeState(completion: @escaping (Result<Data, Error>) -> Void) {
        stateOperation(completion) { [self] in try serializedState() }
    }
    public func unserializeState(_ data: Data, completion: @escaping (Result<Void, Error>) -> Void) {
        stateOperation(completion) { [self] in try restoreState(data) }
    }
    public func setScaling(_ mode: String) { enqueue { [self] in renderer?.setScaling(mode) } }
    public func setStatsVisible(_ visible: Bool) { enqueue { [self] in statsVisible = visible } }
    public func setOption(key: String, value: String, completion: @escaping (Bool) -> Void = { _ in }) {
        enqueue { [self] in let result = core?.setOption(key: key, value: value) ?? false; main { completion(result) } }
    }
    public func getStats(completion: @escaping ([String: Any]) -> Void) {
        enqueue { [self] in let value = stats(); main { completion(value) } }
    }
    /// API.md §3 fields plus additive diagnostics: `targetFps` (the core's av_info rate, so a PAL
    /// game at 50 is told apart from an NTSC game running slow), `linkHz` (display-link ticks per
    /// second on the core thread), `coreMs` (average retro_run) and `uploadMs` (average
    /// latestFrame + render call on the core thread).
    private func stats() -> [String: Any] {
        ["fps": fps, "footprintMB": MemoryStats.footprintMB, "audioUnderruns": audio?.underruns ?? 0,
         "frame": frame, "thermalState": MemoryStats.thermalState,
         "targetFps": targetFps, "linkHz": linkHz, "coreMs": coreMs, "uploadMs": uploadMs]
    }
    private func aspect() -> Double {
        guard let g = core?.avInfo.geometry else { return 1 }
        return g.aspect_ratio > 0 ? Double(g.aspect_ratio) : Double(g.base_width) / Double(max(1, g.base_height))
    }
    private func runFrame() {
        buttons.pointee = input?.snapshot(port: 0).buttons ?? 0
        core?.run(); frame += 1
    }
    private func renderFrame() {
        if let image = core?.latestFrame() {
            renderer?.render(frame: image, aspect: aspect())
            let next: [String: Any] = ["width": image.width, "height": image.height, "aspect": aspect()]
            if !NSDictionary(dictionary: geometry).isEqual(to: next) { geometry = next; emit("geometry", next) }
        }
    }
    private func tick(_ count: Int) {
        guard producing else { return }
        tickStats.recordTick()
        if count > 0 {
            let before = ProcessInfo.processInfo.systemUptime
            for _ in 0..<count { runFrame() }
            let ran = ProcessInfo.processInfo.systemUptime
            renderFrame()
            let rendered = ProcessInfo.processInfo.systemUptime
            tickStats.recordRun(seconds: ran - before, frames: count)
            tickStats.recordUpload(seconds: rendered - ran)
        }
        let now = ProcessInfo.processInfo.systemUptime
        if now - saveTime >= 5 { _ = saveSRAM(); saveTime = now }
        if now - sampleTime >= 1 {
            fps = Double(frame - sampleFrames) / (now - sampleTime)
            let sample = tickStats.sample(elapsed: now - sampleTime)
            linkHz = sample.linkHz; coreMs = sample.coreMs; uploadMs = sample.uploadMs
            sampleTime = now; sampleFrames = frame
            if statsVisible { emit("stats", stats()) }
        }
    }
    /// Termination cannot rely on a main-queue completion. Bound the wait if a core is stuck;
    /// a queued flush may still finish afterwards. The semaphore publishes its result safely.
    @discardableResult public func flushSRAM() -> Bool {
        if Thread.current === worker { return saveSRAM() }
        let finished = DispatchSemaphore(value: 0)
        var saved = false
        enqueue { [self] in
            saved = saveSRAM()
            finished.signal()
        }
        guard finished.wait(timeout: .now() + 2) == .success else { return false }
        return saved
    }
    @discardableResult private func saveSRAM() -> Bool {
        guard let memory = core?.saveRAM(), let storage = storage else { return false }
        let data = Data(memory)
        guard data != savedRAM else { return false }
        do { try storage.saveSRAM(data, romHash: romHash); savedRAM = data; return true }
        catch { report(error); return false }
    }
    deinit {
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer) }
        let oldCore = core, oldRenderer = renderer, oldClock = clock
        var retiredAudio = audio
        audio = nil; core = nil; renderer = nil; clock = nil
        let pointer = buttons, ownerLoop = loop
        CFRunLoopPerformBlock(ownerLoop, CFRunLoopMode.defaultMode.rawValue) {
            oldClock?.stop()
            retiredAudio?.stop(); retiredAudio = nil
            oldRenderer?.shutdown()
            oldCore?.setInputPointer(nil); oldCore?.deinitCore()
            pointer.deinitialize(count: 1); pointer.deallocate()
            CFRunLoopStop(ownerLoop)
        }
        CFRunLoopWakeUp(ownerLoop)
    }
}

/// Only an identical output UID set returning within two seconds permits automatic recovery.
/// Empty/unknown route identities always require an explicit resume.
struct RouteRecovery {
    private var outputs: Set<String> = []
    private var lostAt: TimeInterval?
    mutating func lost(outputs: Set<String>, at time: TimeInterval) {
        self.outputs = outputs
        lostAt = time
    }
    mutating func returned(outputs: Set<String>, at time: TimeInterval) -> Bool {
        guard let lostAt = lostAt, !self.outputs.isEmpty, outputs == self.outputs,
              time >= lostAt, time - lostAt <= 2 else { return false }
        self = RouteRecovery()
        return true
    }
}

/// Per-second counters behind the stats label. Pure so the averages can be unit-tested.
struct TickStats {
    private(set) var ticks = 0
    private(set) var runs = 0
    private(set) var runSeconds = 0.0
    private(set) var uploads = 0
    private(set) var uploadSeconds = 0.0
    /// One display-link callback, with or without frames to run.
    mutating func recordTick() { ticks += 1 }
    /// Wall time of `frames` consecutive retro_run calls.
    mutating func recordRun(seconds: Double, frames: Int) { runs += frames; runSeconds += seconds }
    /// Wall time of one latestFrame + render call on the core thread.
    mutating func recordUpload(seconds: Double) { uploads += 1; uploadSeconds += seconds }
    /// linkHz = ticks per second, coreMs = average retro_run, uploadMs = average render call; then resets.
    mutating func sample(elapsed: Double) -> (linkHz: Double, coreMs: Double, uploadMs: Double) {
        let hz = elapsed > 0 ? Double(ticks) / elapsed : 0
        let core = runs > 0 ? runSeconds / Double(runs) * 1000 : 0
        let upload = uploads > 0 ? uploadSeconds / Double(uploads) * 1000 : 0
        self = TickStats()
        return (hz, core, upload)
    }
}
