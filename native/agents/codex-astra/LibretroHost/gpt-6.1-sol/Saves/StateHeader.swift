import Foundation

/// Identity envelope for slot files and native netplay. Legacy raw states remain readable.
struct StateHeader: Codable, Equatable {
    let core: String
    let coreVersion: String
    let romHash: String
    let size: Int
    let frame: UInt64

    static let magic = Data("NBST1\n".utf8)
    static let maximumJSONBytes = 8192

    func encode(payload: Data) throws -> Data {
        guard !core.isEmpty, !romHash.isEmpty, size > 0, size == payload.count, frame <= UInt64(Int.max) else {
            throw Self.mismatch("Invalid state identity or payload size")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let json = try encoder.encode(self)
        guard json.count <= Self.maximumJSONBytes else { throw Self.mismatch("State header is too large") }
        var result = Self.magic
        result.append(json); result.append(0x0a); result.append(payload)
        return result
    }

    struct Decoded {
        let header: StateHeader?
        let payload: Data
    }
    /// strictVersion is true for the Base64/netplay path, false for local slot files.
    static func decode(_ data: Data, core: String, coreVersion: String, romHash: String,
                       strictVersion: Bool, warn: (String) -> Void = { _ in }) throws -> Decoded {
        guard !data.isEmpty else { throw mismatch("Empty state data") }
        guard data.starts(with: magic) else {
            // Reserve the format family, so corrupt/truncated or unknown NBST headers cannot
            // be passed to retro_unserialize as a legacy state.
            guard !data.starts(with: Data("NBST".utf8)) else { throw mismatch("Invalid state header magic") }
            return Decoded(header: nil, payload: data)
        }
        let jsonStart = magic.count
        let searchEnd = min(data.count, jsonStart + maximumJSONBytes + 1)
        let start = data.index(data.startIndex, offsetBy: jsonStart)
        let end = data.index(data.startIndex, offsetBy: searchEnd)
        guard let newline = data[start..<end].firstIndex(of: 0x0a) else {
            throw mismatch("Missing or oversized state header")
        }
        let json = Data(data[start..<newline])
        let header: StateHeader
        do { header = try JSONDecoder().decode(StateHeader.self, from: json) }
        catch { throw mismatch("Malformed state header") }
        let payloadStart = data.index(after: newline)
        let payloadSize = data.distance(from: payloadStart, to: data.endIndex)
        guard header.size > 0, header.size == payloadSize, header.frame <= UInt64(Int.max) else { throw mismatch("State payload size mismatch") }
        guard !header.core.isEmpty, !header.romHash.isEmpty,
              header.core == core, header.romHash == romHash else { throw mismatch("State belongs to another core or ROM") }
        if header.coreVersion != coreVersion {
            guard !strictVersion else { throw mismatch("State core version mismatch") }
            warn("Loading state from core version \(header.coreVersion) with \(coreVersion)")
        }
        return Decoded(header: header, payload: Data(data[payloadStart...]))
    }
    private static func mismatch(_ message: String) -> SessionError {
        SessionError(code: "state-mismatch", message: message)
    }
}
