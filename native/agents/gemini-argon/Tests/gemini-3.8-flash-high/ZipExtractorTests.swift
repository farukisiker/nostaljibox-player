// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import Foundation
import NativeZip

/// Unit test suite for `ZipExtractor` and related types in `NativeZip`.
/// Covers Stored, Deflate, Data Descriptors, Filtering, Preferred ROM Selection,
/// Error handling (corruption, encryption, unsupported methods, size limits), and metadata inspection.
final class ZipExtractorTests: XCTestCase {

    // MARK: - Fixtures (Base64 Deflate & Data Descriptors)

    /// Deflate-compressed archive containing "Megaman.nes" (624 bytes uncompressed).
    private static let base64DeflateNes =
        "UEsDBBQAAAAIADkNaV21j6C6MQAAAHACAAALAAAATWVnYW1hbi5uZXPzcw3WDXCM9PF3dNF18w/SdXF183EMcdUNcQ0O0TU0MjYxNTO3sDTwG1U2qsyFCsoAUEsBAhQAFAAAAAgAOQ1pXbWPoLoxAAAAcAIAAAsAAAAAAAAAAAAAAIABAAAAAE1lZ2FtYW4ubmVzUEsFBgAAAAABAAEAOQAAAFoAAAAAAA=="

    /// Deflate-compressed archive containing "Chrono.sfc" (760 bytes uncompressed).
    private static let base64DeflateSfc =
        "UEsDBBQAAAAIADkNaV3oKQLIMQAAAPgCAAAKAAAAQ2hyb25vLnNmYwv2cw3WdfYI8vfz1w0J8nR3dw3SdXH19dcNcIz08Xd00XWKDHENDh5VNarKfzipAgBQSwECFAAUAAAACAA5DWld6CkCyDEAAAD4AgAACgAAAAAAAAAAAAAAgAEAAAAAQ2hyb25vLnNmY1BLBQYAAAAAAQABADgAAABZAAAAAAA="

    /// Deflate-compressed archive with Data Descriptor (bit 3 set, local sizes zeroed) containing "DescriptorGame.nes" (460 bytes).
    private static let base64DeflateDataDescriptor =
        "UEsDBBQACAAIAAAAAAAAAAAAAAAAAAAAAAASAAAARGVzY3JpcHRvckdhbWUubmVz7cqxDYBADAPAiTxEeBsJCRKUuGH/RViDgquP4QA1q4/b1aD2MywiNei6sCqtNLbHGv67v7tfUEsHCCtVlZo2AAAAzAEAAFBLAQIUABQACAAIAAAAAAArVZWaNgAAAMwBAAASAAAAAAAAAAAAAAAAAAAAAABEZXNjcmlwdG9yR2FtZS5uZXNQSwUGAAAAAAEAAQBAAAAAdgAAAAAA"

    /// Stored archive with Data Descriptor (bit 3 set, local sizes zeroed) containing "StoredDesc.sfc" (42 bytes).
    private static let base64StoredDataDescriptor =
        "UEsDBBQACAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAU3RvcmVkRGVzYy5zZmNTVE9SRUQtREFUQS1ERVNDUklQVE9SLVJPTS1CWVRFUy0xMjM0NTY3ODlQSwcIBwapUioAAAAqAAAAUEsBAhQAFAAIAAAAAAAAAAcGqVIqAAAAKgAAAA4AAAAAAAAAAAAAAAAAAAAAAFN0b3JlZERlc2Muc2ZjUEsFBgAAAAABAAEAPAAAAGYAAAAAAA=="

    // MARK: - Test Cases

