import XCTest
@testable import LibretroHost

final class RouteRecoveryTests: XCTestCase {
    func testLostRouteSurvivesForegroundAndConfigurationChange() {
        var pauses = PauseCoordinator(); pauses.begin()
        pauses.set("route", active: true)
        pauses.set("background", active: true)
        pauses.set("configChange", active: true)
        pauses.set("configChange", active: false)
        pauses.set("background", active: false)
        XCTAssertEqual(pauses.reasons, ["route"])
        XCTAssertFalse(pauses.running)
    }

    func testManualResumePreservesOtherIndependentReasons() {
        var pauses = PauseCoordinator(); pauses.begin()
        for reason in ["user", "route", "background", "interruption", "configChange"] {
            pauses.set(reason, active: true)
        }
        pauses.resume()
        XCTAssertEqual(pauses.reasons, ["background", "interruption", "configChange"])
        XCTAssertFalse(pauses.running)
    }

    func testOnlyIdenticalRouteWithinTwoSecondsRecoversOnce() {
        var route = RouteRecovery()
        route.lost(outputs: ["headphones", "secondary"], at: 10)
        XCTAssertFalse(route.returned(outputs: ["speaker"], at: 10.5))
        XCTAssertFalse(route.returned(outputs: ["headphones"], at: 11))
        XCTAssertTrue(route.returned(outputs: ["secondary", "headphones"], at: 12))
        XCTAssertFalse(route.returned(outputs: ["headphones", "secondary"], at: 12))
    }

    func testLateUnknownOrNegativeTimeRequiresManualResume() {
        var route = RouteRecovery()
        route.lost(outputs: ["headphones"], at: 10)
        XCTAssertFalse(route.returned(outputs: ["headphones"], at: 9))
        XCTAssertFalse(route.returned(outputs: ["headphones"], at: 12.001))
        route.lost(outputs: [], at: 20)
        XCTAssertFalse(route.returned(outputs: [], at: 20.5))
        route = RouteRecovery() // manual resume or session teardown
        XCTAssertFalse(route.returned(outputs: ["headphones"], at: 20.5))
    }

    func testQuickReturnDoesNotClearUserOrBackgroundPause() {
        var route = RouteRecovery()
        var pauses = PauseCoordinator(); pauses.begin()
        for reason in ["user", "route", "background", "interruption"] { pauses.set(reason, active: true) }
        route.lost(outputs: ["headphones"], at: 10)
        if route.returned(outputs: ["headphones"], at: 11) { pauses.set("route", active: false) }
        XCTAssertEqual(pauses.reasons, ["user", "background", "interruption"])
        XCTAssertFalse(pauses.running)
    }
}
