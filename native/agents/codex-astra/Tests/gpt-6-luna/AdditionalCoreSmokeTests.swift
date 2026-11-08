import Foundation
import XCTest
import LibretroHost

/// Each test owns and releases the process-wide LibretroCore session before returning.
final class AdditionalCoreSmokeTests: XCTestCase {
    func testNestopiaNES() throws {
        try exercise(coreName: "nestopia", fixtureDirectories: ["nes"], extensions: ["nes"])
    }

    func testClownMDEmuMegaDrive() throws {
        try exercise(coreName: "clownmdemu", fixtureDirectories: ["md", "segaMD"], extensions: ["md", "bin", "gen"])
    }

    func testGearsystemSMS() throws {
        try exercise(coreName: "gearsystem", fixtureDirectories: ["sms", "segaMS"], extensions: ["sms"])
    }

    func testGearsystemGameGear() throws {
        try exercise(coreName: "gearsystem", fixtureDirectories: ["gg", "segaGG"], extensions: ["gg"])
    }

    private func exercise(coreName: String, fixtureDirectories: [String], extensions: Set<String>) throws {
        guard let coresPath = ProcessInfo.processInfo.environment["NB_CORES_DIR"],
              let fixturesPath = ProcessInfo.processInfo.environment["NB_FIXTURES_DIR"] else {
            throw XCTSkip("no core/fixture")
        }

        let executable = URL(fileURLWithPath: coresPath, isDirectory: true)
            .appendingPathComponent("\(coreName).framework", isDirectory: true)
            .appendingPathComponent(coreName)
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: executable.path) else {
            throw XCTSkip("no core/fixture")
        }

        let fixtureRoot = URL(fileURLWithPath: fixturesPath, isDirectory: true)
        var candidates: [URL] = []
        for directory in fixtureDirectories {
            let folder = fixtureRoot.appendingPathComponent(directory, isDirectory: true)
            let files = (try? fileManager.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            candidates.append(contentsOf: files)
        }
        guard let rom = candidates.sorted(by: { $0.path < $1.path }).first(where: {
            extensions.contains($0.pathExtension.lowercased())
        }) else {
            throw XCTSkip("no core/fixture")
        }

        let core = try LibretroCore(executableURL: executable)
        defer { core.deinitCore() }
        try core.loadGame(path: rom.path)
        for _ in 0..<600 { core.run() }

        XCTAssertGreaterThanOrEqual(core.videoFrames, 590, "Too few video frames from \(coreName)")
        XCTAssertGreaterThan(core.audioFrames, 0, "No audio frames from \(coreName)")
        let frame = try XCTUnwrap(core.latestFrame(), "No video frame from \(coreName)")
        XCTAssertTrue(containsNonBlackPixel(frame), "Last frame is all black")

        let state = try XCTUnwrap(core.serialize(), "Core could not serialize state")
        for _ in 0..<60 { core.run() }
        let straight = try XCTUnwrap(core.latestFrame(), "No straight-run frame")
        XCTAssertTrue(core.unserialize(state), "Core could not restore state")
        for _ in 0..<60 { core.run() }
        let restored = try XCTUnwrap(core.latestFrame(), "No restored-run frame")
        XCTAssertEqual(hash(straight.data), hash(restored.data), "Save-state replay diverged")
    }

    private func containsNonBlackPixel(
        _ frame: (data: Data, width: Int, height: Int, pitch: Int, format: UInt32)
    ) -> Bool {
        // Libretro format 1 is XRGB8888; format 0 is 0RGB1555. Ignore the
        // unused high byte/bit, and skip row padding by using the reported pitch.
        let bytesPerPixel = frame.format == 1 ? 4 : 2
        let bytes = [UInt8](frame.data)
        for y in 0..<frame.height {
            let row = y * frame.pitch
            for x in 0..<frame.width {
                let offset = row + x * bytesPerPixel
                guard offset + bytesPerPixel <= bytes.count else { continue }
                if bytesPerPixel == 4 {
                    if bytes[offset] != 0 || bytes[offset + 1] != 0 || bytes[offset + 2] != 0 { return true }
                } else {
                    let highMask: UInt8 = frame.format == 0 ? 0x7f : 0xff
                    if bytes[offset] != 0 || (bytes[offset + 1] & highMask) != 0 { return true }
                }
            }
        }
        return false
    }

    private func hash(_ data: Data) -> UInt64 {
        data.reduce(UInt64(0xcbf29ce484222325)) { ($0 ^ UInt64($1)) &* 0x100000001b3 }
    }
}
