import XCTest
import LibretroHost

final class CoreSmokeTests: XCTestCase {
    func testRingBufferWrapOverflowAndUnderrun() throws {
        let ring = try XCTUnwrap(AudioRingBuffer(capacityFrames: 3))
        XCTAssertEqual(ring.write([1, -1, 2, -2]), 2)
        XCTAssertEqual(ring.read(frames: 1).samples, [1, -1])
        // A full ring keeps the newest frames and drops the oldest (frame 2 here).
        XCTAssertEqual(ring.write([3, -3, 4, -4, 5, -5]), 3)
        XCTAssertEqual(ring.fill, 3)
        XCTAssertEqual(ring.overflows, 1)
        let result = ring.read(frames: 4)
        XCTAssertEqual(result.frames, 3)
        XCTAssertEqual(result.samples, [3, -3, 4, -4, 5, -5, 0, 0])
        XCTAssertEqual(ring.underruns, 1)
        XCTAssertEqual(ring.fill, 0)
        XCTAssertEqual(ring.write([7, -7]), 1)
        ring.clear()
        XCTAssertEqual(ring.fill, 0)
        XCTAssertEqual(ring.read(frames: 1).samples, [0, 0])
        XCTAssertEqual(ring.underruns, 2)
    }

    func testInputMixerCombinesSources() {
        final class Source: InputSource {
            let buttons: UInt16
            init(_ buttons: UInt16) { self.buttons = buttons }
            func snapshot(port: Int) -> InputSnapshot { InputSnapshot(buttons: port == 0 ? buttons : 0) }
        }
        let mixer = InputMixer([Source(1), Source(0x110)])
        XCTAssertEqual(mixer.snapshot(port: 0).buttons, 0x111)
        XCTAssertEqual(mixer.snapshot(port: 1).buttons, 0)
        XCTAssertEqual(InputMixer([]).snapshot(port: 0).buttons, 0)
    }

    func testSupafaustRuns600Frames() throws {
        guard let directory = ProcessInfo.processInfo.environment["NB_CORES_DIR"],
              let fixtureDirectory = ProcessInfo.processInfo.environment["NB_FIXTURES_DIR"] else {
            throw XCTSkip("no core/fixture")
        }
        let fixtures = URL(fileURLWithPath: fixtureDirectory, isDirectory: true)
        let executable = URL(fileURLWithPath: directory).appendingPathComponent("supafaust.framework/supafaust")
        let roms = (try? FileManager.default.contentsOfDirectory(
            at: fixtures.appendingPathComponent("snes"), includingPropertiesForKeys: nil)) ?? []
        guard FileManager.default.fileExists(atPath: executable.path),
              let rom = roms.sorted(by: { $0.path < $1.path }).first(where: { $0.pathExtension.lowercased() == "sfc" }) else {
            throw XCTSkip("no core/fixture")
        }
        let core = try LibretroCore(executableURL: executable)
        defer { core.deinitCore() }
        try core.loadGame(path: rom.path)
        for _ in 0..<600 { core.run() }
        XCTAssertGreaterThanOrEqual(core.videoFrames, 590)
        XCTAssertGreaterThan(core.audioFrames, 0)
        let frame = try XCTUnwrap(core.latestFrame())
        // Ignore the unused high byte/bit in XRGB8888/0RGB1555 when checking black.
        let pixels = [UInt8](frame.data)
        let bpp = frame.format == 1 ? 4 : 2
        let nonBlack = stride(from: 0, to: pixels.count, by: bpp).contains { index in
            if bpp == 4 { return pixels[index] != 0 || pixels[index + 1] != 0 || pixels[index + 2] != 0 }
            let highMask: UInt8 = frame.format == 0 ? 0x7f : 0xff
            return pixels[index] != 0 || (pixels[index + 1] & highMask) != 0
        }
        XCTAssertTrue(nonBlack, "Last frame is all black")
        let state = try XCTUnwrap(core.serialize())
        for _ in 0..<60 { core.run() }
        let straight = try XCTUnwrap(core.latestFrame())
        XCTAssertTrue(core.unserialize(state))
        for _ in 0..<60 { core.run() }
        let restored = try XCTUnwrap(core.latestFrame())
        // No expected failure until a particular released core demonstrates nondeterminism.
        XCTAssertEqual(hash(straight.data), hash(restored.data), "Save-state replay diverged")
    }

    private func hash(_ data: Data) -> UInt64 {
        data.reduce(UInt64(0xcbf29ce484222325)) { ($0 ^ UInt64($1)) &* 0x100000001b3 }
    }
}
