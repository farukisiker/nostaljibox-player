// SPDX-License-Identifier: MIT
// N0-h, docs/native-player/NETPLAY.md §8.2: determinism of the native two-phone lockstep path.
//
// Only one LibretroCore may exist per process (LibretroCore.occupied), so every "second phone" is a
// sequential fresh load after a full teardown. Cores: NB_CORES_DIR/<core>.framework/<core>;
// fixtures: NB_FIXTURES_DIR/snes-input/input-test.sfc (fable) and NB_FIXTURES_DIR/{md,segaMD}/pong.md
// (gemini-argon). Checkpoints hash what EmulatorSession.checksum hashes: RETRO_MEMORY_SYSTEM_RAM when the
// core exposes it, else the serialized state. Supafaust (lock 642d1d1) exposes no system RAM and its
// state ("MDFNRINP") carries no variable names, so the SNES pad words are read from the ROM's SRAM mirror
// (RETRO_MEMORY_SAVE_RAM: hash1, hash2, frame, held1, held2), which the core does expose.
// Log lines start with "** [DET]" so native-ci's log grep keeps them.
import Foundation
import XCTest
import LibretroC
import LibretroHost

/// xorshift32 button script. The same seed gives the same per-frame masks on every run, which is
/// exactly what both phones see in lockstep (host port 0, guest port 1).
private struct InputScript {
    private var state: UInt32
    init(seed: UInt32) { state = seed == 0 ? 0x9E37_79B9 : seed }
    mutating func next() -> UInt32 {
        state ^= state << 13
        state ^= state >> 17
        state ^= state << 5
        return state
    }
    /// One libretro joypad mask per frame (bits 0-11: B Y Select Start Up Down Left Right A X L R),
    /// each combination held for 1-8 frames, about one frame in eight idle.
    mutating func masks(frames: Int) -> [UInt16] {
        var out: [UInt16] = []
        out.reserveCapacity(frames)
        var current: UInt16 = 0
        var hold = 0
        while out.count < frames {
            if hold == 0 {
                let r = next()
                current = (r >> 28) == 0 ? 0 : UInt16(r & 0x0FFF)
                hold = Int((r >> 16) & 7) + 1
            }
            out.append(current)
            hold -= 1
        }
        return out
    }
}

private struct DeterminismError: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}

/// The input-test ROM's pad words as mirrored into SRAM every frame (fixtures/snes-input/README.md):
/// $700000 hash1 (= WRAM $7E0006, pad 1 history), $700002 hash2 (= $7E0008, pad 2 history),
/// $700004 frame, $700006 held1, $700008 held2. Little-endian.
private struct PadWords: CustomStringConvertible {
    let hash1, hash2, frame, held1, held2: UInt16
    var description: String {
        String(format: "frame=%u hash1=$%04X hash2=$%04X held1=%u held2=%u",
               UInt32(frame), UInt32(hash1), UInt32(hash2), UInt32(held1), UInt32(held2))
    }
}

/// One phone: a core with a game loaded and the two-port input pointer installed.
private final class Phone {
    let core: LibretroCore
    private let buttons = UnsafeMutablePointer<UInt16>.allocate(capacity: 2)
    private var alive = true

    init(executable: URL, rom: URL) throws {
        buttons.initialize(repeating: 0, count: 2)
        do { core = try LibretroCore(executableURL: executable) } catch {
            buttons.deallocate()
            throw error
        }
        do { try core.loadGame(path: rom.path) } catch {
            core.deinitCore()
            buttons.deallocate()
            throw error
        }
        core.setInputPointer(UnsafePointer(buttons))
    }

    func tearDown() {
        guard alive else { return }
        alive = false
        core.setInputPointer(nil)
        core.deinitCore()
        buttons.deallocate()
    }

    /// Runs one frame with the given port masks (the bridge copies both on the core's input_poll).
    func step(_ port0: UInt16, _ port1: UInt16) {
        buttons[0] = port0
        buttons[1] = port1
        core.run()
    }
    func idle(_ frames: Int) { for _ in 0..<frames { step(0, 0) } }
    func play(_ port0: [UInt16], _ port1: [UInt16], from start: Int, count: Int) {
        for i in start..<(start + count) { step(port0[i], port1[i]) }
    }

