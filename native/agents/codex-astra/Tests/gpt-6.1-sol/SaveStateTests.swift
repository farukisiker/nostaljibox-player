import XCTest
@testable import LibretroHost

final class SaveStateTests: XCTestCase {
    func testTerminationFlushWithoutSessionDoesNotWaitForMainCompletion() {
        let session = EmulatorSession()
        let finished = expectation(description: "termination flush returns on main")
        DispatchQueue.main.async {
            let before = ProcessInfo.processInfo.systemUptime
            XCTAssertFalse(session.flushSRAM())
            XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - before, 1.5)
            finished.fulfill()
        }
        wait(for: [finished], timeout: 4)
    }

    func testStateOperationsWithoutSessionCompleteOnMain() {
        let session = EmulatorSession()
        let done = expectation(description: "all state completions")
        done.expectedFulfillmentCount = 5
        func check<T>(_ result: Result<T, Error>) {
            XCTAssertTrue(Thread.isMainThread)
            switch result {
            case .success: XCTFail("State operation succeeded without a game")
            case .failure(let error): XCTAssertEqual((error as? SessionError)?.code, "no-session")
            }
            done.fulfill()
        }
        session.saveState(slot: 1, completion: check)
        session.loadState(slot: 1, completion: check)
        session.listStates(completion: check)
        session.serializeState(completion: check)
        session.unserializeState(Data([1]), completion: check)
        wait(for: [done], timeout: 5)
    }

    func testSupafaustStateFileRoundTripReplaysVideo() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let directory = environment["NB_CORES_DIR"], let fixtures = environment["NB_FIXTURES_DIR"] else {
            throw XCTSkip("no core/fixture")
        }
        let executable = URL(fileURLWithPath: directory).appendingPathComponent("supafaust.framework/supafaust")
        let roms = (try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: fixtures).appendingPathComponent("snes"), includingPropertiesForKeys: nil)) ?? []
        guard FileManager.default.fileExists(atPath: executable.path),
              let rom = roms.sorted(by: { $0.path < $1.path }).first(where: { $0.pathExtension.lowercased() == "sfc" }) else {
            throw XCTSkip("no core/fixture")
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = try FallbackSaveStore(rootURL: root)
        defer { try? FileManager.default.removeItem(at: root) }
        let core = try LibretroCore(executableURL: executable)
        defer { core.deinitCore() }
        try core.loadGame(path: rom.path)
        for _ in 0..<120 { core.run() }
        let state = try XCTUnwrap(core.serialize())
        let url = store.stateURL(gameId: "roundtrip", slot: 2)
        try state.write(to: url, options: .atomic)
        XCTAssertEqual(store.listStates(gameId: "roundtrip").map { $0.slot }, [2])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.stateURL(gameId: "roundtrip", slot: 1).path))
        for _ in 0..<60 { core.run() }
        let expected = try XCTUnwrap(core.latestFrame()).data
        XCTAssertTrue(core.unserialize(try Data(contentsOf: url)))
        for _ in 0..<60 { core.run() }
        XCTAssertEqual(try XCTUnwrap(core.latestFrame()).data, expected)
    }
}
