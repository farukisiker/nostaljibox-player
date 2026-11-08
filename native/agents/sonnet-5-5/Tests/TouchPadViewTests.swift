// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(UIKit)
import XCTest
import UIKit
import NativeInput
import LibretroHost

@MainActor
final class TouchPadViewTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 844, height: 390)

    private func makeView(_ json: String) throws -> TouchPadView {
        let view = TouchPadView(layout: try PadLayout(jsonData: Data(json.utf8)), frame: screen)
        view.layoutIfNeeded()
        return view
    }

    private func center(_ view: TouchPadView, _ id: String) throws -> CGPoint {
        let item = try XCTUnwrap(view.geometry.items.first { $0.button.id == id })
        return CGPoint(x: item.frame.midX, y: item.frame.midY)
    }

    private func zoneCenter(_ view: TouchPadView) throws -> CGPoint {
        let box = try XCTUnwrap(view.geometry.zoneBox)
        return CGPoint(x: box.midX, y: box.midY)
    }

    private func buttons(_ view: TouchPadView) -> UInt16 { view.snapshot(port: 0).buttons }

    func testHitTestOnlyInsideTouchAreas() throws {
        let view = try makeView(PadFixtures.snes)
        XCTAssertTrue(view.hitTest(try center(view, "face2"), with: nil) === view)
        XCTAssertTrue(view.hitTest(try center(view, "l"), with: nil) === view)
        XCTAssertTrue(view.hitTest(try center(view, "center1"), with: nil) === view)
        let zone = try XCTUnwrap(view.geometry.zoneBox)
        XCTAssertTrue(view.hitTest(try zoneCenter(view), with: nil) === view)
        // The zone's touch area reaches 30 pt beyond the 175 pt box.
        XCTAssertTrue(view.hitTest(CGPoint(x: zone.maxX + 25, y: zone.midY), with: nil) === view)
        XCTAssertNil(view.hitTest(CGPoint(x: zone.maxX + 35, y: zone.midY), with: nil))
        XCTAssertNil(view.hitTest(CGPoint(x: 422, y: 195), with: nil), "the middle of the picture falls through to the WebView")
        XCTAssertNil(view.hitTest(CGPoint(x: 422, y: 20), with: nil), "so does the area of the menu button")
    }

    func testBlankButtonDoesNotCaptureTouches() throws {
        let view = try makeView(PadFixtures.nes)
        let blank = try center(view, "blank1")
        XCTAssertNil(view.hitTest(blank, with: nil))
        view.touchBegan(id: 1, at: blank)
        XCTAssertEqual(buttons(view), 0)
    }

    func testButtonPressAndRelease() throws {
        let view = try makeView(PadFixtures.snes)
        XCTAssertEqual(buttons(view), 0)
        view.touchBegan(id: 1, at: try center(view, "face2")) // A
        XCTAssertEqual(buttons(view), 1 << 8)
        XCTAssertEqual(view.pressedMask, 1 << 8)
        XCTAssertEqual(view.snapshot(port: 1).buttons, 0, "only port 0 is the touch pad")
        view.touchEnded(id: 1)
        XCTAssertEqual(buttons(view), 0)
    }

    func testComboPressesAAndB() throws {
        let view = try makeView(PadFixtures.nes)
        view.touchBegan(id: 1, at: try center(view, "ab"))
        XCTAssertEqual(buttons(view), (1 << 8) | 1)
        view.touchEnded(id: 1)
        XCTAssertEqual(buttons(view), 0)
    }

    func testMultiTouchOrsTheButtonsTogether() throws {
        let view = try makeView(PadFixtures.snes)
        let zone = try zoneCenter(view)
        view.touchBegan(id: 1, at: CGPoint(x: zone.x + 50, y: zone.y))    // d-pad right
        view.touchBegan(id: 2, at: try center(view, "face2"))              // A
        view.touchBegan(id: 3, at: try center(view, "face3"))              // B
        XCTAssertEqual(buttons(view), (1 << 7) | (1 << 8) | (1 << 0))
        view.touchEnded(id: 2)
        XCTAssertEqual(buttons(view), (1 << 7) | (1 << 0))
        view.touchEnded(id: 1)
        view.touchEnded(id: 3)
        XCTAssertEqual(buttons(view), 0)
    }

    func testSlidingDpadChangesDirection() throws {
        let view = try makeView(PadFixtures.snes)
        let c = try zoneCenter(view)
        view.touchBegan(id: 1, at: CGPoint(x: c.x + 50, y: c.y))
        XCTAssertEqual(buttons(view), 1 << 7)                                // right
        view.touchMoved(id: 1, to: CGPoint(x: c.x, y: c.y - 50))
        XCTAssertEqual(buttons(view), 1 << 4)                                // up
        view.touchMoved(id: 1, to: CGPoint(x: c.x + 40, y: c.y - 40))
        XCTAssertEqual(buttons(view), (1 << 4) | (1 << 7))                   // up + right
        view.touchMoved(id: 1, to: CGPoint(x: c.x - 50, y: c.y + 50))
        XCTAssertEqual(buttons(view), (1 << 5) | (1 << 6))                   // down + left
        view.touchMoved(id: 1, to: c)
        XCTAssertEqual(buttons(view), 0, "the dead zone in the middle presses nothing")
        view.touchMoved(id: 1, to: CGPoint(x: c.x, y: c.y + 60))
        XCTAssertEqual(buttons(view), 1 << 5)                                // down again
        view.touchEnded(id: 1)
        XCTAssertEqual(buttons(view), 0)
    }

    func testSlidingOffAButtonReleasesIt() throws {
        let view = try makeView(PadFixtures.snes)
        view.touchBegan(id: 1, at: try center(view, "face2"))
        XCTAssertEqual(buttons(view), 1 << 8)
        view.touchMoved(id: 1, to: CGPoint(x: 422, y: 195))
        XCTAssertEqual(buttons(view), 0)
        // Sliding back on does not re-press: the finger lost its target when it left.
        view.touchMoved(id: 1, to: try center(view, "face2"))
        XCTAssertEqual(buttons(view), 0)
    }

    func testSlidingFromZoneBeyondItsAreaReleasesTheDirection() throws {
        let view = try makeView(PadFixtures.snes)
        let c = try zoneCenter(view)
        view.touchBegan(id: 1, at: CGPoint(x: c.x + 50, y: c.y))
        view.touchMoved(id: 1, to: CGPoint(x: 600, y: 195))
        XCTAssertEqual(buttons(view), 0)
    }

    func testTouchesBeginningOutsideAreIgnored() throws {
        let view = try makeView(PadFixtures.snes)
        view.touchBegan(id: 1, at: CGPoint(x: 422, y: 195))
        view.touchMoved(id: 1, to: try center(view, "face2"))
        XCTAssertEqual(buttons(view), 0)
    }

    func testHiddenAndDisabledPadReleasesAndIgnoresTouches() throws {
        let view = try makeView(PadFixtures.snes)
        let a = try center(view, "face2")
        view.touchBegan(id: 1, at: a)
        view.touchBegan(id: 2, at: try center(view, "face3"))
        XCTAssertNotEqual(buttons(view), 0)

        view.setVisible(false)
        XCTAssertEqual(buttons(view), 0, "hiding releases every pressed button")
        XCTAssertTrue(view.isHidden)
        XCTAssertNil(view.hitTest(a, with: nil))
        view.touchBegan(id: 3, at: a)
        XCTAssertEqual(buttons(view), 0)

        view.setVisible(true)
        XCTAssertTrue(view.hitTest(a, with: nil) === view)
        view.touchBegan(id: 4, at: a)
        XCTAssertEqual(buttons(view), 1 << 8)

        view.setEnabled(false)
        XCTAssertEqual(buttons(view), 0, "disabling releases every pressed button")
        XCTAssertNil(view.hitTest(a, with: nil))
        view.touchBegan(id: 5, at: a)
        XCTAssertEqual(buttons(view), 0)
        view.setEnabled(true)
        XCTAssertTrue(view.hitTest(a, with: nil) === view)
    }

    func testReleaseAllClearsEverything() throws {
        let view = try makeView(PadFixtures.snes)
        view.touchBegan(id: 1, at: try center(view, "face2"))
        view.touchBegan(id: 2, at: try center(view, "l"))
        XCTAssertEqual(buttons(view), (1 << 8) | (1 << 10))
        view.releaseAll()
        XCTAssertEqual(buttons(view), 0)
    }

    func testRelayoutFollowsTheViewSize() throws {
        let view = try makeView(PadFixtures.snes)
        view.touchBegan(id: 1, at: try center(view, "face2"))
        view.frame = CGRect(x: 0, y: 0, width: 896, height: 414)
        view.layoutIfNeeded()
        XCTAssertEqual(view.geometry.diamondBox.maxX, 886, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(view.geometry.zoneBox).midY, 207, accuracy: 0.01)
        XCTAssertEqual(buttons(view), 0, "a rotation lets go of the buttons under the fingers")
    }

    func testSetLayoutSwapsThePadAndReleases() throws {
        let view = try makeView(PadFixtures.snes)
        view.touchBegan(id: 1, at: try center(view, "face2"))
        view.setLayout(try PadLayout(jsonData: Data(PadFixtures.nes.utf8)))
        XCTAssertEqual(buttons(view), 0)
        XCTAssertNotNil(view.geometry.items.first { $0.button.id == "ab" })
        XCTAssertNil(view.geometry.items.first { $0.button.id == "face0" })
    }

    func testHapticsAreOffByDefault() throws {
        XCTAssertFalse(try makeView(PadFixtures.snes).hapticsEnabled)
    }

    func testTouchPadMixesWithAGamepad() throws {
        let view = try makeView(PadFixtures.snes)
        let pad = GamepadInput(notificationCenter: NotificationCenter())
        let mixer = InputMixer([view, pad])
        view.touchBegan(id: 1, at: try center(view, "face2"))
        XCTAssertEqual(mixer.snapshot(port: 0).buttons, 1 << 8)
    }
}
#endif
