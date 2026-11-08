// SPDX-License-Identifier: GPL-3.0-or-later
#if canImport(GameController)
import XCTest
import NativeInput

final class GamepadInputTests: XCTestCase {
    private func mask(_ configure: (inout GamepadState) -> Void) -> UInt16 {
        var state = GamepadState()
        configure(&state)
        return GamepadInput.mask(for: state)
    }

    func testFaceButtonsFollowTheRetroPadIds() {
        XCTAssertEqual(mask { $0.a = true }, 1 << 8)
        XCTAssertEqual(mask { $0.b = true }, 1 << 0)
        XCTAssertEqual(mask { $0.x = true }, 1 << 9)
        XCTAssertEqual(mask { $0.y = true }, 1 << 1)
    }

    func testShouldersTriggersAndSystemButtons() {
        XCTAssertEqual(mask { $0.leftShoulder = true }, 1 << 10)
        XCTAssertEqual(mask { $0.rightShoulder = true }, 1 << 11)
        XCTAssertEqual(mask { $0.leftTrigger = true }, 1 << 12)
        XCTAssertEqual(mask { $0.rightTrigger = true }, 1 << 13)
        XCTAssertEqual(mask { $0.menu = true }, 1 << 3, "menu is start")
        XCTAssertEqual(mask { $0.options = true }, 1 << 2, "options is select")
    }

    func testDpadAndLeftStickBothDriveTheDirections() {
        XCTAssertEqual(mask { $0.dpadY = 1 }, 1 << 4)
        XCTAssertEqual(mask { $0.dpadY = -1 }, 1 << 5)
        XCTAssertEqual(mask { $0.dpadX = -1 }, 1 << 6)
        XCTAssertEqual(mask { $0.dpadX = 1 }, 1 << 7)
        XCTAssertEqual(mask { $0.stickY = 0.8 }, 1 << 4)
        XCTAssertEqual(mask { $0.stickX = -0.8 }, 1 << 6)
        XCTAssertEqual(mask { $0.stickX = 0.8; $0.stickY = -0.8 }, (1 << 7) | (1 << 5))
        XCTAssertEqual(mask { $0.dpadX = 1; $0.stickX = 1 }, 1 << 7, "both at once is still one bit")
    }

    func testAxisThresholdIsHalf() {
        XCTAssertEqual(mask { $0.stickX = 0.5 }, 0, "exactly 0.5 does not press")
        XCTAssertEqual(mask { $0.stickX = 0.51 }, 1 << 7)
        XCTAssertEqual(mask { $0.stickX = 0.4 }, 0)
        XCTAssertEqual(mask { $0.dpadY = -0.4 }, 0)
        XCTAssertEqual(GamepadInput.mask(for: { var s = GamepadState(); s.stickX = 0.3; return s }(), threshold: 0.2), 1 << 7)
    }

    func testSeveralButtonsAtOnce() {
        let bits = mask { $0.a = true; $0.b = true; $0.menu = true; $0.dpadX = 1 }
        XCTAssertEqual(bits, (1 << 8) | (1 << 0) | (1 << 3) | (1 << 7))
    }

    func testNothingPressedByDefault() {
        XCTAssertEqual(GamepadInput.mask(for: GamepadState()), 0)
    }

    func testSnapshotStartsEmptyAndReleaseAllIsSafe() {
        let pad = GamepadInput(notificationCenter: NotificationCenter())
        XCTAssertEqual(pad.snapshot(port: 0).buttons, 0)
        XCTAssertEqual(pad.snapshot(port: 1).buttons, 0)
        pad.releaseAll()
        XCTAssertEqual(pad.snapshot(port: 0).buttons, 0)
        XCTAssertNil(pad.onConnectionChange)
    }
}
#endif
