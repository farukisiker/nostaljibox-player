// SPDX-License-Identifier: GPL-3.0-or-later
import XCTest
import CoreGraphics
import NativeInput

final class PadLayoutTests: XCTestCase {
    private func decode(_ json: String) throws -> PadLayout {
        try PadLayout(jsonData: Data(json.utf8))
    }

    func testDecodesTheRealSnesPad() throws {
        let pad = try decode(PadFixtures.snes)
        let zone = try XCTUnwrap(pad.zone)
        XCTAssertEqual(zone.id, "dpad")
        XCTAssertFalse(zone.isAnalog)
        XCTAssertEqual([zone.up, zone.down, zone.left, zone.right], [4, 5, 6, 7])
        XCTAssertEqual(pad.buttons.map { $0.id }, ["face0", "face1", "face2", "face3", "l", "r", "center0", "center1"])

        func mask(_ id: String) throws -> UInt16 {
            try XCTUnwrap(pad.buttons.first { $0.id == id }).mask
        }
        XCTAssertEqual(try mask("face0"), 1 << 9)   // X
        XCTAssertEqual(try mask("face1"), 1 << 1)   // Y
        XCTAssertEqual(try mask("face2"), 1 << 8)   // A
        XCTAssertEqual(try mask("face3"), 1 << 0)   // B
        XCTAssertEqual(try mask("l"), 1 << 10)
        XCTAssertEqual(try mask("r"), 1 << 11)
        XCTAssertEqual(try mask("center0"), 1 << 2) // Select
        XCTAssertEqual(try mask("center1"), 1 << 3) // Start

        let shoulder = try XCTUnwrap(pad.buttons.first { $0.id == "r" })
        XCTAssertEqual(shoulder.location, .right)
        XCTAssertTrue(shoulder.block)
        XCTAssertEqual(shoulder.right, 3)
        XCTAssertEqual(shoulder.top, -45)
        let start = try XCTUnwrap(pad.buttons.first { $0.id == "center1" })
        XCTAssertEqual(start.location, .center)
        XCTAssertEqual(start.left, 62.5)
        XCTAssertEqual(start.fontSize, 15)
    }

    func testNesComboPressesAAndB() throws {
        let pad = try decode(PadFixtures.nes)
        let combo = try XCTUnwrap(pad.buttons.first { $0.id == "ab" })
        XCTAssertTrue(combo.isCombo)
        XCTAssertEqual(combo.inputIDs, [8, 0])
        XCTAssertEqual(combo.mask, (1 << 8) | 1)
        XCTAssertEqual(combo.text, "A+B")
        XCTAssertEqual(combo.fontSize, 18)
    }

    func testBlankButtonsAreInert() throws {
        let pad = try decode(PadFixtures.nes)
        let blank = try XCTUnwrap(pad.buttons.first { $0.id == "blank1" })
        XCTAssertEqual(blank.inputValue, 15)
        XCTAssertTrue(blank.isInert)
        XCTAssertEqual(blank.inputIDs, [])
        XCTAssertEqual(blank.mask, 0)
        let geometry = pad.geometry(for: CGSize(width: 844, height: 390))
        let item = try XCTUnwrap(geometry.items.first { $0.button.id == "blank1" })
        XCTAssertTrue(item.touchRect.isNull, "a blank button does not capture touches")
    }

    func testAnalogIdsOutsideTheMaskAreDropped() {
        let layout = PadLayout(items: [
            ["type": "zone", "id": "stick", "location": "left", "joystickInput": true, "inputValues": [16, 17, 18, 19]],
            ["type": "button", "id": "face0", "location": "right", "left": 40, "top": 0, "text": "C↑", "input_value": 23, "joystickInput": true],
            ["type": "button", "id": "face2", "location": "right", "left": 81, "top": 40, "text": "B", "input_value": 1],
        ])
        XCTAssertTrue(layout.zone?.isAnalog ?? false)
        XCTAssertEqual(layout.zone?.mask(for: .up), 1 << 4, "an analog stick becomes a digital d-pad on 4-7")
        XCTAssertEqual(layout.buttons[0].mask, 0, "ids above 13 do not fit the 16-bit mask")
        XCTAssertEqual(layout.buttons[1].mask, 1 << 1)
    }

    func testNumbersMayArriveAsIntDoubleOrString() {
        let layout = PadLayout(items: [
            ["type": "button", "id": "face0", "location": "right", "left": "40", "top": 0.0, "text": "X", "input_value": NSNumber(value: 9)],
            ["type": "button", "id": "face1", "location": "right", "left": 0, "top": 40, "text": "Y", "input_value": "1"],
            ["type": "mystery", "id": "ignored"],
        ])
        XCTAssertEqual(layout.buttons.count, 2)
        XCTAssertEqual(layout.buttons[0].left, 40)
        XCTAssertEqual(layout.buttons[0].inputValue, 9)
        XCTAssertEqual(layout.buttons[1].inputValue, 1)
    }

    func testRejectsNonArrays() {
        XCTAssertThrowsError(try PadLayout(json: ["type": "zone"]))
        XCTAssertThrowsError(try PadLayout(jsonData: Data("{}".utf8)))
        XCTAssertEqual(try PadLayout(json: [Any]()), PadLayout.empty)
    }