    var systemRAM: UnsafeRawBufferPointer? {
        let size = nb_bridge_memory_size(UInt32(RETRO_MEMORY_SYSTEM_RAM))
        guard size > 0, let base = nb_bridge_memory_data(UInt32(RETRO_MEMORY_SYSTEM_RAM)) else { return nil }
        return UnsafeRawBufferPointer(start: base, count: size)
    }
    var systemRAMSize: Int { nb_bridge_memory_size(UInt32(RETRO_MEMORY_SYSTEM_RAM)) }

    /// Fills cartridge RAM the way a frontend loads an .srm; returns the number of bytes written.
    func fillSaveRAM(_ byte: UInt8) -> Int {
        guard let sram = core.saveRAM() else { return 0 }
        for i in 0..<sram.count { sram[i] = byte }
        return sram.count
    }
    func saveRAMBytes() -> [UInt8] { core.saveRAM().map { [UInt8]($0) } ?? [] }

    /// The input-test ROM's pad words from its SRAM mirror (the core exposes RETRO_MEMORY_SAVE_RAM, 2 KiB).
    func padWords() throws -> PadWords {
        let sram = saveRAMBytes()
        guard sram.count >= 10 else {
            throw DeterminismError("cartridge RAM not exposed (\(sram.count) bytes; input-test.sfc declares 2 KiB)")
        }
        func word(_ offset: Int) -> UInt16 { UInt16(sram[offset]) | (UInt16(sram[offset + 1]) << 8) }
        return PadWords(hash1: word(0x00), hash2: word(0x02), frame: word(0x04), held1: word(0x06), held2: word(0x08))
    }
    /// The pad words when the loaded ROM is the SNES input-test ROM, nil for other systems.
    func padWords(ifSNES wanted: Bool) throws -> PadWords? {
        if wanted { return try padWords() }
        return nil
    }

    /// FNV-1a over what the native lockstep checksum hashes (EmulatorSession.checksum): system RAM
    /// when the core exposes it, otherwise the whole serialized state.
    func checkpointHash() -> UInt64 {
        if let ram = systemRAM { return fnv1a(ram) }
        guard let state = core.serialize() else { return 0 }
        return state.withUnsafeBytes { fnv1a($0) }
    }
    var checkpointSource: String {
        systemRAM != nil ? "system RAM (\(systemRAMSize) bytes)" : "serialized state (\(core.serializeSize()) bytes)"
    }
}

private func fnv1a(_ bytes: UnsafeRawBufferPointer) -> UInt64 {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in bytes { hash = (hash ^ UInt64(byte)) &* 0x100_0000_01b3 }
    return hash
}
private func fnv1a(_ bytes: [UInt8]) -> UInt64 { bytes.withUnsafeBytes { fnv1a($0) } }
private func hex(_ value: UInt64) -> String { String(format: "%016llX", value) }

/// What one phone recorded while replaying the 600-frame script from the shared state.
private struct Replay {
    var checkpoints: [UInt64] = []        // hash right after serialize/unserialize, then every 100 frames
    var words: [PadWords?] = []           // the SNES ROM's pad words at the same points (nil on other systems)
    var saveRAMAfterLoad: [UInt8] = []    // guest only: cartridge RAM right after unserialize(S0)
    var saveRAMAtEnd: [UInt8] = []
    var source = ""
}

final class FableDeterminismTests: XCTestCase {
    private let preRoll = 120           // host frames before S0 = serialize()
    private let guestPreRoll = 37       // guest frames of unrelated input before unserialize(S0)
    private let scriptFrames = 600
    private let checkpointEvery = 100

    // MARK: fixtures