    /// 1. Stored (Method 0) extraction: valid stored `.sfc` entry.
    /// Verifies `entries(of:)` metadata and `extractRom` returns exact `(name, data)` and passes CRC-32.
    func testStoredExtraction() throws {
        let romPayload = Data("SNES-SUPER-MARIO-WORLD-PAYLOAD-BYTES-123456789".utf8)
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "SuperMarioWorld.sfc", data: romPayload, method: 0)
        ]).build()

        let entries = try ZipExtractor.entries(of: zipData)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].name, "SuperMarioWorld.sfc")
        XCTAssertEqual(entries[0].compressedSize, romPayload.count)
        XCTAssertEqual(entries[0].uncompressedSize, romPayload.count)
        XCTAssertEqual(entries[0].method, 0)

        let extracted = try ZipExtractor.extractRom(from: zipData)
        XCTAssertEqual(extracted.name, "SuperMarioWorld.sfc")
        XCTAssertEqual(extracted.data, romPayload)
    }

    /// 2. Deflate (Method 8) extraction: valid deflate-compressed `.nes` and `.sfc` entries.
    /// Verifies `extractRom` decompresses and matches original uncompressed bytes.
    func testDeflateExtraction() throws {
        // Test NES Deflate
        guard let nesZipData = Data(base64Encoded: Self.base64DeflateNes) else {
            XCTFail("Failed to decode base64 NES Deflate fixture")
            return
        }
        let expectedNesPayload = Data(String(repeating: "NES-PAYLOAD-FOR-DEFLATE-TEST-1234567890", count: 16).utf8)

        let nesEntries = try ZipExtractor.entries(of: nesZipData)
        XCTAssertEqual(nesEntries.count, 1)
        XCTAssertEqual(nesEntries[0].name, "Megaman.nes")
        XCTAssertEqual(nesEntries[0].uncompressedSize, expectedNesPayload.count)
        XCTAssertEqual(nesEntries[0].method, 8)
        XCTAssertTrue(nesEntries[0].compressedSize < nesEntries[0].uncompressedSize)

        let extractedNes = try ZipExtractor.extractRom(from: nesZipData)
        XCTAssertEqual(extractedNes.name, "Megaman.nes")
        XCTAssertEqual(extractedNes.data, expectedNesPayload)

        // Test SFC Deflate
        guard let sfcZipData = Data(base64Encoded: Self.base64DeflateSfc) else {
            XCTFail("Failed to decode base64 SFC Deflate fixture")
            return
        }
        let expectedSfcPayload = Data(String(repeating: "SNES-CHRONO-TRIGGER-DEMO-PAYLOAD-BYTES", count: 20).utf8)

        let extractedSfc = try ZipExtractor.extractRom(from: sfcZipData)
        XCTAssertEqual(extractedSfc.name, "Chrono.sfc")
        XCTAssertEqual(extractedSfc.data, expectedSfcPayload)
    }

    /// 3. Data Descriptor (bit 3 flag `0x0008`):
    /// Local file header has `flags = 0x0008` and `crc32 = 0, compressedSize = 0, uncompressedSize = 0`,
    /// followed by compressed data and data descriptor, while Central Directory has the real sizes and CRC-32.
    /// Verifies `entries(of:)` and `extractRom` succeed for both Deflate and Stored formats.
    func testDataDescriptorExtraction() throws {
        // Deflate with Data Descriptor
        guard let deflateDescZip = Data(base64Encoded: Self.base64DeflateDataDescriptor) else {
            XCTFail("Failed to decode base64 Deflate Data Descriptor fixture")
            return
        }
        let expectedDeflatePayload = Data(String(repeating: "DATA-DESCRIPTOR-DEFLATED-NES-ROM-CONTENT-BYTES", count: 10).utf8)

        let deflateEntries = try ZipExtractor.entries(of: deflateDescZip)
        XCTAssertEqual(deflateEntries.count, 1)
        XCTAssertEqual(deflateEntries[0].name, "DescriptorGame.nes")
        XCTAssertEqual(deflateEntries[0].uncompressedSize, expectedDeflatePayload.count)
        XCTAssertEqual(deflateEntries[0].method, 8)

        let extractedDeflate = try ZipExtractor.extractRom(from: deflateDescZip)
        XCTAssertEqual(extractedDeflate.name, "DescriptorGame.nes")
        XCTAssertEqual(extractedDeflate.data, expectedDeflatePayload)

        // Stored with Data Descriptor
        guard let storedDescZip = Data(base64Encoded: Self.base64StoredDataDescriptor) else {
            XCTFail("Failed to decode base64 Stored Data Descriptor fixture")
            return
        }
        let expectedStoredPayload = Data("STORED-DATA-DESCRIPTOR-ROM-BYTES-123456789".utf8)

        let storedEntries = try ZipExtractor.entries(of: storedDescZip)
        XCTAssertEqual(storedEntries.count, 1)
        XCTAssertEqual(storedEntries[0].name, "StoredDesc.sfc")
        XCTAssertEqual(storedEntries[0].uncompressedSize, expectedStoredPayload.count)

        let extractedStored = try ZipExtractor.extractRom(from: storedDescZip)
        XCTAssertEqual(extractedStored.name, "StoredDesc.sfc")
        XCTAssertEqual(extractedStored.data, expectedStoredPayload)
    }

    /// 4. Nested folders & sanitised basename:
    /// Entry named `"subdir/nested/SuperGame.SFC"` returns `name == "SuperGame.SFC"`.
    func testNestedFoldersAndSanitisedBasename() throws {
        let payload = Data("NESTED-SUPER-GAME-ROM".utf8)
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "subdir/nested/SuperGame.SFC", data: payload)
        ]).build()

        let extracted = try ZipExtractor.extractRom(from: zipData)
        XCTAssertEqual(extracted.name, "SuperGame.SFC")
        XCTAssertEqual(extracted.data, payload)

        // Also test Windows-style backslash separation
        let zipDataBackslash = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "deep\\nested\\path\\GameBoyAdvance.sfc", data: payload)
        ]).build()

        let extractedBackslash = try ZipExtractor.extractRom(from: zipDataBackslash)
        XCTAssertEqual(extractedBackslash.name, "GameBoyAdvance.sfc")
        XCTAssertEqual(extractedBackslash.data, payload)
    }

    /// 5. Filtering `__MACOSX/` and dotfiles:
    /// Archive containing `"__MACOSX/._game.sfc"`, `".DS_Store"`, `"folder/"`, and `"roms/actual.md"`.
    /// `entries(of:)` returns only `"roms/actual.md"` and `extractRom` extracts `"actual.md"`.
    func testFilteringMacOSXAndDotfiles() throws {
        let actualMdPayload = Data("SEGA-GENESIS-ACTUAL-ROM-PAYLOAD".utf8)
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "__MACOSX/._game.sfc", data: Data("resource-fork".utf8)),
            ZipArchiveBuilder.Entry(name: ".DS_Store", data: Data("ds-store-binary".utf8)),
            ZipArchiveBuilder.Entry(name: "folder/", data: Data()),
            ZipArchiveBuilder.Entry(name: "roms/actual.md", data: actualMdPayload)
        ]).build()

        let entries = try ZipExtractor.entries(of: zipData)
        XCTAssertEqual(entries.count, 1)
        XCTAssertEqual(entries[0].name, "roms/actual.md")
        XCTAssertEqual(entries[0].uncompressedSize, actualMdPayload.count)

        let extracted = try ZipExtractor.extractRom(from: zipData)
        XCTAssertEqual(extracted.name, "actual.md")
        XCTAssertEqual(extracted.data, actualMdPayload)
    }

    /// 6. `preferredName` matching & fallback:
    /// Archive with two ROMs (`"a.sfc"` and `"b.sfc"`).
    /// Passing `preferredName: "B.SFC"` (case-insensitive) extracts `"b.sfc"`;
    /// passing `preferredName: "nonexistent.sfc"` falls back to first matching extension `"a.sfc"`;
    /// passing `preferredName: nil` extracts `"a.sfc"`.
    func testPreferredNameMatchingAndFallback() throws {
        let payloadA = Data("ROM-A-PAYLOAD".utf8)
        let payloadB = Data("ROM-B-PAYLOAD".utf8)
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "a.sfc", data: payloadA),
            ZipArchiveBuilder.Entry(name: "b.sfc", data: payloadB)
        ]).build()

        // Match "B.SFC" case-insensitively
        let matchB = try ZipExtractor.extractRom(from: zipData, preferredName: "B.SFC")
        XCTAssertEqual(matchB.name, "b.sfc")
        XCTAssertEqual(matchB.data, payloadB)

        // Non-existent preferred name falls back to first matching ROM extension ("a.sfc")
        let fallback = try ZipExtractor.extractRom(from: zipData, preferredName: "nonexistent.sfc")
        XCTAssertEqual(fallback.name, "a.sfc")
        XCTAssertEqual(fallback.data, payloadA)

        // Preferred name == nil selects the first matching ROM extension ("a.sfc")
        let defaultChoice = try ZipExtractor.extractRom(from: zipData, preferredName: nil)
        XCTAssertEqual(defaultChoice.name, "a.sfc")
        XCTAssertEqual(defaultChoice.data, payloadA)

        // Match "a.sfc" explicitly
        let matchA = try ZipExtractor.extractRom(from: zipData, preferredName: "A.SFC")
        XCTAssertEqual(matchA.name, "a.sfc")
        XCTAssertEqual(matchA.data, payloadA)
    }

    /// 7. No ROM entry (`ZipError.noRomEntry`):
    /// Archive containing only `"readme.txt"` and `"manual.pdf"` throws `ZipError.noRomEntry`.
    func testNoRomEntryThrows() throws {
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "readme.txt", data: Data("Hello manual".utf8)),
            ZipArchiveBuilder.Entry(name: "manual.pdf", data: Data("%PDF-fake".utf8))
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipData)) { error in
            XCTAssertEqual(error as? ZipError, .noRomEntry)
        }

        // Also throws when archive has ROMs, but none match custom romExtensions set
        let sfcArchive = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.sfc", data: Data("payload".utf8))
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: sfcArchive, romExtensions: ["nes", "fds"])) { error in
            XCTAssertEqual(error as? ZipError, .noRomEntry)
        }
    }

    /// 8. Bad CRC-32 (`ZipError.corrupt`):
    /// Corrupting a byte of the payload or changing the expected CRC-32 causes `extractRom` to throw `ZipError.corrupt(...)`.
    func testBadCRC32ThrowsCorrupt() throws {
        let payload = Data("SNES-AUTHENTIC-CRC32-ROM-PAYLOAD".utf8)

        // Case A: Corrupted payload byte
        var zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.sfc", data: payload)
        ]).build()

        // Mutate one byte in the middle of the payload
        let corruptOffset = 30 + "game.sfc".count + 5
        zipData[corruptOffset] ^= 0xFF

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipData)) { error in
            guard case .corrupt = (error as? ZipError) else {
                XCTFail("Expected ZipError.corrupt, got \(error)")
                return
            }
        }

        // Case B: Header expected CRC-32 altered to an invalid value
        let badCrcArchive = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.sfc", data: payload, overrideCrc32: 0xDEADBEEF)
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: badCrcArchive)) { error in
            guard case .corrupt = (error as? ZipError) else {
                XCTFail("Expected ZipError.corrupt, got \(error)")
                return
            }
        }
    }

    /// 9. Not a ZIP (`ZipError.notAZip`):
    /// Random/non-zip bytes throw `ZipError.notAZip`.
    func testNotAZipThrows() {
        let randomBytes = Data([0x01, 0x02, 0x03, 0x04, 0x55, 0xAA, 0xFF, 0x00])
        let emptyBytes = Data()
        let textBytes = Data("This is definitely not a ZIP archive.".utf8)

        XCTAssertThrowsError(try ZipExtractor.entries(of: randomBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }
        XCTAssertThrowsError(try ZipExtractor.extractRom(from: randomBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }

        XCTAssertThrowsError(try ZipExtractor.entries(of: emptyBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }
        XCTAssertThrowsError(try ZipExtractor.extractRom(from: emptyBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }

        XCTAssertThrowsError(try ZipExtractor.entries(of: textBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }
        XCTAssertThrowsError(try ZipExtractor.extractRom(from: textBytes)) { error in
            XCTAssertEqual(error as? ZipError, .notAZip)
        }
    }

    /// 10. Unsupported method (`ZipError.unsupportedMethod`):
    /// Entry with method 12 (bzip2) or 14 (LZMA) throws `ZipError.unsupportedMethod(...)`.
    func testUnsupportedMethodThrows() {
        let zipDataBzip2 = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.sfc", data: Data("bzip2-data".utf8), method: 12)
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipDataBzip2)) { error in
            XCTAssertEqual(error as? ZipError, .unsupportedMethod(12))
        }

        let zipDataLzma = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.nes", data: Data("lzma-data".utf8), method: 14)
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipDataLzma)) { error in
            XCTAssertEqual(error as? ZipError, .unsupportedMethod(14))
        }
    }

    /// 11. Encrypted entry (`ZipError.encrypted`):
    /// Entry with bit 0 of flags (`0x0001`) set throws `ZipError.encrypted`.
    func testEncryptedEntryThrows() {
        let zipDataEncrypted = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "secret.sfc", data: Data("secret-rom".utf8), flags: 0x0001)
        ]).build()

        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipDataEncrypted)) { error in
            XCTAssertEqual(error as? ZipError, .encrypted)
        }
    }

    /// 12. Too large (`ZipError.tooLarge`):
    /// Calling `extractRom(..., maxSize: 100)` on an entry with `uncompressedSize == 256` throws `ZipError.tooLarge`.
    func testTooLargeThrows() throws {
        let largePayload = Data(repeating: 0x7A, count: 256)
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "largeGame.sfc", data: largePayload)
        ]).build()

        // Exceeds maxSize: 100 -> throws .tooLarge
        XCTAssertThrowsError(try ZipExtractor.extractRom(from: zipData, maxSize: 100)) { error in
            XCTAssertEqual(error as? ZipError, .tooLarge)
        }

        // Within maxSize: 300 -> succeeds
        let extracted = try ZipExtractor.extractRom(from: zipData, maxSize: 300)
        XCTAssertEqual(extracted.name, "largeGame.sfc")
        XCTAssertEqual(extracted.data.count, 256)
    }

    // MARK: - Supplementary Edge Cases

    /// Verifies standard default ROM extensions set contains all expected formats.
    func testDefaultRomExtensions() {
        let defaults = ZipExtractor.defaultRomExtensions
        let expected: Set<String> = [
            "sfc", "smc", "fig", "swc",
            "nes", "fds", "unf",
            "md", "smd", "gen", "bin",
            "sms", "gg", "sg"
        ]
        XCTAssertTrue(expected.isSubset(of: defaults))
    }

    /// Truncated ZIP archive: local header exists, but EOCD signature is missing.
    /// Calling `entries(of:)` or `extractRom(from:)` throws `ZipError.corrupt(...)`.
    func testTruncatedZipThrowsCorrupt() {
        let zipData = ZipArchiveBuilder(entries: [
            ZipArchiveBuilder.Entry(name: "game.sfc", data: Data("payload".utf8))
        ]).build()

        // Cut off before the End of Central Directory
        let truncated = zipData.prefix(35)
        XCTAssertThrowsError(try ZipExtractor.entries(of: Data(truncated))) { error in
            guard case .corrupt = (error as? ZipError) else {
                XCTFail("Expected ZipError.corrupt for truncated ZIP, got \(error)")
                return
            }
        }
    }

    /// Zip64 or multi-disk archives throw `ZipError.corrupt(...)`.
    func testZip64OrMultiDiskThrowsCorrupt() {
        let multiDiskZip = ZipArchiveBuilder(
            entries: [ZipArchiveBuilder.Entry(name: "game.sfc", data: Data("payload".utf8))],
            overrideDiskNumber: 1
        ).build()

        XCTAssertThrowsError(try ZipExtractor.entries(of: multiDiskZip)) { error in
            guard case .corrupt = (error as? ZipError) else {
                XCTFail("Expected ZipError.corrupt for multi-disk ZIP, got \(error)")
                return
            }
        }
    }
}