    func testDirectionMathEightWays() {
        let r: CGFloat = 87.5
        func dir(_ dx: CGFloat, _ dy: CGFloat) -> PadDirection { PadMath.direction(dx: dx, dy: dy, radius: r) }
        XCTAssertEqual(dir(0, -50), .up)
        XCTAssertEqual(dir(0, 50), .down)
        XCTAssertEqual(dir(-50, 0), .left)
        XCTAssertEqual(dir(50, 0), .right)
        XCTAssertEqual(dir(40, -40), [.up, .right])
        XCTAssertEqual(dir(-40, -40), [.up, .left])
        XCTAssertEqual(dir(40, 40), [.down, .right])
        XCTAssertEqual(dir(-40, 40), [.down, .left])
        XCTAssertEqual(dir(200, 10), .right, "far outside the radius still reads the direction")
    }

    func testDirectionMathDeadZone() {
        let r: CGFloat = 87.5 // dead zone: 25 % of the radius = 21.875 pt
        XCTAssertEqual(PadMath.direction(dx: 0, dy: 0, radius: r), [])
        XCTAssertEqual(PadMath.direction(dx: 15, dy: 15, radius: r), [])
        XCTAssertEqual(PadMath.direction(dx: 0, dy: -22, radius: r), .up)
        XCTAssertEqual(PadMath.direction(dx: 10, dy: 10, radius: 0), [])
    }

    func testZoneMaskForDirections() throws {
        let zone = try XCTUnwrap(try decode(PadFixtures.snes).zone)
        XCTAssertEqual(zone.mask(for: []), 0)
        XCTAssertEqual(zone.mask(for: .down), 1 << 5)
        XCTAssertEqual(zone.mask(for: [.up, .right]), (1 << 4) | (1 << 7))
        XCTAssertEqual(zone.mask(for: [.down, .left]), (1 << 5) | (1 << 6))
    }

    func testGeometryOnA844x390Screen() throws {
        let pad = try decode(PadFixtures.snes)
        let g = pad.geometry(for: CGSize(width: 844, height: 390))

        let zone = try XCTUnwrap(g.zoneBox)
        XCTAssertEqual(zone.minX, 10, accuracy: 0.01)
        XCTAssertEqual(zone.midY, 195, accuracy: 0.01)
        XCTAssertEqual(zone.width, 175, accuracy: 0.01)
        let touch = try XCTUnwrap(g.zoneTouchRect)
        XCTAssertEqual(touch.minX, -20, accuracy: 0.01)
        XCTAssertEqual(touch.width, 235, accuracy: 0.01)

        XCTAssertEqual(g.diamondBox.maxX, 834, accuracy: 0.01)
        XCTAssertEqual(g.diamondBox.midY, 195, accuracy: 0.01)
        XCTAssertEqual(g.diamondBox.width, 182, accuracy: 0.01)

        func frame(_ id: String) throws -> CGRect { try XCTUnwrap(g.items.first { $0.button.id == id }).frame }
        // Diamond: X top, Y left, A right, B bottom; 50 pt circles scaled 1.4x.
        let x = try frame("face0"), y = try frame("face1"), a = try frame("face2"), b = try frame("face3")
        XCTAssertEqual(x.width, 70, accuracy: 1)
        XCTAssertLessThan(x.midY, y.midY)
        XCTAssertLessThan(y.midX, x.midX)
        XCTAssertLessThan(x.midX, a.midX)
        XCTAssertLessThan(a.midY, b.midY)
        XCTAssertEqual(a.midY, y.midY, accuracy: 1)
        XCTAssertEqual(x.midX, b.midX, accuracy: 1)

        // Shoulders: 90x40 pills; L above the zone's top-left, R above the diamond's top-right.
        let l = try frame("l"), r = try frame("r")
        XCTAssertEqual(l.width, 90, accuracy: 1)
        XCTAssertEqual(l.height, 40, accuracy: 1)
        XCTAssertEqual(l.minX, zone.minX + 3, accuracy: 1)
        XCTAssertEqual(l.minY, zone.minY - 55, accuracy: 1)
        XCTAssertEqual(r.maxX, g.diamondBox.maxX - 3, accuracy: 1)
        XCTAssertEqual(r.minY, g.diamondBox.minY - 45, accuracy: 1)

        // Centre row: 60x30 pills, 65 pt apart around the middle, 12 pt above the bottom.
        let select = try frame("center0"), start = try frame("center1")
        XCTAssertEqual(select.height, 30, accuracy: 1)
        XCTAssertEqual(select.maxY, 390 - 12, accuracy: 0.01)
        XCTAssertEqual(start.midX - select.midX, 65, accuracy: 1)
        XCTAssertEqual((select.midX + start.midX) / 2, 422, accuracy: 1)
    }

    func testGeometryRespectsTheSafeArea() throws {
        let pad = try decode(PadFixtures.snes)
        let g = pad.geometry(for: CGSize(width: 896, height: 414), safeArea: PadInsets(top: 0, left: 44, bottom: 21, right: 44))
        XCTAssertEqual(try XCTUnwrap(g.zoneBox).minX, 44, accuracy: 0.01)
        XCTAssertEqual(g.diamondBox.maxX, 896 - 44, accuracy: 0.01)
        let select = try XCTUnwrap(g.items.first { $0.button.id == "center0" })
        XCTAssertEqual(select.frame.maxY, 414 - 21 - 12, accuracy: 0.01)
    }

    func testLayoutWithoutAZoneHasNoZoneBox() {
        let g = PadLayout.empty.geometry(for: CGSize(width: 844, height: 390))
        XCTAssertNil(g.zoneBox)
        XCTAssertNil(g.zoneTouchRect)
        XCTAssertTrue(g.items.isEmpty)
    }
}
