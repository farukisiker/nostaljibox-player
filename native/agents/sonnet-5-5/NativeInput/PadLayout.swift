// SPDX-License-Identifier: GPL-3.0-or-later
// Decoding of the EmulatorJS virtual-gamepad table (`PADS[game.core]` in src/play.js, API.md §5)
// and the layout geometry of the native touch pad. No UIKit here, so it is plain unit-testable.
import Foundation
import CoreGraphics

/// Safe-area insets in points; a UIKit-free stand-in for `UIEdgeInsets`.
public struct PadInsets: Equatable {
    public var top: CGFloat
    public var left: CGFloat
    public var bottom: CGFloat
    public var right: CGFloat
    public init(top: CGFloat = 0, left: CGFloat = 0, bottom: CGFloat = 0, right: CGFloat = 0) {
        self.top = top
        self.left = left
        self.bottom = bottom
        self.right = right
    }
    public static let zero = PadInsets()
}

/// RetroPad ids (RETRO_DEVICE_ID_JOYPAD_*) that fit the 16-bit input mask: 0...13.
public enum RetroPad {
    public static let b = 0, y = 1, select = 2, start = 3
    public static let up = 4, down = 5, left = 6, right = 7
    public static let a = 8, x = 9, l = 10, r = 11, l2 = 12, r2 = 13
    /// Bit for a RetroPad id, 0 for ids outside 0...13 (analog ids 16-23, the inert 15).
    public static func bit(_ id: Int) -> UInt16 {
        (0...13).contains(id) ? UInt16(1) << UInt16(id) : 0
    }
}

public enum PadLocation: String, Equatable {
    case left, right, center
}

public struct PadButton: Equatable {
    public let id: String
    public let text: String
    public let location: PadLocation
    public let left: CGFloat?
    public let top: CGFloat?
    public let right: CGFloat?
    public let fontSize: CGFloat?
    public let block: Bool
    public let inputValue: Int

    public init(id: String, text: String, location: PadLocation, left: CGFloat? = nil, top: CGFloat? = nil,
                right: CGFloat? = nil, fontSize: CGFloat? = nil, block: Bool = false, inputValue: Int) {
        self.id = id
        self.text = text
        self.location = location
        self.left = left
        self.top = top
        self.right = right
        self.fontSize = fontSize
        self.block = block
        self.inputValue = inputValue
    }

    /// `blank*` buttons are drawn dimmed, produce no input and do not capture touches.
    public var isInert: Bool { id.hasPrefix("blank") }
    /// `ab` presses `input_value` and button 0 (B) together.
    public var isCombo: Bool { id == "ab" }
    /// RetroPad ids this button presses.
    public var inputIDs: [Int] {
        if isInert { return [] }
        let ids = isCombo ? [inputValue, RetroPad.b] : [inputValue]
        return ids.filter { (0...13).contains($0) }
    }
    public var mask: UInt16 { inputIDs.reduce(UInt16(0)) { $0 | RetroPad.bit($1) } }
}

/// Which of the four directions a finger on the zone presses.
public struct PadDirection: OptionSet, Equatable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }
    public static let up = PadDirection(rawValue: 1)
    public static let down = PadDirection(rawValue: 2)
    public static let left = PadDirection(rawValue: 4)
    public static let right = PadDirection(rawValue: 8)
}

public struct PadZone: Equatable {
    public let id: String
    public let location: PadLocation
    public let isAnalog: Bool
    /// RetroPad ids for up, down, left, right. The analog stick's ids (16-19) cannot be sent
    /// through the 16-bit mask, so an analog zone acts as a digital d-pad on 4-7.
    public let up: Int
    public let down: Int
    public let left: Int
    public let right: Int

    public init(id: String, location: PadLocation, isAnalog: Bool, inputValues: [Int]) {
        self.id = id
        self.location = location
        self.isAnalog = isAnalog
        if inputValues.count >= 4, inputValues.prefix(4).allSatisfy({ (0...13).contains($0) }) {
            up = inputValues[0]
            down = inputValues[1]
            left = inputValues[2]
            right = inputValues[3]
        } else {
            up = RetroPad.up
            down = RetroPad.down
            left = RetroPad.left
            right = RetroPad.right
        }
    }