    private func environment(_ name: String) -> String? {
        ProcessInfo.processInfo.environment[name]
    }
    private func coreExecutable(_ name: String) throws -> URL {
        guard let cores = environment("NB_CORES_DIR") else { throw XCTSkip("no core/fixture: NB_CORES_DIR unset") }
        let url = URL(fileURLWithPath: cores, isDirectory: true)
            .appendingPathComponent("\(name).framework", isDirectory: true).appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw XCTSkip("no core/fixture: \(name) missing") }
        return url
    }
    private func fixture(_ candidates: [String]) throws -> URL {
        guard let fixtures = environment("NB_FIXTURES_DIR") else { throw XCTSkip("no core/fixture: NB_FIXTURES_DIR unset") }
        let root = URL(fileURLWithPath: fixtures, isDirectory: true)
        for relative in candidates {
            let url = root.appendingPathComponent(relative)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        throw XCTSkip("no core/fixture: none of \(candidates) under \(fixtures)")
    }

    /// Loads, runs `body`, and always tears the core down so the next phone can load.
    private func withPhone<T>(_ executable: URL, _ rom: URL, _ body: (Phone) throws -> T) throws -> T {
        let phone = try Phone(executable: executable, rom: rom)
        defer { phone.tearDown() }
        return try body(phone)
    }

    // MARK: 1. port 1 reaches the core

    func testSNESPort1InputReachesTheCore() throws {
        let supafaust = try coreExecutable("supafaust")
        let rom = try fixture(["snes-input/input-test.sfc"])
        var script = InputScript(seed: 0x5EED_0001)
        let masks = script.masks(frames: scriptFrames)
        XCTAssertTrue(masks.contains { $0 != 0 }, "script must press something")

        let idle = try withPhone(supafaust, rom) { phone -> (PadWords, UInt64) in
            phone.idle(scriptFrames)
            let words = try phone.padWords()
            return (words, phone.checkpointHash())
        }
        let hostOnly = try withPhone(supafaust, rom) { phone -> (PadWords, UInt64) in
            for mask in masks { phone.step(mask, 0) }
            let words = try phone.padWords()
            return (words, phone.checkpointHash())
        }
        let guestOnly = try withPhone(supafaust, rom) { phone -> (PadWords, UInt64) in
            for mask in masks { phone.step(0, mask) }
            let words = try phone.padWords()
            return (words, phone.checkpointHash())
        }
        print("** [DET] snes idle      \(idle.0) wram=\(hex(idle.1))")
        print("** [DET] snes port0     \(hostOnly.0) wram=\(hex(hostOnly.1))")
        print("** [DET] snes port1     \(guestOnly.0) wram=\(hex(guestOnly.1))")

        // The ROM counts NMIs: one per emulated frame.
        XCTAssertGreaterThan(idle.0.frame, 500, "idle run: too few NMIs for \(scriptFrames) frames (\(idle.0))")
        XCTAssertLessThanOrEqual(idle.0.frame, UInt16(scriptFrames + 2), "idle run: too many NMIs (\(idle.0))")
        XCTAssertEqual(idle.0.hash1, 0, "idle run must see no pad-1 input (\(idle.0))")
        XCTAssertEqual(idle.0.hash2, 0, "idle run must see no pad-2 input (\(idle.0))")
        XCTAssertEqual(idle.0.held1 + idle.0.held2, 0, "idle run must see no held buttons (\(idle.0))")

        // Port 0 only: pad-1 words move, pad-2 words stay zero.
        XCTAssertNotEqual(hostOnly.0.hash1, 0, "port 0 script did not reach pad 1 (\(hostOnly.0))")
        XCTAssertGreaterThan(hostOnly.0.held1, 0, "port 0 script did not reach pad 1 (\(hostOnly.0))")
        XCTAssertEqual(hostOnly.0.hash2, 0, "port 0 input leaked into pad 2 (hash2 = WRAM $7E0008) (\(hostOnly.0))")
        XCTAssertEqual(hostOnly.0.held2, 0, "port 0 input leaked into pad 2 (held2) (\(hostOnly.0))")

        // Port 1 only: pad-2 words move (hash2 mirrors WRAM $7E0008), pad-1 words stay zero. This is the
        // proof that the bridge's second mask reaches the core as controller 2.
        XCTAssertNotEqual(guestOnly.0.hash2, 0, "port 1 script did not reach pad 2 (hash2 = WRAM $7E0008) (\(guestOnly.0))")
        XCTAssertGreaterThan(guestOnly.0.held2, 0, "port 1 script did not reach pad 2 (\(guestOnly.0))")
        XCTAssertEqual(guestOnly.0.hash1, 0, "port 1 input leaked into pad 1 (hash1 = WRAM $7E0006) (\(guestOnly.0))")
        XCTAssertEqual(guestOnly.0.held1, 0, "port 1 input leaked into pad 1 (held1) (\(guestOnly.0))")

        // Both pads are auto-read in the same VBlank, so the same script lands identically on either port.
        XCTAssertEqual(hostOnly.0.hash1, guestOnly.0.hash2,
                       "same script gives different pad hashes on port 0 vs port 1 (timing or mapping differs)")
        XCTAssertEqual(hostOnly.0.held1, guestOnly.0.held2, "same script gives different held counts on port 0 vs port 1")

        XCTAssertNotEqual(idle.1, hostOnly.1, "checksum ignores port 0 input")
        XCTAssertNotEqual(idle.1, guestOnly.1, "checksum ignores port 1 input")
        XCTAssertNotEqual(hostOnly.1, guestOnly.1, "checksum cannot tell port 0 from port 1")
    }

    // MARK: 2. replay from a state after teardown, different SRAM and different pre-roll

    func testSNESReplayFromStateIsDeterministicAcrossFreshLoad() throws {
        let supafaust = try coreExecutable("supafaust")
        let rom = try fixture(["snes-input/input-test.sfc"])
        let result = try replayAcrossPhones(core: supafaust, rom: rom, label: "snes", padWords: true)

        // SRAM path (README check 4): the host ran with 0x00 cartridge RAM, the guest's "file" was 0xFF.
        // After unserialize(S0) the guest's bytes 10.. must come from the state, not from its file.
        let afterLoad = result.guest.saveRAMAfterLoad
        XCTAssertGreaterThanOrEqual(afterLoad.count, 2048, "input-test.sfc declares 2 KiB SRAM, core exposes \(afterLoad.count)")
        if afterLoad.count > 10 {
            let fromFile = afterLoad[10...].filter { $0 == 0xFF }.count
            XCTAssertEqual(fromFile, 0,
                           "\(fromFile) of \(afterLoad.count - 10) SRAM bytes still hold the guest's 0xFF file after unserialize(S0): the state does not carry cartridge RAM, a guest with a different .srm would diverge in SRAM-reading games")
        }
        let hostHead = hexBytes(result.host.saveRAMAtEnd.prefix(10))
        let guestHead = hexBytes(result.guest.saveRAMAtEnd.prefix(10))
        print("** [DET] snes SRAM[0..<10] at end: host \(hostHead) guest \(guestHead)")
        XCTAssertEqual(fnv1a(result.host.saveRAMAtEnd), fnv1a(result.guest.saveRAMAtEnd),
                       "cartridge RAM differs after the same 600 frames (host \(hostHead) guest \(guestHead))")
    }

    private func hexBytes<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
        bytes.map { String(format: "%02X", UInt32($0)) }.joined()
    }

    // MARK: 3. the same on clownmdemu (inputs may be ignored by pong; only replay equality is asserted)

    func testMegaDriveReplayFromStateIsDeterministicAcrossFreshLoad() throws {
        let clownmdemu = try coreExecutable("clownmdemu")
        let rom = try fixture(["md/pong.md", "segaMD/pong.md"])
        let result = try replayAcrossPhones(core: clownmdemu, rom: rom, label: "md", padWords: false)
        XCTAssertFalse(result.host.source.isEmpty)
    }

    // MARK: shared replay

    private func replayAcrossPhones(core executable: URL, rom: URL, label: String, padWords: Bool) throws
        -> (host: Replay, guest: Replay) {
        var scriptA = InputScript(seed: 0xA11C_E001), scriptB = InputScript(seed: 0xB0B0_0002)
        let port0 = scriptA.masks(frames: scriptFrames), port1 = scriptB.masks(frames: scriptFrames)
        let checkpoints = scriptFrames / checkpointEvery
        // Pad words are diagnostics for the divergence report; failing to read them must not abort the replay.
        var wordsError: String?
        func record(_ phone: Phone) -> PadWords? {
            guard padWords else { return nil }
            do { return try phone.padWords() } catch {
                if wordsError == nil { wordsError = "\(error)" }
                return nil
            }
        }

        // Host: clean SRAM, 120 idle frames, S0, then the scripted 600 frames.
        var state = Data()
        let host = try withPhone(executable, rom) { phone -> Replay in
            var replay = Replay()
            replay.source = phone.checkpointSource
            let filled = phone.fillSaveRAM(0x00)
            print("** [DET] \(label) host: hashing \(replay.source), SRAM \(filled) bytes, serializeSize \(phone.core.serializeSize())")
            phone.idle(preRoll)
            state = try XCTUnwrap(phone.core.serialize(), "\(label): serialize() failed after \(preRoll) frames")
            replay.checkpoints.append(phone.checkpointHash())
            replay.words.append(record(phone))
            for c in 0..<checkpoints {
                phone.play(port0, port1, from: c * checkpointEvery, count: checkpointEvery)
                replay.checkpoints.append(phone.checkpointHash())
                replay.words.append(record(phone))
            }
            replay.saveRAMAtEnd = phone.saveRAMBytes()
            return replay
        }
        XCTAssertFalse(state.isEmpty)

        // Guest: fresh process-wide load, 0xFF SRAM "file", 37 frames of unrelated input, then S0 and the
        // same script. Models a guest with a different history and a different .srm.
        let guest = try withPhone(executable, rom) { phone -> Replay in
            var replay = Replay()
            replay.source = phone.checkpointSource
            let filled = phone.fillSaveRAM(0xFF)
            var pre = InputScript(seed: 0xD1FF_0003)
            let pre0 = pre.masks(frames: guestPreRoll), pre1 = pre.masks(frames: guestPreRoll)
            phone.play(pre0, pre1, from: 0, count: guestPreRoll)
            let before = phone.checkpointHash()
            XCTAssertTrue(phone.core.unserialize(state), "\(label): unserialize(S0) failed on the fresh load (\(state.count) bytes)")
            replay.saveRAMAfterLoad = phone.saveRAMBytes()
            replay.checkpoints.append(phone.checkpointHash())
            replay.words.append(record(phone))
            print("** [DET] \(label) guest: SRAM \(filled) bytes of 0xFF, pre-roll hash \(hex(before)) -> after unserialize \(hex(replay.checkpoints[0]))")
            for c in 0..<checkpoints {
                phone.play(port0, port1, from: c * checkpointEvery, count: checkpointEvery)
                replay.checkpoints.append(phone.checkpointHash())
                replay.words.append(record(phone))
            }
            replay.saveRAMAtEnd = phone.saveRAMBytes()
            return replay
        }

        XCTAssertEqual(host.checkpoints.count, checkpoints + 1)
        XCTAssertEqual(guest.checkpoints.count, checkpoints + 1)
        var firstDivergence: Int?
        for index in 0..<min(host.checkpoints.count, guest.checkpoints.count) {
            let frame = index * checkpointEvery
            let same = host.checkpoints[index] == guest.checkpoints[index]
            var line = "** [DET] \(label) frame \(frame): host \(hex(host.checkpoints[index])) guest \(hex(guest.checkpoints[index])) "
            line += same ? "ok" : "DIVERGED"
            if let h = host.words[index] { line += " host{\(h)}" }
            if let g = guest.words[index] { line += " guest{\(g)}" }
            print(line)
            if !same && firstDivergence == nil { firstDivergence = index }
        }
        if let index = firstDivergence {
            let frame = index * checkpointEvery
            var detail = "\(label): replay diverged first at frame \(frame) after S0 (checkpoint \(index) of \(checkpoints), hashing \(host.source)): host \(hex(host.checkpoints[index])) guest \(hex(guest.checkpoints[index]))"
            if let h = host.words[index], let g = guest.words[index] { detail += "; host{\(h)} guest{\(g)}" }
            if index == 0 { detail += "; the state itself does not restore the hashed memory identically" }
            XCTFail(detail)
        }
        if let wordsError { XCTFail("\(label): pad words unavailable: \(wordsError)") }
        if padWords, let h = host.words.last ?? nil, let g = guest.words.last ?? nil {
            XCTAssertEqual(h.hash1, g.hash1, "pad-1 history hash differs after replay")
            XCTAssertEqual(h.hash2, g.hash2, "pad-2 history hash differs after replay")
            XCTAssertNotEqual(h.hash2, 0, "port 1 script was not applied during replay (\(h))")
        }
        return (host, guest)
    }
}
