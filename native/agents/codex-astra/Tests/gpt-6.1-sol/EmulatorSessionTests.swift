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
    func testPALAndFractionalRates() {
        for rate in [50.0, 59.94, 60.0988] {
            var debt = FrameDebt(fps: rate)
            _ = debt.frames(at: 0)
            var total = 0
            for tick in 1...600 { total += debt.frames(at: Double(tick) / 60) }
            XCTAssertLessThanOrEqual(abs(total - Int(rate * 10)), 1)
        }
    }
}
