// SPDX-License-Identifier: GPL-3.0-or-later
// The on-screen controller of the native player (API.md §5, PLAN §1.1). It sits above the
// WebView, takes touches only inside its buttons and zone, and publishes the pressed RetroPad
// bits through `InputSource.snapshot(port:)`. Touches never pass through the Capacitor bridge.
#if canImport(UIKit)
import UIKit
import CoreText
import LibretroHost

public final class TouchPadView: UIView, InputSource {
    /// What a finger currently presses.
    private enum Target: Equatable {
        case button(Int)          // index into geometry.items
        case zone(PadDirection)
    }

    public private(set) var layout: PadLayout
    public private(set) var geometry: PadGeometry
    /// Light haptic tick when a finger lands on a button. Off by default.
    public var hapticsEnabled = false
    public private(set) var isPadEnabled = true

    private let maskBox = PadMask()
    private var active: [Int: Target] = [:]          // touch key -> target
    private var lastLayoutSize = CGSize.zero
    private let haptic = UIImpactFeedbackGenerator(style: .light)

    private var buttonLayers: [CAShapeLayer] = []
    private var labelLayers: [CATextLayer] = []
    private let zoneRing = CAShapeLayer()
    private let zoneCross = CAShapeLayer()
    private let zoneKnob = CAShapeLayer()

    private static let idleFill = UIColor(white: 1, alpha: 0.08).cgColor
    private static let pressedFill = UIColor(white: 1, alpha: 0.3).cgColor
    private static let border = UIColor(white: 1, alpha: 0.35).cgColor
    private static let text = UIColor(white: 1, alpha: 0.75).cgColor

    public init(layout: PadLayout = .empty, frame: CGRect = .zero) {
        self.layout = layout
        self.geometry = layout.geometry(for: frame.size)
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isMultipleTouchEnabled = true
        buildLayers()
    }

    @available(*, unavailable)
    public required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    // MARK: InputSource

    /// Core thread, once per retro_run. Reads the aligned mask without locking.
    nonisolated public func snapshot(port: Int) -> InputSnapshot {
        port == 0 ? InputSnapshot(buttons: maskBox.value) : InputSnapshot()
    }

    /// The pressed bits, same value `snapshot(port: 0)` returns.
    public var pressedMask: UInt16 { maskBox.value }

    // MARK: Public controls

    /// Replaces the layout (new game); releases everything first.
    public func setLayout(_ newLayout: PadLayout) {
        releaseAll()
        layout = newLayout
        buildLayers()
        setNeedsLayout()
        layoutIfNeeded()
    }

    /// Hiding releases every pressed button (an HTML panel is about to cover the pad).
    public func setVisible(_ visible: Bool) {
        isHidden = !visible
        if !visible { releaseAll() }
    }

    /// Disabling releases every pressed button and ignores touches until enabled again.
    public func setEnabled(_ enabled: Bool) {
        isPadEnabled = enabled
        if !enabled { releaseAll() }
    }

    public func releaseAll() {
        active.removeAll()
        recompute()
    }

    /// True when a touch at `point` would press a button or land on the zone.
    public func hasTouchTarget(at point: CGPoint) -> Bool {
        target(at: point) != nil
    }

    // MARK: Touch handling (the touch entry points are public so tests can drive them)

    public func touchBegan(id: Int, at point: CGPoint) {
        guard isPadEnabled, !isHidden, let found = target(at: point) else { return }
        active[id] = found
        if hapticsEnabled, case .button = found { haptic.impactOccurred() }
        recompute()
    }

    public func touchMoved(id: Int, to point: CGPoint) {
        guard let before = active[id] else { return }
        let after = target(at: point)
        guard after != before else { return }
        active[id] = after // nil: the finger slid off, the button is released
        if hapticsEnabled, case .button? = after { haptic.impactOccurred() }
        recompute()
    }

    public func touchEnded(id: Int) {
        guard active.removeValue(forKey: id) != nil else { return }
        recompute()
    }

    private static func key(_ touch: UITouch) -> Int { Int(bitPattern: ObjectIdentifier(touch)) }