// MARK: - Programmatic ZIP Builder Helper for In-Memory Archives

private struct ZipArchiveBuilder {
    struct Entry {
        var name: String
        var data: Data
        var compressedData: Data? = nil
        var method: UInt16 = 0
        var flags: UInt16 = 0
        var overrideCrc32: UInt32? = nil
        var overrideCompressedSize: UInt32? = nil
        var overrideUncompressedSize: UInt32? = nil
        var localSizesZero: Bool = false
        var includeDataDescriptor: Bool = false
        var overrideLocalOffset: UInt32? = nil

        init(
            name: String,
            data: Data = Data(),
            compressedData: Data? = nil,
            method: UInt16 = 0,
            flags: UInt16 = 0,
            overrideCrc32: UInt32? = nil,
            overrideCompressedSize: UInt32? = nil,
            overrideUncompressedSize: UInt32? = nil,
            localSizesZero: Bool = false,
            includeDataDescriptor: Bool = false,
            overrideLocalOffset: UInt32? = nil
        ) {
            self.name = name
            self.data = data
            self.compressedData = compressedData
            self.method = method
            self.flags = flags
            self.overrideCrc32 = overrideCrc32
            self.overrideCompressedSize = overrideCompressedSize
            self.overrideUncompressedSize = overrideUncompressedSize
            self.localSizesZero = localSizesZero
            self.includeDataDescriptor = includeDataDescriptor
            self.overrideLocalOffset = overrideLocalOffset
        }
    }

