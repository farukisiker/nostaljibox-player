import XCTest
@testable import LibretroHost

final class LockstepDriverTests: XCTestCase {
    private func config(role: Int = 0, epoch: Int = 1, delay: Int = 4, batch: Int = 2,
                        applied: [UInt16] = [0, 0]) throws -> LockstepConfiguration {
        try LockstepConfiguration(role: role, epoch: epoch, applied: applied, delay: delay, batch: batch)
    }
    func testConfigurationRejectsMalformedAndOverflowValues() {
        for body in [
            { try self.config(role: 2) }, { try self.config(epoch: -1) },
            { try self.config(epoch: Int.max) }, { try self.config(delay: 0) },
            { try self.config(delay: 11) }, { try self.config(batch: 5) },
            { try self.config(applied: [0]) },
            { try LockstepConfiguration(role: 0, epoch: 1, applied: [0, 0], checkEvery: 59) }
        ] { XCTAssertThrowsError(try body()) }
    }
    func testSymmetricPeersApplySamePortsAndFirstDelayedSample() throws {
        var host = LockstepDriver(), guest = LockstepDriver()
        try host.start(config(role: 0)); try guest.start(config(role: 1))
        var hostRuns: [[UInt16]] = [], guestRuns: [[UInt16]] = []
        var hostPackets: [(Int, [UInt16])] = [], guestPackets: [(Int, [UInt16])] = []
        for index in 0..<20 {
            _ = host.advance(count: 1, producing: true, now: Double(index), sample: { UInt16(index + 1) },
                run: { hostRuns.append([$0, $1]) }, checksum: { "hash" }, emit: { name, value in
                    if name == "lockstepInputs" { hostPackets.append((value["from"] as! Int, (value["masks"] as! [Int]).map(UInt16.init))) }
                })
            _ = guest.advance(count: 1, producing: true, now: Double(index), sample: { UInt16(index + 101) },
                run: { guestRuns.append([$0, $1]) }, checksum: { "hash" }, emit: { name, value in
                    if name == "lockstepInputs" { guestPackets.append((value["from"] as! Int, (value["masks"] as! [Int]).map(UInt16.init))) }
                })
            for (from, masks) in hostPackets { guest.push(epoch: 1, from: from, masks: masks) }
            for (from, masks) in guestPackets { host.push(epoch: 1, from: from, masks: masks) }
            hostPackets.removeAll(); guestPackets.removeAll()
        }
        XCTAssertEqual(hostRuns, guestRuns)
        XCTAssertEqual(hostRuns.count, 20)
        XCTAssertEqual(Array(hostRuns.prefix(4)), Array(repeating: [0, 0], count: 4))
        XCTAssertEqual(hostRuns[4], [1, 101]) // current f samples f+delay, not f+delay+1
    }
    func testWaitFlushesPartialBatchThenRemoteArrivalRecovers() throws {
        var driver = LockstepDriver()
        try driver.start(config(delay: 3, batch: 2))
        var packets: [[String: Any]] = [], states: [Bool] = []
        let emit: (String, [String: Any]) -> Void = { name, payload in
            if name == "lockstepInputs" { packets.append(payload) }
            if name == "lockstepState" { states.append(payload["waiting"] as! Bool) }
        }
        for _ in 0..<2 {
            _ = driver.advance(count: 2, producing: true, now: 0, sample: { 7 }, run: { _, _ in }, checksum: { "" }, emit: emit)
        }
        XCTAssertEqual(driver.frame, 3)
        XCTAssertEqual(packets.map { $0["from"] as! Int }, [3, 5])
        XCTAssertEqual(packets.map { ($0["masks"] as! [Int]).count }, [2, 1])
        XCTAssertEqual(driver.waits, 1)
        _ = driver.advance(count: 0, producing: true, now: 1.6, sample: { 0 }, run: { _, _ in }, checksum: { "" }, emit: emit)
        XCTAssertEqual(states, [true])
        driver.push(epoch: 1, from: 3, masks: [9])
        var ports: [UInt16] = []
        XCTAssertEqual(driver.advance(count: 1, producing: true, now: 1.7, sample: { 8 },
            run: { ports = [$0, $1] }, checksum: { "" }, emit: emit), 1)
        XCTAssertEqual(ports, [7, 9]); XCTAssertEqual(states, [true, false])
    }
    func testOnlyNextEpochBuffersIncludingBeforeFirstStart() throws {
        var driver = LockstepDriver()
        driver.push(epoch: 1, from: 1, masks: [41])
        driver.push(epoch: 2, from: 1, masks: [99]) // cannot replace next epoch
        try driver.start(config(delay: 1, batch: 1))
        var runs: [[UInt16]] = []
        let run: (UInt16, UInt16) -> Void = { runs.append([$0, $1]) }
        XCTAssertEqual(driver.advance(count: 2, producing: true, now: 0, sample: { 3 }, run: run, checksum: { "" }, emit: { _, _ in }), 2)
        XCTAssertEqual(runs, [[0, 0], [3, 41]])
        driver.push(epoch: 0, from: 2, masks: [80])
        driver.push(epoch: 2, from: 1, masks: [42])
        try driver.start(config(epoch: 2, delay: 1, batch: 1))
        runs.removeAll()
        _ = driver.advance(count: 2, producing: true, now: 0, sample: { 4 }, run: run, checksum: { "" }, emit: { _, _ in })
        XCTAssertEqual(runs, [[0, 0], [4, 42]])
    }
    func testHoldPauseAndStopGateRealRunCallbacks() throws {
        var driver = LockstepDriver(), runs = 0
        func step(_ producing: Bool) -> Int {
            driver.advance(count: 2, producing: producing, now: 0, sample: { 0 },
                run: { _, _ in runs += 1 }, checksum: { "" }, emit: { _, _ in })
        }
        driver.setHold(true)
        XCTAssertFalse(driver.mayPrefill)
        XCTAssertEqual(step(true), 0) // hold before driver exists
        try driver.start(config())
        XCTAssertTrue(driver.hold) // start must not release handshake hold
        XCTAssertEqual(step(true), 0)
        driver.push(epoch: 1, from: 4, masks: [9])
        XCTAssertEqual(step(false), 0) // push cannot run a paused core
        driver.setHold(false)
        XCTAssertEqual(step(false), 0)
        XCTAssertEqual(step(true), 2)
        XCTAssertEqual(runs, 2)
        driver.setHold(true); driver.stop(); driver.stop()
        XCTAssertFalse(driver.hold); XCTAssertFalse(driver.active); XCTAssertTrue(driver.mayPrefill)
        // This is the same session free-run decision after stop, including a held handshake.
        if driver.mayPrefill { runs += 1 }
        XCTAssertEqual(runs, 3)
    }
    func testTwoFrameCapAndChecksumAtExactBoundary() throws {
        var driver = LockstepDriver()
        try driver.start(config(delay: 1, batch: 1))
        driver.push(epoch: 1, from: 1, masks: Array(repeating: 0, count: 100))
        var checks: [Int] = [], hashes = 0
        for _ in 0..<30 {
            XCTAssertEqual(driver.advance(count: 100, producing: true, now: 0, sample: { 0 }, run: { _, _ in },
                checksum: { hashes += 1; return "0123456789abcdef" }, emit: { name, payload in
                    if name == "lockstepChecksum" { checks.append(payload["frame"] as! Int) }
                }), 2)
        }
        // Default is 300: no checksum before its boundary.
        XCTAssertTrue(checks.isEmpty); XCTAssertEqual(hashes, 0)
        let boundary = try LockstepConfiguration(role: 0, epoch: 2, applied: [0, 0], delay: 1, batch: 1, checkEvery: 60)
        driver.start(boundary); driver.push(epoch: 2, from: 1, masks: Array(repeating: 0, count: 100))
        for _ in 0..<30 {
            _ = driver.advance(count: 2, producing: true, now: 0, sample: { 0 }, run: { _, _ in },
                checksum: { hashes += 1; return "0123456789abcdef" }, emit: { name, payload in
                    if name == "lockstepChecksum" { checks.append(payload["frame"] as! Int) }
                })
        }
        XCTAssertEqual(checks, [60]); XCTAssertEqual(hashes, 1)
    }
    func testDesyncReportsValidateEpochFrameDeduplicateAndReset() throws {
        var driver = LockstepDriver()
        var events: [[String: Any]] = []
        let emit: (String, [String: Any]) -> Void = { name, payload in
            if name == "lockstepState" { events.append(payload) }
        }
        driver.noteDesync(epoch: 1, frame: 60, emit: emit) // inactive
        let configuration = try LockstepConfiguration(role: 0, epoch: 1, applied: [0, 0],
                                                       delay: 1, batch: 1, checkEvery: 60)
        driver.start(configuration)
        driver.push(epoch: 1, from: 1, masks: Array(repeating: 0, count: 120))
        for _ in 0..<60 {
            _ = driver.advance(count: 2, producing: true, now: 0, sample: { 0 },
                               run: { _, _ in }, checksum: { "hash" }, emit: emit)
        }
        for (epoch, frame) in [(0, 60), (2, 60), (1, -1), (1, 0), (1, 180), (1, 61), (Int.max, Int.max)] {
            driver.noteDesync(epoch: epoch, frame: frame, emit: emit)
        }
        XCTAssertEqual(driver.desyncs, 0); XCTAssertTrue(events.isEmpty)
        driver.noteDesync(epoch: 1, frame: 120, emit: emit)
        driver.noteDesync(epoch: 1, frame: 60, emit: emit) // reordered unique report counts
        driver.noteDesync(epoch: 1, frame: 120, emit: emit)
        XCTAssertEqual(driver.desyncs, 2)
        XCTAssertEqual(events.map { $0["desyncs"] as! Int }, [1, 2])
        XCTAssertEqual(events.last?["frame"] as? Int, 120)
        XCTAssertEqual(events.last?["waiting"] as? Bool, false)
        driver.start(configuration)
        XCTAssertEqual(driver.desyncs, 0)
        driver.noteDesync(epoch: 1, frame: 60, emit: emit) // old report is ahead of new frame zero
        XCTAssertEqual(driver.desyncs, 0)
        driver.stop(); driver.stop()
        XCTAssertEqual(driver.desyncs, 0)
    }
    func testMalformedRemotePacketsCannotOverflowOrSatisfyGate() throws {
        var driver = LockstepDriver()
        try driver.start(config(delay: 1, batch: 1))
        driver.push(epoch: 1, from: Int.max, masks: [1, 2])
        driver.push(epoch: 1, from: -1, masks: [1])
        driver.push(epoch: 1, from: 1, masks: Array(repeating: 1, count: 1025))
        driver.push(epoch: Int.max, from: 1, masks: [1])
        XCTAssertEqual(driver.advance(count: 2, producing: true, now: 0, sample: { 0 }, run: { _, _ in }, checksum: { "" }, emit: { _, _ in }), 1)
        XCTAssertTrue(driver.stalled)
    }
}
