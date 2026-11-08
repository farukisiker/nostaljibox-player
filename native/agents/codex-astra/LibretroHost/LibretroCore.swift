import Foundation
import LibretroC

public enum LibretroCoreError: Error, LocalizedError {
    case coreLoad(String)
    case romRejected(String)
    public var errorDescription: String? {
        switch self {
        case .coreLoad(let message), .romRejected(let message): return message
        }
    }
}

/// Call on the session's serial core thread, including teardown. Only one instance may be active.
public final class LibretroCore {
    private static let ownershipLock = NSLock()
    private static var occupied = false
    private var active = false
    private var gameLoaded = false
    private var romStorage: UnsafeMutableRawPointer?
    private var romPath: UnsafeMutablePointer<CChar>?
    public private(set) var systemInfo = retro_system_info()
    public var avInfo: retro_system_av_info {
        var info = retro_system_av_info()
        if active { nb_bridge_av_info(&info) }
        return info
    }

    public init(executableURL: URL) throws {
        Self.ownershipLock.lock()
        let available = !Self.occupied
        if available { Self.occupied = true }
        Self.ownershipLock.unlock()
        guard available else { throw LibretroCoreError.coreLoad("A core session is already active") }
        do {
            let handle = try CoreHandles.open(executableURL)
            if let missing = nb_bridge_load(handle) {
                throw LibretroCoreError.coreLoad("Missing libretro symbol: \(String(cString: missing))")
            }
            guard nb_bridge_api_version() == 1 else {
                throw LibretroCoreError.coreLoad("Unsupported libretro API version")
            }
            let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("NostaljiBox", isDirectory: true)
            let system = root.appendingPathComponent("system", isDirectory: true)
            let saves = root.appendingPathComponent("saves", isDirectory: true)
            try FileManager.default.createDirectory(at: system, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: saves, withIntermediateDirectories: true)
            guard nb_bridge_set_directories(system.path, saves.path), nb_bridge_init() else {
                throw LibretroCoreError.coreLoad("Could not initialize libretro bridge")
            }
            active = true
            nb_bridge_system_info(&systemInfo)
        } catch {
            nb_bridge_deinit()
            Self.releaseOwnership()
            throw error
        }
    }

    public func loadGame(path: String) throws {
        guard active else { throw LibretroCoreError.coreLoad("Core was deinitialized") }
        unloadGame()
        guard FileManager.default.fileExists(atPath: path) else {
            throw LibretroCoreError.romRejected("ROM does not exist: \(path)")
        }
        var bytes: Data?
        if !systemInfo.need_fullpath { bytes = try Data(contentsOf: URL(fileURLWithPath: path)) }
        let cPath = Array(path.utf8CString)
        romPath = .allocate(capacity: cPath.count)
        cPath.withUnsafeBufferPointer { romPath!.initialize(from: $0.baseAddress!, count: $0.count) }
        var game = retro_game_info()
        game.path = UnsafePointer(romPath!)
        if let bytes = bytes {
            romStorage = .allocate(byteCount: max(bytes.count, 1), alignment: 16)
            bytes.withUnsafeBytes { buffer in
                if let base = buffer.baseAddress { romStorage!.copyMemory(from: base, byteCount: buffer.count) }
            }
            game.data = UnsafeRawPointer(romStorage!)
            game.size = bytes.count
        }
        guard nb_bridge_load_game(&game) else {
            releaseROM()
            throw LibretroCoreError.romRejected("Core rejected ROM: \(path)")
        }
        gameLoaded = true
    }
    public func run() { if active && gameLoaded { nb_bridge_run() } }
    public func reset() { if active && gameLoaded { nb_bridge_reset() } }
    public func serializeSize() -> Int { active && gameLoaded ? nb_bridge_serialize_size() : 0 }
    public func serialize() -> Data? {
        let size = serializeSize()
        guard size > 0 else { return nil }
        var data = Data(count: size)
        let ok = data.withUnsafeMutableBytes { nb_bridge_serialize($0.baseAddress, $0.count) }
        return ok ? data : nil
    }
    public func unserialize(_ data: Data) -> Bool {
        guard active && gameLoaded && !data.isEmpty else { return false }
        return data.withUnsafeBytes { nb_bridge_unserialize($0.baseAddress, $0.count) }
    }
    public func saveRAM() -> UnsafeMutableRawBufferPointer? {
        guard active && gameLoaded, let data = nb_bridge_memory_data(UInt32(RETRO_MEMORY_SAVE_RAM)) else { return nil }
        let size = nb_bridge_memory_size(UInt32(RETRO_MEMORY_SAVE_RAM))
        return size > 0 ? UnsafeMutableRawBufferPointer(start: data, count: size) : nil
    }
    public func unloadGame() {
        if active && gameLoaded { nb_bridge_unload_game() }
        gameLoaded = false
        releaseROM()
    }
    private func releaseROM() {
        romStorage?.deallocate(); romStorage = nil
        romPath?.deallocate(); romPath = nil
    }
    public func deinitCore() {
        guard active else { return }
        unloadGame()
        nb_bridge_deinit()
        active = false
        systemInfo = retro_system_info()
        Self.releaseOwnership()
    }
    private static func releaseOwnership() {
        ownershipLock.lock(); occupied = false; ownershipLock.unlock()
    }
    deinit { deinitCore() }

    public var videoFrames: UInt64 { active ? nb_bridge_video_frames() : 0 }
    public var audioFrames: UInt64 { active ? nb_bridge_audio_frames() : 0 }
    /// Copies the last frame on the core thread; safe to retain after subsequent runs.
    public func latestFrame() -> (data: Data, width: Int, height: Int, pitch: Int, format: UInt32)? {
        var frame = nb_frame()
        guard active, nb_bridge_latest_frame(&frame), let data = frame.data else { return nil }
        return (Data(bytes: data, count: frame.pitch * Int(frame.height)),
                Int(frame.width), Int(frame.height), frame.pitch, frame.format.rawValue)
    }
    public func setOption(key: String, value: String) -> Bool {
        active && nb_bridge_set_variable(key, value)
    }
    public func setInputPointer(_ pointer: UnsafePointer<UInt16>?) {
        if active { nb_bridge_set_input_pointer(pointer) }
    }
}

/// Owning wrapper for tests/clients that only depend on LibretroHost.
/// One writer, one reader; clear and destruction require both to be stopped.
public final class AudioRingBuffer {
    public let pointer: OpaquePointer
    public init?(capacityFrames: Int) {
        guard capacityFrames > 0, let ring = nb_ring_create(capacityFrames) else { return nil }
        pointer = ring
    }
    deinit { nb_ring_destroy(pointer) }
    public func write(_ samples: [Int16]) -> Int {
        samples.withUnsafeBufferPointer { nb_ring_write(pointer, $0.baseAddress, $0.count / 2) }
    }
    public func read(frames: Int) -> (samples: [Int16], frames: Int) {
        guard frames > 0, frames <= Int.max / 2 else { return ([], 0) }
        var samples = [Int16](repeating: 0, count: frames * 2)
        let count = samples.withUnsafeMutableBufferPointer { nb_ring_read(pointer, $0.baseAddress, frames) }
        return (samples, count)
    }
    public var fill: Int { nb_ring_fill(pointer) }
    public var underruns: UInt64 { nb_ring_underruns(pointer) }
    public var overflows: UInt64 { nb_ring_overflows(pointer) }
    public func clear() { nb_ring_clear(pointer) }
}