    public override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchBegan(id: TouchPadView.key(touch), at: touch.location(in: self)) }
    }

    public override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchMoved(id: TouchPadView.key(touch), to: touch.location(in: self)) }
    }

    public override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchEnded(id: TouchPadView.key(touch)) }
    }

    public override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        for touch in touches { touchEnded(id: TouchPadView.key(touch)) }
    }

    /// Only the buttons and the zone (+30 pt) take touches; everything else falls through to the
    /// WebView underneath (the menu button, panels).
    public override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard isPadEnabled, !isHidden, alpha > 0.01, isUserInteractionEnabled else { return nil }
        return target(at: point) != nil ? self : nil
    }

    // MARK: Hit testing and input mask

    private func target(at point: CGPoint) -> Target? {
        var best: (index: Int, distance: CGFloat)?
        for (index, item) in geometry.items.enumerated() where item.touchRect.contains(point) {
            let distance = hypot(point.x - item.frame.midX, point.y - item.frame.midY)
            if best == nil || distance < best!.distance { best = (index, distance) }
        }
        if let best = best { return .button(best.index) }
        if layout.zone != nil, let box = geometry.zoneBox, let touch = geometry.zoneTouchRect, touch.contains(point) {
            return .zone(PadMath.direction(dx: point.x - box.midX, dy: point.y - box.midY, radius: box.width / 2))
        }
        return nil
    }

    private func recompute() {
        var mask: UInt16 = 0
        for target in active.values {
            switch target {
            case .button(let index):
                if geometry.items.indices.contains(index) { mask |= geometry.items[index].button.mask }
            case .zone(let direction):
                mask |= layout.zone?.mask(for: direction) ?? 0
            }
        }
        maskBox.value = mask
        refreshVisuals()
    }

    // MARK: Drawing

    private func buildLayers() {
        for layer in buttonLayers { layer.removeFromSuperlayer() }
        buttonLayers.removeAll()
        labelLayers.removeAll()
        for layer in [zoneRing, zoneCross, zoneKnob] { layer.removeFromSuperlayer() }

        if layout.zone != nil {
            zoneRing.fillColor = UIColor.clear.cgColor
            zoneRing.strokeColor = UIColor.white.cgColor
            zoneRing.lineWidth = 2
            zoneCross.fillColor = UIColor.clear.cgColor
            zoneCross.strokeColor = UIColor.white.cgColor
            zoneCross.lineWidth = 2
            zoneKnob.fillColor = UIColor.white.cgColor
            zoneKnob.strokeColor = UIColor.clear.cgColor
            for layer in [zoneRing, zoneCross, zoneKnob] {
                layer.opacity = 0.45 // the d-pad is drawn at 45 % opacity
                self.layer.addSublayer(layer)
            }
        }
        for item in geometry.items {
            let shape = CAShapeLayer()
            shape.fillColor = TouchPadView.idleFill
            shape.strokeColor = TouchPadView.border
            shape.lineWidth = 1.5
            shape.opacity = item.button.isInert ? 0.4 : 1 // blank buttons: 40 %
            let label = CATextLayer()
            label.alignmentMode = .center
            label.foregroundColor = TouchPadView.text
            label.string = item.button.text
            shape.addSublayer(label)
            self.layer.addSublayer(shape)
            buttonLayers.append(shape)
            labelLayers.append(label)
        }
        applyGeometry()
    }

    public override func layoutSubviews() {
        super.layoutSubviews()
        let insets = safeAreaInsets
        geometry = layout.geometry(for: bounds.size,
                                   safeArea: PadInsets(top: insets.top, left: insets.left, bottom: insets.bottom, right: insets.right))
        if bounds.size != lastLayoutSize {
            // A rotation moves every control under the fingers: let go of everything.
            lastLayoutSize = bounds.size
            releaseAll()
        }
        applyGeometry()
    }

    public override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    private func applyGeometry() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let scale = max(traitCollection.displayScale, 1)
        for (index, item) in geometry.items.enumerated() where buttonLayers.indices.contains(index) {
            let shape = buttonLayers[index]
            let label = labelLayers[index]
            shape.frame = item.frame
            let local = CGRect(origin: .zero, size: item.frame.size)
            let path = item.isPill
                ? UIBezierPath(roundedRect: local, cornerRadius: local.height / 2)
                : UIBezierPath(ovalIn: local)
            shape.path = path.cgPath
            let size = item.button.fontSize ?? 16
            let height = ceil(size * 1.25)
            label.frame = CGRect(x: 0, y: (local.height - height) / 2, width: local.width, height: height)
            label.fontSize = size
            label.font = CTFontCreateUIFontForLanguage(.emphasizedSystem, size, nil)
                ?? CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
            label.contentsScale = scale
        }
        if let box = geometry.zoneBox {
            zoneRing.frame = box
            zoneCross.frame = box
            zoneKnob.frame = box
            let local = CGRect(origin: .zero, size: box.size)
            zoneRing.path = UIBezierPath(ovalIn: local.insetBy(dx: 1, dy: 1)).cgPath
            let c = CGPoint(x: local.midX, y: local.midY)
            let arm = box.width * 0.34
            let cross = UIBezierPath()
            cross.move(to: CGPoint(x: c.x - arm, y: c.y))
            cross.addLine(to: CGPoint(x: c.x + arm, y: c.y))
            cross.move(to: CGPoint(x: c.x, y: c.y - arm))
            cross.addLine(to: CGPoint(x: c.x, y: c.y + arm))
            zoneCross.path = cross.cgPath
        }
        CATransaction.commit()
        refreshVisuals()
    }

    private func refreshVisuals() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        var pressed = Set<Int>()
        var direction: PadDirection = []
        for target in active.values {
            switch target {
            case .button(let index): pressed.insert(index)
            case .zone(let d): direction.formUnion(d)
            }
        }
        for (index, shape) in buttonLayers.enumerated() {
            shape.fillColor = pressed.contains(index) ? TouchPadView.pressedFill : TouchPadView.idleFill
        }
        if let box = geometry.zoneBox {
            var dx: CGFloat = 0
            var dy: CGFloat = 0
            if direction.contains(.left) { dx -= 1 }
            if direction.contains(.right) { dx += 1 }
            if direction.contains(.up) { dy -= 1 }
            if direction.contains(.down) { dy += 1 }
            let length = hypot(dx, dy)
            if length > 0 { dx /= length; dy /= length }
            let reach = box.width * 0.2
            let knob: CGFloat = 22
            let local = CGRect(x: box.width / 2 + dx * reach - knob, y: box.height / 2 + dy * reach - knob, width: knob * 2, height: knob * 2)
            zoneKnob.path = UIBezierPath(ovalIn: local).cgPath
        }
        CATransaction.commit()
    }
}
#endif
