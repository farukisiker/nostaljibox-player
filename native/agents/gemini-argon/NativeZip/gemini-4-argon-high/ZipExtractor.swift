import Compression
import Foundation

public struct ZipEntry: Equatable, Sendable {
    public let name: String
    public let compressedSize: Int
    public let uncompressedSize: Int
    public let method: UInt16

    public init(name: String, compressedSize: Int, uncompressedSize: Int, method: UInt16) {
        self.name = name
        self.compressedSize = compressedSize
        self.uncompressedSize = uncompressedSize
        self.method = method
    }
}

public enum ZipError: Error, Equatable, Sendable {
    case notAZip
    case unsupportedMethod(UInt16)
    case encrypted
    case corrupt(String)
    case noRomEntry
    case tooLarge
}

public enum ZipExtractor {
    public static let defaultRomExtensions: Set<String> = [
        "sfc", "smc", "fig", "swc",
        "nes", "fds", "unf",
        "md", "smd", "gen", "bin",
        "sms", "gg", "sg"
    ]

    /// Central-directory listing (handles data descriptors, ignores directories and __MACOSX/ and dotfiles).
    public static func entries(of data: Data) throws -> [ZipEntry] {
        let parsed = try parseCentralDirectory(of: data)
        return parsed.map {
            ZipEntry(
                name: $0.name,
                compressedSize: $0.compressedSize,
                uncompressedSize: $0.uncompressedSize,
                method: $0.method
            )
        }
    }

