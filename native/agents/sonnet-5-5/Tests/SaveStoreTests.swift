// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import NativeSaves
import LibretroHost

final class SaveStoreTests: XCTestCase {
    private var root: URL!
    private var store: SaveStore!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("nb-savestore-\(UUID().uuidString)", isDirectory: true)
        store = try SaveStore(rootURL: root)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: root)
    }

    private func excluded(_ url: URL) throws -> Bool? {
        try url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup
    }

    private func bytes(_ count: Int, _ value: UInt8 = 7) -> Data { Data(repeating: value, count: count) }

    // MARK: layout

    func testCreatesTheFourFolders() {
        var isDirectory: ObjCBool = false
        for name in ["roms", "saves", "states", "system"] {
            let exists = FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path, isDirectory: &isDirectory)
            XCTAssertTrue(exists && isDirectory.boolValue, name)
        }
        XCTAssertEqual(store.systemDirectory.lastPathComponent, "system")
        XCTAssertEqual(store.saveDirectory.lastPathComponent, "saves")
    }

    func testRomsAndStatesAreExcludedFromBackupButSavesAreNot() throws {
        XCTAssertEqual(try excluded(store.romsDirectory), true)
        XCTAssertEqual(try excluded(store.statesDirectory), true)
        XCTAssertNotEqual(try excluded(store.saveDirectory), true)
        // Reopening an existing root keeps the flags.
        let again = try SaveStore(rootURL: root)
        XCTAssertEqual(try excluded(again.romsDirectory), true)
    }

    func testTheDefaultRootIsApplicationSupportNostaljiBox() throws {
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let expected = support.appendingPathComponent("NostaljiBox", isDirectory: true)
        XCTAssertEqual(try SaveStore().rootURL.standardizedFileURL, expected.standardizedFileURL)
    }

    // MARK: ROMs

    func testStoreRomRoundTrip() throws {
        let data = bytes(1000)
        let url = try store.storeRom(gameId: "g1", romName: "Game.sfc", data: data, hash: "0123456789abcdef")
        XCTAssertEqual(url, store.romURL(gameId: "g1", romName: "Game.sfc"))
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, "g1")
        XCTAssertEqual(url.deletingLastPathComponent().deletingLastPathComponent().lastPathComponent, "roms")
        XCTAssertEqual(try Data(contentsOf: url), data)

        XCTAssertTrue(store.hasRom(gameId: "g1", size: 1000, hash: "0123456789abcdef"))
        XCTAssertFalse(store.hasRom(gameId: "g1", size: 1000, hash: "ffffffffffffffff"), "other bytes")
        XCTAssertFalse(store.hasRom(gameId: "g1", size: 999, hash: "0123456789abcdef"), "other size")
        XCTAssertFalse(store.hasRom(gameId: "g2", size: 1000, hash: "0123456789abcdef"), "other game")
    }

    func testHasRomMatchesTheSizeJSKnowsWhenTheRomWasExtracted() throws {
        // JS sends the raw zip's size and hash; the store holds the extracted 100-byte ROM.
        try store.storeRom(gameId: "z", romName: "inner.nes", data: bytes(100), hash: "aaaaaaaaaaaaaaaa", sourceSize: 250)
        XCTAssertTrue(store.hasRom(gameId: "z", size: 250, hash: "aaaaaaaaaaaaaaaa"))
        XCTAssertTrue(store.hasRom(gameId: "z", size: 100, hash: "aaaaaaaaaaaaaaaa"))
        XCTAssertFalse(store.hasRom(gameId: "z", size: 251, hash: "aaaaaaaaaaaaaaaa"))
    }

    func testHasRomIsFalseWhenTheFileIsGoneOrChanged() throws {
        let url = try store.storeRom(gameId: "g", romName: "a.nes", data: bytes(64), hash: "1111111111111111")
        try Data(count: 10).write(to: url)
        XCTAssertFalse(store.hasRom(gameId: "g", size: 64, hash: "1111111111111111"), "truncated file")
        try FileManager.default.removeItem(at: url)
        XCTAssertFalse(store.hasRom(gameId: "g", size: 64, hash: "1111111111111111"))
    }

    func testRomNameIsReducedToItsLastPathComponent() throws {
        let url = try store.storeRom(gameId: "g", romName: "../../evil/dir/Game.sfc", data: bytes(8), hash: "2222222222222222")
        XCTAssertEqual(url.lastPathComponent, "Game.sfc")
        XCTAssertEqual(url.deletingLastPathComponent().lastPathComponent, "g")
        XCTAssertTrue(url.standardizedFileURL.path.hasPrefix(store.romsDirectory.standardizedFileURL.path))
        XCTAssertEqual(store.romURL(gameId: "g", romName: "C:\\roms\\x\\Sonic.md").lastPathComponent, "Sonic.md")
        XCTAssertEqual(store.romURL(gameId: "g", romName: "..").lastPathComponent, "_")
        XCTAssertEqual(store.romURL(gameId: "g", romName: "").lastPathComponent, "_")
        // A hostile game id cannot leave roms/ either.
        let hostile = store.romURL(gameId: "../../outside", romName: "r.nes")
        XCTAssertTrue(hostile.standardizedFileURL.path.hasPrefix(store.romsDirectory.standardizedFileURL.path))
    }

    func testStoringAgainReplacesTheOldRom() throws {
        try store.storeRom(gameId: "g", romName: "old.nes", data: bytes(10), hash: "3333333333333333")
        try store.storeRom(gameId: "g", romName: "new.nes", data: bytes(20), hash: "4444444444444444")
        let names = try FileManager.default.contentsOfDirectory(atPath: store.romsDirectory.appendingPathComponent("g").path).sorted()
        XCTAssertEqual(names, [".meta.json", "new.nes"], "atomic writes leave no temp files and the old ROM is gone")
        XCTAssertFalse(store.hasRom(gameId: "g", size: 10, hash: "3333333333333333"))
        XCTAssertTrue(store.hasRom(gameId: "g", size: 20, hash: "4444444444444444"))
    }

    // MARK: SRAM

    func testSRAMRoundTrip() throws {
        XCTAssertNil(store.loadSRAM(romHash: "abcdabcdabcdabcd"))
        try store.saveSRAM(Data([1, 2, 3, 4]), romHash: "abcdabcdabcdabcd")
        XCTAssertEqual(store.loadSRAM(romHash: "abcdabcdabcdabcd"), Data([1, 2, 3, 4]))
        try store.saveSRAM(Data([9]), romHash: "abcdabcdabcdabcd")
        XCTAssertEqual(store.loadSRAM(romHash: "abcdabcdabcdabcd"), Data([9]))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.saveDirectory.appendingPathComponent("abcdabcdabcdabcd.srm").path))
        XCTAssertNil(store.loadSRAM(romHash: "0000000000000000"))
    }

    // MARK: States

    func testStateURLAndListing() throws {
        XCTAssertEqual(store.stateURL(gameId: "g1", slot: 2).lastPathComponent, "g1.2.state")
        XCTAssertEqual(store.stateURL(gameId: "g1", slot: 2).deletingLastPathComponent().lastPathComponent, "states")
        XCTAssertTrue(store.listStates(gameId: "g1").isEmpty)

        try bytes(10).write(to: store.stateURL(gameId: "g1", slot: 3))
        try bytes(10).write(to: store.stateURL(gameId: "g1", slot: 1))
        try bytes(10).write(to: store.stateURL(gameId: "other", slot: 2))
        let states = store.listStates(gameId: "g1")
        XCTAssertEqual(states.map { $0.slot }, [1, 3])
        for state in states { XCTAssertLessThan(abs(state.mtime.timeIntervalSinceNow), 60) }
    }

    func testAGameIdThatPrefixesAnotherDoesNotPickItsStates() throws {
        try bytes(1).write(to: store.stateURL(gameId: "g1", slot: 1))
        try bytes(1).write(to: store.stateURL(gameId: "g1.5", slot: 2))
        XCTAssertEqual(store.listStates(gameId: "g1").map { $0.slot }, [1])
        XCTAssertEqual(store.listStates(gameId: "g1.5").map { $0.slot }, [2])
        _ = try store.deleteGame(gameId: "g1")
        XCTAssertEqual(store.listStates(gameId: "g1.5").map { $0.slot }, [2])
    }

    // MARK: delete

    func testDeleteGameRemovesRomAndStatesButKeepsSRAMAndOtherGames() throws {
        try store.storeRom(gameId: "g1", romName: "Game.sfc", data: bytes(1000), hash: "5555555555555555")
        try bytes(10).write(to: store.stateURL(gameId: "g1", slot: 1))
        try bytes(20).write(to: store.stateURL(gameId: "g1", slot: 2))
        try store.saveSRAM(bytes(8), romHash: "5555555555555555")
        try store.storeRom(gameId: "g2", romName: "Other.nes", data: bytes(50), hash: "6666666666666666")
        try bytes(5).write(to: store.stateURL(gameId: "g2", slot: 1))

        let removed = try store.deleteGame(gameId: "g1")
        XCTAssertGreaterThanOrEqual(removed, 1030, "ROM 1000 + states 30 (+ the small meta file)")
        XCTAssertLessThan(removed, 1030 + 512)

        XCTAssertFalse(FileManager.default.fileExists(atPath: store.romsDirectory.appendingPathComponent("g1").path))
        XCTAssertTrue(store.listStates(gameId: "g1").isEmpty)
        XCTAssertFalse(store.hasRom(gameId: "g1", size: 1000, hash: "5555555555555555"))
        XCTAssertEqual(store.loadSRAM(romHash: "5555555555555555"), bytes(8), "battery saves outlive the game")
        XCTAssertTrue(store.hasRom(gameId: "g2", size: 50, hash: "6666666666666666"))
        XCTAssertEqual(store.listStates(gameId: "g2").map { $0.slot }, [1])
    }

    func testDeleteGameOfAnUnknownGameRemovesNothing() throws {
        XCTAssertEqual(try store.deleteGame(gameId: "nope"), 0)
    }
}