    public func mask(for direction: PadDirection) -> UInt16 {
        var mask: UInt16 = 0
        if direction.contains(.up) { mask |= RetroPad.bit(up) }
        if direction.contains(.down) { mask |= RetroPad.bit(down) }
        if direction.contains(.left) { mask |= RetroPad.bit(left) }
        if direction.contains(.right) { mask |= RetroPad.bit(right) }
        return mask
    }
}

public enum PadMath {
    /// Fraction of the zone radius inside which a finger presses nothing.
    public static let deadZone: CGFloat = 0.25

    /// 8-way direction for a finger offset (`dx`, `dy`, y grows downwards) from the zone centre.
    /// Each of the eight sectors is 45 degrees wide.
    public static func direction(dx: CGFloat, dy: CGFloat, radius: CGFloat, deadZone: CGFloat = PadMath.deadZone) -> PadDirection {
        if radius <= 0 || hypot(dx, dy) < radius * deadZone { return [] }
        let angle = atan2(-dy, dx) // counter-clockwise from "right", screen-up positive
        let sector = ((Int((angle / (.pi / 4)).rounded()) % 8) + 8) % 8
        switch sector {
        case 0: return .right
        case 1: return [.up, .right]
        case 2: return .up
        case 3: return [.up, .left]
        case 4: return .left
        case 5: return [.down, .left]
        case 6: return .down
        default: return [.down, .right]
        }
    }
}

public struct PadLayout: Equatable {
    public enum DecodeError: Error, Equatable {
        case notAnArray
    }

    public let zone: PadZone?
    public let buttons: [PadButton]

    public static let empty = PadLayout(zone: nil, buttons: [])

    public init(zone: PadZone?, buttons: [PadButton]) {
        self.zone = zone
        self.buttons = buttons
    }

    /// `json` is what Capacitor hands over (`[Any]` of `[String: Any]`) or `JSONSerialization` output.
    /// Items of an unknown shape are skipped, numbers may arrive as Int, Double or numeric strings.
    public init(json: Any) throws {
        guard let array = json as? [Any] else { throw DecodeError.notAnArray }
        self.init(items: array.compactMap { $0 as? [String: Any] })
    }

    public init(jsonData: Data) throws {
        try self.init(json: try JSONSerialization.jsonObject(with: jsonData))
    }

    public init(items: [[String: Any]]) {
        var zone: PadZone?
        var buttons: [PadButton] = []
        for item in items {
            let id = (item["id"] as? String) ?? ""
            let location = (item["location"] as? String).flatMap(PadLocation.init(rawValue:)) ?? .right
            switch item["type"] as? String {
            case "zone":
                if zone == nil {
                    let values = (item["inputValues"] as? [Any])?.compactMap { PadLayout.number($0).map { Int($0) } } ?? []
                    zone = PadZone(id: id, location: location, isAnalog: PadLayout.flag(item["joystickInput"]), inputValues: values)
                }
            case "button":
                buttons.append(PadButton(
                    id: id,
                    text: (item["text"] as? String) ?? "",
                    location: location,
                    left: PadLayout.number(item["left"]).map { CGFloat($0) },
                    top: PadLayout.number(item["top"]).map { CGFloat($0) },
                    right: PadLayout.number(item["right"]).map { CGFloat($0) },
                    fontSize: PadLayout.number(item["fontSize"]).map { CGFloat($0) },
                    block: PadLayout.flag(item["block"]),
                    inputValue: PadLayout.number(item["input_value"]).map { Int($0) } ?? -1))
            default:
                continue
            }
        }
        self.init(zone: zone, buttons: buttons)
    }

    private static func number(_ value: Any?) -> Double? {
        switch value {
        case let v as Int: return Double(v)
        case let v as Double: return v
        case let v as NSNumber: return v.doubleValue
        case let v as String: return Double(v.trimmingCharacters(in: .whitespaces)) // "50%" -> nil
        default: return nil
        }
    }

    private static func flag(_ value: Any?) -> Bool {
        if let v = value as? Bool { return v }
        return (number(value) ?? 0) != 0
    }
}

// MARK: - Geometry (API.md §5)

public enum PadMetrics {
    public static let zoneSize: CGFloat = 175
    public static let zoneSlop: CGFloat = 30
    public static let buttonSlop: CGFloat = 6
    public static let edgeMargin: CGFloat = 10
    public static let diamondBox: CGFloat = 130
    public static let diamondScale: CGFloat = 1.4
    public static let circleSize: CGFloat = 50
    public static let shoulderSize = CGSize(width: 90, height: 40)
    public static let centerSize = CGSize(width: 60, height: 30)
    public static let centerBottomGap: CGFloat = 12
}