    /// Extracts one ROM: the entry whose last path component equals `preferredName` (case-insensitive),
    /// else the first entry whose extension is in `romExtensions`, else throws noRomEntry.
    /// Returns the entry's last path component (sanitised) and its bytes. Methods 0 (stored) and 8 (deflate).
    /// CRC-32 is verified. Rejects entries over `maxSize` (default 64 MB) with tooLarge.
    public static func extractRom(
        from data: Data,
        preferredName: String? = nil,
        romExtensions: Set<String> = defaultRomExtensions,
        maxSize: Int = 64 << 20
    ) throws -> (name: String, data: Data) {
        let internalEntries = try parseCentralDirectory(of: data)

        let normalizedExtensions = Set(
            romExtensions
                .map { $0.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
                .filter { !$0.isEmpty }
        )

        var chosen: InternalZipEntry?

        if let preferred = preferredName?.trimmingCharacters(in: .whitespacesAndNewlines), !preferred.isEmpty {
            let preferredNormalized = preferred.replacingOccurrences(of: "\\", with: "/")
            let preferredLast = preferredNormalized.split(separator: "/").last.map(String.init) ?? preferredNormalized

            chosen = internalEntries.first { entry in
                let entryLast = entry.name.split(separator: "/").last.map(String.init) ?? entry.name
                return entryLast.caseInsensitiveCompare(preferredLast) == .orderedSame
                    || entry.name.caseInsensitiveCompare(preferredNormalized) == .orderedSame
            }
        }

        if chosen == nil {
            chosen = internalEntries.first { entry in
                let entryLast = entry.name.split(separator: "/").last.map(String.init) ?? entry.name
                guard let dotIndex = entryLast.lastIndex(of: "."), dotIndex > entryLast.startIndex else {
                    return false
                }
                let ext = entryLast[entryLast.index(after: dotIndex)...].lowercased()
                return normalizedExtensions.contains(ext)
            }
        }

        guard let target = chosen else {
            throw ZipError.noRomEntry
        }

        if (target.flags & 0x0001) != 0 {
            throw ZipError.encrypted
        }

        guard target.method == 0 || target.method == 8 else {
            throw ZipError.unsupportedMethod(target.method)
        }

        guard maxSize >= 0, target.uncompressedSize >= 0, target.uncompressedSize <= maxSize else {
            throw ZipError.tooLarge
        }

        let payload = try extractEntryData(target, from: data)

        let computedCrc = crc32(of: payload)
        guard computedCrc == target.crc32 else {
            throw ZipError.corrupt("CRC-32 mismatch")
        }

        let rawLastComponent = target.name
            .replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/")
            .last
            .map(String.init) ?? ""
        let sanitizedName = String(rawLastComponent.drop(while: { $0 == "." }))
        guard !sanitizedName.isEmpty else {
            throw ZipError.corrupt("Invalid entry filename")
        }

        return (name: sanitizedName, data: payload)
    }

    // MARK: - Internal Structures & Signatures

    private static let localFileHeaderSignature: UInt32 = 0x0403_4b50
    private static let dataDescriptorSignature: UInt32 = 0x0807_4b50
    private static let centralDirectorySignature: UInt32 = 0x0201_4b50
    private static let eocdSignature: UInt32 = 0x0605_4b50

    private static let minEocdSize = 22
    private static let maxCommentSize = 65_535

    private struct InternalZipEntry {
        let name: String
        let flags: UInt16
        let method: UInt16
        let crc32: UInt32
        let compressedSize: Int
        let uncompressedSize: Int
        let localHeaderOffset: Int
    }

    // MARK: - Central Directory Parsing

    private static func parseCentralDirectory(of data: Data) throws -> [InternalZipEntry] {
        guard data.count >= 4 else {
            throw ZipError.notAZip
        }

        let firstSig = data.readUInt32LE(at: 0)
        let hasZipMagic = firstSig == localFileHeaderSignature
            || firstSig == eocdSignature
            || firstSig == dataDescriptorSignature
            || firstSig == centralDirectorySignature

        guard let eocdOffset = findEocdOffset(in: data, allowCommentMismatch: hasZipMagic) else {
            if hasZipMagic {
                throw ZipError.corrupt("Truncated ZIP archive")
            }
            throw ZipError.notAZip
        }

        let diskNumber = data.readUInt16LE(at: eocdOffset + 4)
        let centralDirDisk = data.readUInt16LE(at: eocdOffset + 6)
        let diskEntries = data.readUInt16LE(at: eocdOffset + 8)
        let totalEntries = data.readUInt16LE(at: eocdOffset + 10)
        let centralDirSize32 = data.readUInt32LE(at: eocdOffset + 12)
        let centralDirOffset32 = data.readUInt32LE(at: eocdOffset + 16)

        if diskNumber != 0
            || centralDirDisk != 0
            || diskEntries != totalEntries
            || totalEntries == 0xFFFF
            || centralDirSize32 == 0xFFFF_FFFF
            || centralDirOffset32 == 0xFFFF_FFFF
        {
            throw ZipError.corrupt("Zip64 or multi-disk archives are not supported")
        }

        let centralDirSize = Int(centralDirSize32)
        let centralDirOffset = Int(centralDirOffset32)

        guard centralDirOffset >= 0,
              centralDirSize >= 0,
              centralDirOffset + centralDirSize <= eocdOffset,
              centralDirOffset + centralDirSize <= data.count
        else {
            throw ZipError.corrupt("Central directory out of bounds")
        }

        var entries: [InternalZipEntry] = []
        entries.reserveCapacity(Int(totalEntries))

        var cursor = centralDirOffset
        for _ in 0..<Int(totalEntries) {
            guard cursor + 46 <= data.count, cursor + 46 <= eocdOffset else {
                throw ZipError.corrupt("Truncated central directory header")
            }

            let signature = data.readUInt32LE(at: cursor)
            guard signature == centralDirectorySignature else {
                throw ZipError.corrupt("Invalid central directory header")
            }

            let flags = data.readUInt16LE(at: cursor + 8)
            let method = data.readUInt16LE(at: cursor + 10)
            let entryCrc32 = data.readUInt32LE(at: cursor + 16)
            let compSize32 = data.readUInt32LE(at: cursor + 20)
            let uncompSize32 = data.readUInt32LE(at: cursor + 24)
            let nameLen = Int(data.readUInt16LE(at: cursor + 28))
            let extraLen = Int(data.readUInt16LE(at: cursor + 30))
            let commentLen = Int(data.readUInt16LE(at: cursor + 32))
            let diskNumStart = data.readUInt16LE(at: cursor + 34)
            let localHeaderOffset32 = data.readUInt32LE(at: cursor + 42)

            if compSize32 == 0xFFFF_FFFF
                || uncompSize32 == 0xFFFF_FFFF
                || localHeaderOffset32 == 0xFFFF_FFFF
                || diskNumStart == 0xFFFF
            {
                throw ZipError.corrupt("Zip64 entry not supported")
            }

            let nextCursor = cursor + 46 + nameLen + extraLen + commentLen
            guard nextCursor <= data.count, nextCursor <= eocdOffset else {
                throw ZipError.corrupt("Central directory entry out of bounds")
            }

            let nameData = data.subdata(at: cursor + 46, length: nameLen)
            let rawName = String(data: nameData, encoding: .utf8)
                ?? String(data: nameData, encoding: .isoLatin1)
                ?? ""
            let normalizedName = rawName.replacingOccurrences(of: "\\", with: "/")

            cursor = nextCursor

            if shouldIgnoreEntry(named: normalizedName) {
                continue
            }

            if (flags & 0x0001) != 0 {
                throw ZipError.encrypted
            }

            entries.append(
                InternalZipEntry(
                    name: normalizedName,
                    flags: flags,
                    method: method,
                    crc32: entryCrc32,
                    compressedSize: Int(compSize32),
                    uncompressedSize: Int(uncompSize32),
                    localHeaderOffset: Int(localHeaderOffset32)
                )
            )
        }

        return entries
    }

    private static func findEocdOffset(in data: Data, allowCommentMismatch: Bool) -> Int? {
        guard data.count >= minEocdSize else {
            return nil
        }

        let maxStart = data.count - minEocdSize
        let minStart = max(0, data.count - minEocdSize - maxCommentSize)

        var fallbackMatch: Int?
        var pos = maxStart
        while pos >= minStart {
            if data.readUInt32LE(at: pos) == eocdSignature {
                let commentLength = Int(data.readUInt16LE(at: pos + 20))
                if pos + minEocdSize + commentLength == data.count {
                    return pos
                }
                if allowCommentMismatch && fallbackMatch == nil {
                    fallbackMatch = pos
                }
            }
            pos -= 1
        }

        return fallbackMatch
    }

    private static func shouldIgnoreEntry(named normalizedName: String) -> Bool {
        if normalizedName.isEmpty || normalizedName.hasSuffix("/") {
            return true
        }

        let components = normalizedName.split(separator: "/", omittingEmptySubsequences: true)
        if components.isEmpty {
            return true
        }

        for component in components {
            if component == "__MACOSX" || component.hasPrefix(".") {
                return true
            }
        }

        return false
    }

    // MARK: - Entry Extraction & Decompression

    private static func extractEntryData(_ entry: InternalZipEntry, from data: Data) throws -> Data {
        let lfhOffset = entry.localHeaderOffset
        guard lfhOffset >= 0, lfhOffset + 30 <= data.count else {
            throw ZipError.corrupt("Local file header out of bounds")
        }

        let signature = data.readUInt32LE(at: lfhOffset)
        guard signature == localFileHeaderSignature else {
            throw ZipError.corrupt("Invalid local file header signature")
        }

        let localFlags = data.readUInt16LE(at: lfhOffset + 6)
        if (localFlags & 0x0001) != 0 {
            throw ZipError.encrypted
        }

        let localNameLen = Int(data.readUInt16LE(at: lfhOffset + 26))
        let localExtraLen = Int(data.readUInt16LE(at: lfhOffset + 28))
        let dataOffset = lfhOffset + 30 + localNameLen + localExtraLen

        guard dataOffset >= 0,
              entry.compressedSize >= 0,
              dataOffset + entry.compressedSize <= data.count
        else {
            throw ZipError.corrupt("Entry data out of bounds")
        }

        switch entry.method {
        case 0:
            guard entry.compressedSize == entry.uncompressedSize else {
                throw ZipError.corrupt("Stored entry size mismatch")
            }
            return data.subdata(at: dataOffset, length: entry.compressedSize)

        case 8:
            if entry.uncompressedSize == 0 {
                return Data()
            }

            guard entry.compressedSize > 0 else {
                throw ZipError.corrupt("Empty deflate stream for non-empty entry")
            }

            let compressedSlice = data.subdata(at: dataOffset, length: entry.compressedSize)
            let dstCapacity = entry.uncompressedSize + 1
            var destination = Data(count: dstCapacity)

            let decodedCount = destination.withUnsafeMutableBytes { dstBuffer -> Int in
                compressedSlice.withUnsafeBytes { srcBuffer -> Int in
                    guard let dstPtr = dstBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self),
                          let srcPtr = srcBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self)
                    else {
                        return 0
                    }
                    return compression_decode_buffer(
                        dstPtr,
                        dstCapacity,
                        srcPtr,
                        entry.compressedSize,
                        nil,
                        COMPRESSION_ZLIB
                    )
                }
            }

            guard decodedCount == entry.uncompressedSize else {
                throw ZipError.corrupt("Deflate decompression failed")
            }

            destination.removeSubrange(entry.uncompressedSize..<dstCapacity)
            return destination

        default:
            throw ZipError.unsupportedMethod(entry.method)
        }
    }

    // MARK: - IEEE 802.3 CRC-32

    private static let crc32Table: [UInt32] = (0..<256).map { index -> UInt32 in
        var crc = UInt32(index)
        for _ in 0..<8 {
            if (crc & 1) != 0 {
                crc = 0xEDB8_8320 ^ (crc >> 1)
            } else {
                crc >>= 1
            }
        }
        return crc
    }

    private static func crc32(of data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { rawBuffer in
            guard let base = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return
            }
            let table = crc32Table
            for i in 0..<rawBuffer.count {
                let tableIndex = Int((crc ^ UInt32(base[i])) & 0xFF)
                crc = (crc >> 8) ^ table[tableIndex]
            }
        }
        return crc ^ 0xFFFF_FFFF
    }
}

private extension Data {
    func readUInt16LE(at offset: Int) -> UInt16 {
        let base = startIndex + offset
        return UInt16(self[base]) | (UInt16(self[base + 1]) << 8)
    }

    func readUInt32LE(at offset: Int) -> UInt32 {
        let base = startIndex + offset
        return UInt32(self[base])
            | (UInt32(self[base + 1]) << 8)
            | (UInt32(self[base + 2]) << 16)
            | (UInt32(self[base + 3]) << 24)
    }

    func subdata(at offset: Int, length: Int) -> Data {
        let start = startIndex + offset
        return Data(self[start..<(start + length)])
    }
}
