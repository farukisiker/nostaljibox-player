// SPDX-License-Identifier: GPL-3.0-or-later
// Game controllers (MFi / Xbox / PlayStation / Siri Remote) as an InputSource (API.md §6).
#if canImport(GameController)
import Foundation
import GameController
import LibretroHost

/// Plain snapshot of a controller's controls; the mapping to RetroPad bits works on this, so it
/// can be tested without a `GCController`.
public struct GamepadState: Equatable {
    public var a = false, b = false, x = false, y = false
    public var leftShoulder = false, rightShoulder = false
    public var leftTrigger = false, rightTrigger = false
    public var menu = false, options = false
    /// Axes in -1...1, +y is up (GameController's convention).
    public var dpadX: Float = 0, dpadY: Float = 0
    public var stickX: Float = 0, stickY: Float = 0
    public init() {}
}

public final class GamepadInput: InputSource {
    /// Stick and d-pad axis value beyond which a direction counts as pressed.
    public static let axisThreshold: Float = 0.5

    /// Called on the main queue when the first controller connects or the last one leaves.
    /// The plugin hides the touch pad while a controller is connected.
    public var onConnectionChange: ((_ connected: Bool, _ name: String?) -> Void)?
    public private(set) var isConnected = false

    private let mask = PadMask()
    private var perController: [ObjectIdentifier: UInt16] = [:]
    private var attached: [ObjectIdentifier: GCController] = [:]
    private var observers: [NSObjectProtocol] = []
    private let center: NotificationCenter

    public init(notificationCenter: NotificationCenter = .default) {
        center = notificationCenter
        let connect = notificationCenter.addObserver(forName: .GCControllerDidConnect, object: nil, queue: .main) { [weak self] note in
            if let controller = note.object as? GCController { self?.attach(controller) }
        }
        let disconnect = notificationCenter.addObserver(forName: .GCControllerDidDisconnect, object: nil, queue: .main) { [weak self] note in
            if let controller = note.object as? GCController { self?.detach(controller) }
        }
        observers = [connect, disconnect]
        for controller in GCController.controllers() { attach(controller, notify: false) }
        isConnected = !attached.isEmpty
    }

    deinit {
        for observer in observers { center.removeObserver(observer) }
    }

    // MARK: InputSource

    /// Core thread, once per retro_run.
    public func snapshot(port: Int) -> InputSnapshot {
        port == 0 ? InputSnapshot(buttons: mask.value) : InputSnapshot()
    }

    /// Lets go of every button (the plugin calls this when the session pauses or stops).
    public func releaseAll() {
        perController.removeAll()
        mask.value = 0
    }

    // MARK: Mapping

    /// A→8 B→0 X→9 Y→1, shoulders→10/11, triggers→12/13, menu→3 (start), options→2 (select),
    /// d-pad and left stick as the d-pad (up 4, down 5, left 6, right 7).
    public static func mask(for state: GamepadState, threshold: Float = GamepadInput.axisThreshold) -> UInt16 {
        var bits: UInt16 = 0
        func set(_ id: Int, _ on: Bool) { if on { bits |= RetroPad.bit(id) } }
        set(RetroPad.a, state.a)
        set(RetroPad.b, state.b)
        set(RetroPad.x, state.x)
        set(RetroPad.y, state.y)
        set(RetroPad.l, state.leftShoulder)
        set(RetroPad.r, state.rightShoulder)
        set(RetroPad.l2, state.leftTrigger)
        set(RetroPad.r2, state.rightTrigger)
        set(RetroPad.start, state.menu)
        set(RetroPad.select, state.options)
        set(RetroPad.up, state.dpadY > threshold || state.stickY > threshold)
        set(RetroPad.down, state.dpadY < -threshold || state.stickY < -threshold)
        set(RetroPad.left, state.dpadX < -threshold || state.stickX < -threshold)
        set(RetroPad.right, state.dpadX > threshold || state.stickX > threshold)
        return bits
    }

    // MARK: Controllers

    private func attach(_ controller: GCController, notify: Bool = true) {
        let key = ObjectIdentifier(controller)
        attached[key] = controller
        if let pad = controller.extendedGamepad {
            pad.valueChangedHandler = { [weak self] gamepad, _ in
                var state = GamepadState()
                state.a = gamepad.buttonA.isPressed
                state.b = gamepad.buttonB.isPressed
                state.x = gamepad.buttonX.isPressed
                state.y = gamepad.buttonY.isPressed
                state.leftShoulder = gamepad.leftShoulder.isPressed
                state.rightShoulder = gamepad.rightShoulder.isPressed
                state.leftTrigger = gamepad.leftTrigger.isPressed
                state.rightTrigger = gamepad.rightTrigger.isPressed
                state.menu = gamepad.buttonMenu.isPressed
                state.options = gamepad.buttonOptions?.isPressed ?? false
                state.dpadX = gamepad.dpad.xAxis.value
                state.dpadY = gamepad.dpad.yAxis.value
                state.stickX = gamepad.leftThumbstick.xAxis.value
                state.stickY = gamepad.leftThumbstick.yAxis.value
                self?.update(key, state)
            }
        } else if let pad = controller.microGamepad {
            // Siri Remote: A (select) → 8, X (play/pause) → 9, menu → start, touch surface as d-pad.
            pad.reportsAbsoluteDpadValues = false
            pad.valueChangedHandler = { [weak self] gamepad, _ in
                var state = GamepadState()
                state.a = gamepad.buttonA.isPressed
                state.x = gamepad.buttonX.isPressed
                state.menu = gamepad.buttonMenu.isPressed
                state.dpadX = gamepad.dpad.xAxis.value
                state.dpadY = gamepad.dpad.yAxis.value
                self?.update(key, state)
            }
        }
        if notify { refreshConnection(name: controller.vendorName) }
    }

    private func detach(_ controller: GCController) {
        let key = ObjectIdentifier(controller)
        attached.removeValue(forKey: key)
        perController.removeValue(forKey: key) // its buttons are released
        publish()
        refreshConnection(name: controller.vendorName)
    }

    private func update(_ key: ObjectIdentifier, _ state: GamepadState) {
        perController[key] = GamepadInput.mask(for: state)
        publish()
    }

    private func publish() {
        mask.value = perController.values.reduce(UInt16(0)) { $0 | $1 }
    }

    private func refreshConnection(name: String?) {
        let now = !attached.isEmpty
        guard now != isConnected else { return }
        isConnected = now
        onConnectionChange?(now, name)
    }
}

#endif