public struct PadGeometry {
    public struct Item {
        public let button: PadButton
        public let frame: CGRect
        /// Where a finger counts as pressing; `.null` for inert buttons.
        public let touchRect: CGRect
        public var isPill: Bool { button.block || button.location == .center }
    }
    /// The 175 pt square of the zone and its touch area (box + 30 pt on every side).
    public let zoneBox: CGRect?
    public let zoneTouchRect: CGRect?
    /// The 130 pt diamond box after the 1.4x scale.
    public let diamondBox: CGRect
    public let items: [Item]
}

extension PadLayout {
    /// Positions every control for a view of `size` with `safeArea` insets (landscape, points).
    public func geometry(for size: CGSize, safeArea: PadInsets = .zero) -> PadGeometry {
        let m = PadMetrics.self
        let centerY = size.height / 2

        // Left zone: 175 square, left edge at max(safe left, 10), vertically centred.
        let zoneBox: CGRect? = zone.map { _ in
            CGRect(x: max(safeArea.left, m.edgeMargin), y: centerY - m.zoneSize / 2, width: m.zoneSize, height: m.zoneSize)
        }
        // Left anchor for shoulders even when the layout has no zone.
        let leftAnchor = zoneBox ?? CGRect(x: max(safeArea.left, m.edgeMargin), y: centerY - m.zoneSize / 2, width: m.zoneSize, height: m.zoneSize)

        // Right diamond: 130 box scaled 1.4x from its bottom-right corner, vertically centred,
        // right edge at width - max(safe right, 10).
        let boxSize = m.diamondBox * m.diamondScale
        let rightEdge = size.width - max(safeArea.right, m.edgeMargin)
        let diamond = CGRect(x: rightEdge - boxSize, y: centerY - boxSize / 2, width: boxSize, height: boxSize)

        var items: [PadGeometry.Item] = []
        for button in buttons {
            var frame: CGRect
            switch (button.location, button.block) {
            case (.center, _):
                // Bottom edge 12 pt above the safe area; `left` values are centred around 30.
                let centerX = size.width / 2 + (button.left ?? 30) - 30
                frame = CGRect(x: centerX - m.centerSize.width / 2,
                               y: size.height - safeArea.bottom - m.centerBottomGap - m.centerSize.height,
                               width: m.centerSize.width, height: m.centerSize.height)
            case (.left, true):
                // Shoulder at the zone's top-left corner.
                frame = CGRect(x: leftAnchor.minX + (button.left ?? 3), y: leftAnchor.minY + (button.top ?? -55),
                               width: m.shoulderSize.width, height: m.shoulderSize.height)
            case (.right, true):
                // Shoulder at the diamond's top-right corner.
                frame = CGRect(x: diamond.maxX - (button.right ?? 3) - m.shoulderSize.width, y: diamond.minY + (button.top ?? -45),
                               width: m.shoulderSize.width, height: m.shoulderSize.height)
            case (.left, false):
                let side = m.circleSize * m.diamondScale
                frame = CGRect(x: leftAnchor.minX + (button.left ?? 0), y: leftAnchor.minY + (button.top ?? 0), width: side, height: side)
            case (.right, false):
                // Diamond offsets scale from the box's bottom-right corner.
                let side = m.circleSize * m.diamondScale
                frame = CGRect(x: diamond.maxX - m.diamondScale * (m.diamondBox - (button.left ?? 0)),
                               y: diamond.maxY - m.diamondScale * (m.diamondBox - (button.top ?? 0)),
                               width: side, height: side)
            }
            frame = frame.integral
            let touch = button.isInert ? CGRect.null : frame.insetBy(dx: -m.buttonSlop, dy: -m.buttonSlop)
            items.append(PadGeometry.Item(button: button, frame: frame, touchRect: touch))
        }
        return PadGeometry(zoneBox: zoneBox,
                           zoneTouchRect: zoneBox.map { $0.insetBy(dx: -m.zoneSlop, dy: -m.zoneSlop) },
                           diamondBox: diamond,
                           items: items)
    }
}