    var entries: [Entry] = []
    var overrideDiskNumber: UInt16? = nil
    var overrideTotalEntries: UInt16? = nil
    var overrideCdOffset: UInt32? = nil

    /// Computes standard IEEE 802.3 32-bit Cyclic Redundancy Check.
    static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 {
                if (crc & 1) != 0 {
                    crc = (crc >> 1) ^ 0xEDB8_8320
                } else {
                    crc >>= 1
                }
            }
        }
        return ~crc
    }

    /// Builds a valid or intentionally modified binary ZIP archive in memory.
    func build() -> Data {
        var archive = Data()

        struct BuiltEntry {
            let nameBytes: Data
            let flags: UInt16
            let method: UInt16
            let crc32: UInt32
            let compressedSize: UInt32
            let uncompressedSize: UInt32
            let localOffset: UInt32
        }

        var builtEntries: [BuiltEntry] = []

        for entry in entries {
            let localOffset = entry.overrideLocalOffset ?? UInt32(archive.count)
            let nameBytes = Data(entry.name.utf8)
            let payload = entry.compressedData ?? entry.data
            let crc = entry.overrideCrc32 ?? ZipArchiveBuilder.crc32(entry.data)
            let cSize = entry.overrideCompressedSize ?? UInt32(payload.count)
            let uSize = entry.overrideUncompressedSize ?? UInt32(entry.data.count)

            // Local File Header (30 bytes + name + extra)
            var localHeader = Data()
            localHeader.appendUInt32LE(0x04034b50) // signature PK\x03\x04
            localHeader.appendUInt16LE(20)         // version needed to extract
            localHeader.appendUInt16LE(entry.flags)
            localHeader.appendUInt16LE(entry.method)
            localHeader.appendUInt16LE(0)          // last mod time
            localHeader.appendUInt16LE(0)          // last mod date
            localHeader.appendUInt32LE(entry.localSizesZero ? 0 : crc)
            localHeader.appendUInt32LE(entry.localSizesZero ? 0 : cSize)
            localHeader.appendUInt32LE(entry.localSizesZero ? 0 : uSize)
            localHeader.appendUInt16LE(UInt16(nameBytes.count))
            localHeader.appendUInt16LE(0)          // extra field length

            archive.append(localHeader)
            archive.append(nameBytes)
            archive.append(payload)

            if entry.includeDataDescriptor {
                var desc = Data()
                desc.appendUInt32LE(0x08074b50)    // signature PK\x07\x08
                desc.appendUInt32LE(crc)
                desc.appendUInt32LE(cSize)
                desc.appendUInt32LE(uSize)
                archive.append(desc)
            }

            builtEntries.append(BuiltEntry(
                nameBytes: nameBytes,
                flags: entry.flags,
                method: entry.method,
                crc32: crc,
                compressedSize: cSize,
                uncompressedSize: uSize,
                localOffset: localOffset
            ))
        }

        // Central Directory
        let cdOffset = overrideCdOffset ?? UInt32(archive.count)
        var centralDirectory = Data()

        for b in builtEntries {
            var cdh = Data()
            cdh.appendUInt32LE(0x02014b50)         // signature PK\x01\x02
            cdh.appendUInt16LE(20)                 // version made by
            cdh.appendUInt16LE(20)                 // version needed
            cdh.appendUInt16LE(b.flags)
            cdh.appendUInt16LE(b.method)
            cdh.appendUInt16LE(0)                  // last mod time
            cdh.appendUInt16LE(0)                  // last mod date
            cdh.appendUInt32LE(b.crc32)
            cdh.appendUInt32LE(b.compressedSize)
            cdh.appendUInt32LE(b.uncompressedSize)
            cdh.appendUInt16LE(UInt16(b.nameBytes.count))
            cdh.appendUInt16LE(0)                  // extra field length
            cdh.appendUInt16LE(0)                  // file comment length
            cdh.appendUInt16LE(0)                  // disk number start
            cdh.appendUInt16LE(0)                  // internal file attributes
            cdh.appendUInt32LE(0)                  // external file attributes
            cdh.appendUInt32LE(b.localOffset)      // relative offset of local header
            cdh.append(b.nameBytes)

            centralDirectory.append(cdh)
        }

        archive.append(centralDirectory)

        // End of Central Directory Record (EOCD)
        let cdSize = UInt32(centralDirectory.count)
        let totalCount = overrideTotalEntries ?? UInt16(builtEntries.count)
        let diskNum = overrideDiskNumber ?? 0

        var eocd = Data()
        eocd.appendUInt32LE(0x06054b50)             // signature PK\x05\x06
        eocd.appendUInt16LE(diskNum)                // disk number
        eocd.appendUInt16LE(0)                      // disk where central directory starts
        eocd.appendUInt16LE(totalCount)             // central directory records on this disk
        eocd.appendUInt16LE(totalCount)             // total central directory records
        eocd.appendUInt32LE(cdSize)                 // size of central directory
        eocd.appendUInt32LE(cdOffset)               // offset of central directory
        eocd.appendUInt16LE(0)                      // comment length

        archive.append(eocd)
        return archive
    }
}

// MARK: - Little-Endian Binary Serialization Helpers

private extension Data {
    mutating func appendUInt16LE(_ value: UInt16) {
        var le = value.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        var le = value.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }
}
