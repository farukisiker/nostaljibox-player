// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation
import XCTest
import LibretroC
import LibretroHost

final class ClownMDEmuDiagnosticTests: XCTestCase {
    func testClownMDEmuDiagnostics() throws {
        // 1. Read NB_CORES_DIR and NB_FIXTURES_DIR from environment
        guard let coresPath = ProcessInfo.processInfo.environment["NB_CORES_DIR"],
              let fixturesPath = ProcessInfo.processInfo.environment["NB_FIXTURES_DIR"] else {
            throw XCTSkip("** [CLOWN-DIAG] Skipping: NB_CORES_DIR or NB_FIXTURES_DIR not set")
        }

        let executable = URL(fileURLWithPath: coresPath, isDirectory: true)
            .appendingPathComponent("clownmdemu.framework", isDirectory: true)
            .appendingPathComponent("clownmdemu")
        guard FileManager.default.fileExists(atPath: executable.path) else {
            throw XCTSkip("** [CLOWN-DIAG] Skipping: clownmdemu executable missing at \(executable.path)")
        }

        let fixtureRoot = URL(fileURLWithPath: fixturesPath, isDirectory: true)
        var rom = fixtureRoot.appendingPathComponent("md", isDirectory: true).appendingPathComponent("pong.md")
        if !FileManager.default.fileExists(atPath: rom.path) {
            rom = fixtureRoot.appendingPathComponent("segaMD", isDirectory: true).appendingPathComponent("pong.md")
        }
        guard FileManager.default.fileExists(atPath: rom.path) else {
            throw XCTSkip("** [CLOWN-DIAG] Skipping: pong.md not found at \(rom.path)")
        }

        // 2. Install C logger callback
        nb_bridge_set_log_fn { level, message in
            if let message {
                let text = String(cString: message).trimmingCharacters(in: .whitespacesAndNewlines)
                print("** [CLOWN-DIAG][CORE-LOG level=\(level)] \(text)")
            }
        }
        defer { nb_bridge_set_log_fn(nil) }

        // Memory inspection helper
        func inspectMemory(id: UInt32) -> (size: Int, nonZero: Int) {
            let size = nb_bridge_memory_size(id)
            guard size > 0, let ptr = nb_bridge_memory_data(id) else {
                return (size, 0)
            }
            let buffer = UnsafeBufferPointer(start: ptr.assumingMemoryBound(to: UInt8.self), count: size)
            var count = 0
            for byte in buffer {
                if byte != 0 { count += 1 }
            }
            return (size, count)
        }

        // Frame inspection helper
        func inspectFrame(_ frame: (data: Data, width: Int, height: Int, pitch: Int, format: UInt32)) -> (nonBlack: Int, distinct16: Int, hex16: String) {
            let bytesPerPixel = (frame.format == 1) ? 4 : 2
            var nonBlack = 0
            var distinct16 = Set<UInt16>()

            frame.data.withUnsafeBytes { buffer in
                guard let base = buffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
                for y in 0..<frame.height {
                    let row = y * frame.pitch
                    for x in 0..<frame.width {
                        let offset = row + x * bytesPerPixel
                        guard offset + bytesPerPixel <= buffer.count else { continue }
                        let isNonBlack: Bool
                        if bytesPerPixel == 4 {
                            isNonBlack = (base[offset] != 0 || base[offset + 1] != 0 || base[offset + 2] != 0)
                        } else {
                            let highMask: UInt8 = (frame.format == 0) ? 0x7f : 0xff
                            isNonBlack = (base[offset] != 0 || (base[offset + 1] & highMask) != 0)
                        }
                        if isNonBlack { nonBlack += 1 }
                        if offset + 2 <= buffer.count {
                            let u16 = UInt16(base[offset]) | (UInt16(base[offset + 1]) << 8)
                            distinct16.insert(u16)
                        }
                    }
                }
            }
            let hex16 = frame.data.prefix(16).map { String(format: "%02X", $0) }.joined(separator: " ")
            return (nonBlack, distinct16.count, hex16)
        }

        // 3. Part 1 — Run fixtures/md/pong.md for 1200 frames
        print("** [CLOWN-DIAG] Initializing LibretroCore with \(executable.path)")
        let core = try LibretroCore(executableURL: executable)
        defer { core.deinitCore() }

        let libName = core.systemInfo.library_name.map { String(cString: $0) } ?? "nil"
        let libVersion = core.systemInfo.library_version.map { String(cString: $0) } ?? "nil"
        let validExt = core.systemInfo.valid_extensions.map { String(cString: $0) } ?? "nil"
        let needFullpath = core.systemInfo.need_fullpath
        print("** [CLOWN-DIAG] systemInfo: library_name=\(libName), library_version=\(libVersion), valid_extensions=\(validExt), need_fullpath=\(needFullpath)")

        print("** [CLOWN-DIAG] Loading pong.md from \(rom.path)")
        try core.loadGame(path: rom.path)

        let av = core.avInfo
        print("** [CLOWN-DIAG] avInfo.geometry: base_width=\(av.geometry.base_width), base_height=\(av.geometry.base_height), max_width=\(av.geometry.max_width), max_height=\(av.geometry.max_height), aspect_ratio=\(av.geometry.aspect_ratio)")
        print("** [CLOWN-DIAG] avInfo.timing: fps=\(av.timing.fps), sample_rate=\(av.timing.sample_rate)")

        for key in ["clownmdemu_overseas_region", "clownmdemu_tv_standard", "clownmdemu_cd_addon"] {
            let val = nb_bridge_get_variable(key).map { String(cString: $0) } ?? "nil"
            print("** [CLOWN-DIAG] variable: \(key)=\(val)")
        }

        let sampledFrames: Set<Int> = [1, 10, 60, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]
        var buttons: UInt16 = 0
        var frame600NonBlack = 0
        defer { core.setInputPointer(nil) }

        print("** [CLOWN-DIAG] Starting 1200 frame loop for pong.md...")
        for frameIndex in 1...1200 {
            if (300..<320).contains(frameIndex) || (650..<670).contains(frameIndex) {
                buttons = UInt16(1 << RETRO_DEVICE_ID_JOYPAD_START)
            } else {
                buttons = 0
            }
            core.setInputPointer(&buttons)
            core.run()

            if sampledFrames.contains(frameIndex) {
                if let frame = core.latestFrame() {
                    let info = inspectFrame(frame)
                    if frameIndex == 600 { frame600NonBlack = info.nonBlack }
                    print("** [CLOWN-DIAG][FRAME \(frameIndex)] width=\(frame.width) height=\(frame.height) pitch=\(frame.pitch) format=\(frame.format) videoFrames=\(core.videoFrames) audioFrames=\(core.audioFrames) nonBlackPixels=\(info.nonBlack) distinct16=\(info.distinct16) hex16=[\(info.hex16)]")
                } else {
                    print("** [CLOWN-DIAG][FRAME \(frameIndex)] latestFrame() is nil! videoFrames=\(core.videoFrames) audioFrames=\(core.audioFrames)")
                }

                let sysRam = inspectMemory(id: UInt32(RETRO_MEMORY_SYSTEM_RAM))
                let vdpRam = inspectMemory(id: UInt32(RETRO_MEMORY_VIDEO_RAM))
                print("** [CLOWN-DIAG][MEM \(frameIndex)] 68k RAM (id=\(RETRO_MEMORY_SYSTEM_RAM)): size=\(sysRam.size) nonZero=\(sysRam.nonZero) | VDP VRAM (id=\(RETRO_MEMORY_VIDEO_RAM)): size=\(vdpRam.size) nonZero=\(vdpRam.nonZero)")
            }
        }

        XCTAssertGreaterThanOrEqual(core.videoFrames, 1200)
        XCTAssertGreaterThan(core.audioFrames, 0)
        XCTAssertGreaterThan(frame600NonBlack, 0, "pong.md should render non-black pixels by frame 600")

        // 4. Part 2 — Test loadGame passing ROM bytes in memory vs path, and test a tiny synthetic 68000 VDP ROM
        core.unloadGame()
        print("** [CLOWN-DIAG][SYNTH] Unloaded pong.md, building synthetic 1024-byte Mega Drive ROM...")

        var synthRom = Data(count: 1024)
        // Initial SSP at 0x00: 0x00FFFE00
        synthRom[0x00] = 0x00; synthRom[0x01] = 0xFF; synthRom[0x02] = 0xFE; synthRom[0x03] = 0x00
        // Initial PC at 0x04: 0x00000200
        synthRom[0x04] = 0x00; synthRom[0x05] = 0x00; synthRom[0x06] = 0x02; synthRom[0x07] = 0x00
        // "SEGA MEGA DRIVE " at 0x100
        if let segaHeader = "SEGA MEGA DRIVE ".data(using: .ascii) {
            synthRom.replaceSubrange(0x100..<(0x100 + segaHeader.count), with: segaHeader)
        }
        // ROM bounds (0x00000000..0x000003FF) at 0x1A0
        synthRom[0x1A0] = 0x00; synthRom[0x1A1] = 0x00; synthRom[0x1A2] = 0x00; synthRom[0x1A3] = 0x00
        synthRom[0x1A4] = 0x00; synthRom[0x1A5] = 0x00; synthRom[0x1A6] = 0x03; synthRom[0x1A7] = 0xFF
        // RAM bounds (0x00FF0000..0x00FFFFFF) at 0x1A8
        synthRom[0x1A8] = 0x00; synthRom[0x1A9] = 0xFF; synthRom[0x1AA] = 0x00; synthRom[0x1AB] = 0x00
        synthRom[0x1AC] = 0x00; synthRom[0x1AD] = 0xFF; synthRom[0x1AE] = 0xFF; synthRom[0x1AF] = 0xFF
        // Region at 0x1F0: "JUE"
        if let region = "JUE".data(using: .ascii) {
            synthRom.replaceSubrange(0x1F0..<(0x1F0 + region.count), with: region)
        }

        // 68000 code at 0x200:
        // - Writes 'SEGA' (0x53454741) to 0x00A14000 (TMSS)
        // - Writes VDP reg 0 = 0x8004, reg 1 = 0x8144 (Display Enable), reg 7 = 0x8700 (backdrop colour = CRAM 0) to 0x00C00004
        // - Writes CRAM write command 0xC0000000 to 0x00C00004, and writes 0x0EEE (white) to 0x00C00000 (VDP data port)
        // - Loops (bra.s *, 0x60FE)
        let synthCode: [UInt8] = [
            // move.l #0x53454741, ($00A14000).l
            0x23, 0xFC, 0x53, 0x45, 0x47, 0x41, 0x00, 0xA1, 0x40, 0x00,
            // move.w #0x8004, ($00C00004).l
            0x33, 0xFC, 0x80, 0x04, 0x00, 0xC0, 0x00, 0x04,
            // move.w #0x8144, ($00C00004).l
            0x33, 0xFC, 0x81, 0x44, 0x00, 0xC0, 0x00, 0x04,
            // move.w #0x8700, ($00C00004).l
            0x33, 0xFC, 0x87, 0x00, 0x00, 0xC0, 0x00, 0x04,
            // move.l #0xC0000000, ($00C00004).l
            0x23, 0xFC, 0xC0, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x04,
            // move.w #0x0EEE, ($00C00000).l
            0x33, 0xFC, 0x0E, 0xEE, 0x00, 0xC0, 0x00, 0x00,
            // bra.s *
            0x60, 0xFE
        ]
        synthRom.replaceSubrange(0x200..<(0x200 + synthCode.count), with: synthCode)

        let tempDir = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let synthRomURL = tempDir.appendingPathComponent("clownmdemu_synth_\(UUID().uuidString).md")
        try synthRom.write(to: synthRomURL)
        defer { try? FileManager.default.removeItem(at: synthRomURL) }

        print("** [CLOWN-DIAG][SYNTH] Loading synthetic ROM from \(synthRomURL.path) (need_fullpath=\(core.systemInfo.need_fullpath))")
        try core.loadGame(path: synthRomURL.path)

        for _ in 1...10 {
            core.run()
        }

        if let synthFrame = core.latestFrame() {
            let info = inspectFrame(synthFrame)
            print("** [CLOWN-DIAG][SYNTH] width=\(synthFrame.width) height=\(synthFrame.height) pitch=\(synthFrame.pitch) format=\(synthFrame.format) videoFrames=\(core.videoFrames) audioFrames=\(core.audioFrames) nonBlackPixels=\(info.nonBlack) distinct16=\(info.distinct16) hex16=[\(info.hex16)]")
        } else {
            print("** [CLOWN-DIAG][SYNTH] latestFrame() returned nil! videoFrames=\(core.videoFrames) audioFrames=\(core.audioFrames)")
        }

        print("** [CLOWN-DIAG] Diagnostics completed successfully.")
    }
}
