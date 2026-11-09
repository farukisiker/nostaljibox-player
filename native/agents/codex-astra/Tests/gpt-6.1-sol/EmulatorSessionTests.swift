import XCTest
@testable import LibretroHost

final class EmulatorSessionTests: XCTestCase {
    func testOverlappingReasonsCannotResumeEachOther() {
        var state = PauseCoordinator()
        state.set("background", active: true)
        state.begin()
        XCTAssertFalse(state.running)
        state.set("interruption", active: true)
        state.set("background", active: false)
        XCTAssertFalse(state.running)
        state.set("interruption", active: false)
        XCTAssertTrue(state.running)
    }
    func testRouteRequiresManualResumeAndPreservesBackground() {
        var state = PauseCoordinator(); state.begin()
        state.set("route", active: true); state.set("background", active: true)
        state.resume()
        XCTAssertEqual(state.reasons, ["background"])
        XCTAssertFalse(state.running)
        state.set("background", active: false)
        XCTAssertTrue(state.running)
    }
    func testConfigurationDoesNotOverrideUserPause() {
        var state = PauseCoordinator(); state.begin()
        state.set("user", active: true); state.set("configChange", active: true)
        state.set("configChange", active: false)
        XCTAssertFalse(state.running)
        state.resume(); XCTAssertTrue(state.running)
    }
    func testRepeatedStopAndFailureRetryClearReasons() {
        var state = PauseCoordinator(); state.begin()
        state.set("background", active: true)
        state.end(); state.end()
        XCTAssertFalse(state.running)
        XCTAssertTrue(state.reasons.isEmpty)
        state.begin()
        XCTAssertTrue(state.running)
        state.set("background", active: false)
        XCTAssertTrue(state.running)
    }
    func testReevaluateRunsEffectsOnlyOnTransitions() {
        var state = PauseCoordinator()
        var running = false, starts = 0, stops = 0
        func update() {
            running = state.reconcile(currentlyRunning: running, start: { starts += 1 }, pause: { stops += 1 })
        }
        state.begin(); update(); update()
        XCTAssertEqual(starts, 1)
        state.set("user", active: true); update()
        state.set("configChange", active: true); update()
        state.set("configChange", active: false); update()
        XCTAssertEqual(starts, 1); XCTAssertEqual(stops, 1)
        state.resume(); update()
        XCTAssertEqual(starts, 2)
    }
    func testBackgroundBeforeStartAndRepeatedStopEffects() {
        var state = PauseCoordinator()
        var running = false, starts = 0, stops = 0
        func update() {
            running = state.reconcile(currentlyRunning: running, start: { starts += 1 }, pause: { stops += 1 })
        }
        state.set("background", active: true)
        state.begin(); update()
        XCTAssertEqual(starts, 0)
        state.set("background", active: false); update()
        XCTAssertEqual(starts, 1)
        state.end(); update()
        state.end(); update()
        XCTAssertEqual(stops, 1)
        XCTAssertFalse(running)
    }
    func testFailedStartCanRetry() {
        var state = PauseCoordinator(); state.begin()
        XCTAssertThrowsError(try state.reconcile(currentlyRunning: false, start: {
            throw SessionError(code: "audio", message: "fake")
        }, pause: {}))
        state.end(); state.begin()
        XCTAssertTrue(state.reconcile(currentlyRunning: false, start: {}, pause: {}))
    }
    func testFrameDebtCapsCatchupAndResetsResume() {
        var debt = FrameDebt(fps: 60)
        XCTAssertEqual(debt.frames(at: 10), 0)
        XCTAssertEqual(debt.frames(at: 10.1), 2)
        XCTAssertEqual(debt.frames(at: 10.1), 0)
        XCTAssertEqual(debt.frames(at: 20), 0)
        debt.reset()
        XCTAssertEqual(debt.frames(at: 30), 0)
        XCTAssertEqual(debt.frames(at: 30 + 1.0 / 60), 1)
    }
    func testWaitResetDiscardsFractionalDebtAndWaitDuration() {
        var debt = FrameDebt(fps: 60)
        XCTAssertEqual(debt.frames(at: 1), 0)
        XCTAssertEqual(debt.frames(at: 1.012), 0) // 0.72 of a frame pending
        debt.reset() // remote input missing; do not catch up the time spent waiting
        XCTAssertEqual(debt.frames(at: 2), 0)
        XCTAssertEqual(debt.frames(at: 2.008), 0) // old fraction must not survive
        XCTAssertEqual(debt.frames(at: 2 + 1.0 / 60), 1)
    }
    func testPALAndFractionalRates() {
        for rate in [50.0, 59.94, 60.0988] {
            var debt = FrameDebt(fps: rate)
            _ = debt.frames(at: 0)
            var total = 0
            for tick in 1...600 { total += debt.frames(at: Double(tick) / 60) }
            XCTAssertLessThanOrEqual(abs(total - Int(rate * 10)), 1)
        }
    }
    func testNTSCRateOnSixtyHertzLinkRunsAboutSixHundredAndOneFrames() {
        var debt = FrameDebt(fps: 60.0988)
        _ = debt.frames(at: 0)
        var total = 0
        for tick in 1...600 { total += debt.frames(at: Double(tick) / 60) }
        XCTAssertTrue(total == 600 || total == 601, "got \(total)")
    }
    func testTickStatsAveragesAndResets() {
        var stats = TickStats()
        for _ in 0..<60 { stats.recordTick() }
        stats.recordRun(seconds: 0.004, frames: 1)
        stats.recordRun(seconds: 0.010, frames: 2) // 3 runs, 14 ms in total
        stats.recordUpload(seconds: 0.001)
        stats.recordUpload(seconds: 0.003)
        let sample = stats.sample(elapsed: 1.0)
        XCTAssertEqual(sample.linkHz, 60, accuracy: 0.001)
        XCTAssertEqual(sample.coreMs, 14.0 / 3, accuracy: 0.001)
        XCTAssertEqual(sample.uploadMs, 2, accuracy: 0.001)
        let empty = stats.sample(elapsed: 1.0)
        XCTAssertEqual(empty.linkHz, 0); XCTAssertEqual(empty.coreMs, 0); XCTAssertEqual(empty.uploadMs, 0)
        var fresh = TickStats(); fresh.recordTick()
        XCTAssertEqual(fresh.sample(elapsed: 0).linkHz, 0) // no division by a zero interval
    }
    func testStatsLabelShowsMeasuredOverTargetRate() {
        let pal = StatsOverlay.text(for: ["fps": 49.97, "targetFps": 50.0, "coreMs": 4.21, "footprintMB": 71.4,
                                          "audioUnderruns": UInt64(0), "linkHz": 59.98, "uploadMs": 0.274])
        XCTAssertEqual(pal, "50/50 fps · core 4.2 ms · 71 MB · und 0\nlink 60 Hz · upload 0.27 ms")
        let slow = StatsOverlay.text(for: ["fps": 50.2, "targetFps": 60.0988])
        XCTAssertTrue(slow.hasPrefix("50/60 fps · core 0.0 ms · 0 MB · und 0"))
    }
}
