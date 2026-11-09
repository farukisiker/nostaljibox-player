import XCTest
@testable import LibretroHost

final class StateHeaderTests: XCTestCase {
    private let payload = Data([0, 0xff, 10, 13, 0, 0x80])
    private func envelope(core: String = "supafaust", version: String = "642d1d1",
                          rom: String = "0123456789abcdef", frame: UInt64 = 123) throws -> Data {
        try StateHeader(core: core, coreVersion: version, romHash: rom,
                        size: payload.count, frame: frame).encode(payload: payload)
    }
    private func decode(_ data: Data, strict: Bool = true, warn: (String) -> Void = { _ in }) throws -> StateHeader.Decoded {
        try StateHeader.decode(data, core: "supafaust", coreVersion: "642d1d1",
                               romHash: "0123456789abcdef", strictVersion: strict, warn: warn)
    }
    private func assertMismatch(_ data: Data, file: StaticString = #filePath, line: UInt = #line) {
        for strict in [false, true] {
            XCTAssertThrowsError(try decode(data, strict: strict), file: file, line: line) { error in
                XCTAssertEqual((error as? SessionError)?.code, "state-mismatch", file: file, line: line)
            }
        }
    }
    func testEnvelopeRoundTripPreservesEveryPayloadByteAndFrame() throws {
        let data = try envelope()
        XCTAssertTrue(data.starts(with: Data("NBST1\n".utf8)))
        for strict in [false, true] {
            let decoded = try decode(data, strict: strict)
            XCTAssertEqual(decoded.payload, payload)
            XCTAssertEqual(decoded.header?.frame, 123)
            XCTAssertEqual(decoded.header?.core, "supafaust")
            XCTAssertEqual(decoded.header?.size, payload.count)
        }
        // Data slices may have nonzero startIndex; parsing must not assume integer index zero.
        var prefixed = Data([1, 2, 3]); prefixed.append(data)
        XCTAssertEqual(try decode(prefixed.dropFirst(3)).payload, payload)
    }
    func testLegacyRawAcceptedInBothFileAndBase64Modes() throws {
        for strict in [false, true] {
            let decoded = try decode(payload, strict: strict)
            XCTAssertNil(decoded.header)
            XCTAssertEqual(decoded.payload, payload)
        }
    }
    func testCoreAndROMIdentityMismatchRejectBeforePayloadUse() throws {
        assertMismatch(try envelope(core: "nestopia"))
        assertMismatch(try envelope(rom: "fedcba9876543210"))
    }
    func testFileVersionDifferenceWarnsButBase64Rejects() throws {
        let data = try envelope(version: "oldcore")
        var warnings: [String] = []
        XCTAssertEqual(try decode(data, strict: false, warn: { warnings.append($0) }).payload, payload)
        XCTAssertEqual(warnings.count, 1)
        XCTAssertTrue(warnings[0].contains("oldcore"))
        XCTAssertThrowsError(try decode(data)) { error in
            XCTAssertEqual((error as? SessionError)?.code, "state-mismatch")
        }
        var unexpectedWarning = false
        _ = try decode(try envelope(), strict: false, warn: { _ in unexpectedWarning = true })
        XCTAssertFalse(unexpectedWarning)
    }
    func testPayloadTruncationTrailingBytesAndWrongDeclaredSizeReject() throws {
        let valid = try envelope()
        assertMismatch(Data(valid.dropLast()))
        var extra = valid; extra.append(1); assertMismatch(extra)
        // Header only is ASCII; preserve the binary payload while changing the size metadata.
        let headerEnd = try XCTUnwrap(valid.dropFirst(StateHeader.magic.count).firstIndex(of: 10))
        let header = String(decoding: valid[..<headerEnd], as: UTF8.self)
        for badSize in ["0", "-1", "999999999999999999999999999999999999"] {
            var modified = Data(header.replacingOccurrences(of: "\"size\":6", with: "\"size\":" + badSize).utf8)
            modified.append(10); modified.append(payload)
            assertMismatch(modified)
        }
    }
    func testMalformedUnknownOversizedAndTruncatedHeadersReject() throws {
        assertMismatch(Data())
        for text in ["NBST", "NBST1", "NBST2\n{}\n", "NBST1\n", "NBST1\n{\nxyz", "NBST1\n{}\nxyz"] {
            assertMismatch(Data(text.utf8))
        }
        var oversized = StateHeader.magic
        oversized.append(Data(repeating: 0x20, count: StateHeader.maximumJSONBytes + 1))
        oversized.append(10); oversized.append(payload)
        assertMismatch(oversized)
        let valid = try envelope()
        let payloadStart = try XCTUnwrap(valid.dropFirst(StateHeader.magic.count).firstIndex(of: 10)) + 1
        for length in StateHeader.magic.count..<payloadStart {
            assertMismatch(Data(valid.prefix(length)))
        }
    }
    func testInvalidFrameAndRequiredFieldsReject() throws {
        let cases = [
            "{\"core\":\"supafaust\",\"coreVersion\":\"642d1d1\",\"romHash\":\"0123456789abcdef\",\"size\":6,\"frame\":-1}",
            "{\"core\":\"supafaust\",\"coreVersion\":\"642d1d1\",\"romHash\":\"0123456789abcdef\",\"size\":6,\"frame\":18446744073709551615}",
            "{\"core\":\"supafaust\",\"romHash\":\"0123456789abcdef\",\"size\":6,\"frame\":1}"
        ]
        for json in cases {
            var data = StateHeader.magic; data.append(Data(json.utf8)); data.append(10); data.append(payload)
            assertMismatch(data)
        }
    }
    func testWriterRejectsInconsistentSizeAndExcessiveHeader() throws {
        XCTAssertThrowsError(try StateHeader(core: "supafaust", coreVersion: "v", romHash: "hash", size: 5, frame: 0).encode(payload: payload))
        XCTAssertThrowsError(try envelope(core: String(repeating: "x", count: StateHeader.maximumJSONBytes)))
        XCTAssertThrowsError(try envelope(frame: UInt64.max))
    }
}
