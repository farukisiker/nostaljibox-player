import Foundation
import QuartzCore

/// Pure timing policy, independent of display hardware.
struct FrameDebt {
    var fps: Double = 60
    private var previous: Double?
    private var debt = 0.0
    init(fps: Double = 60) { self.fps = fps }
    mutating func reset() { previous = nil; debt = 0 }
    mutating func frames(at timestamp: Double) -> Int {
        guard let last = previous else { previous = timestamp; return 0 }
        previous = timestamp
        let elapsed = timestamp - last
        guard elapsed.isFinite, elapsed >= 0, elapsed <= 0.25 else { debt = 0; return 0 }
        debt = min(2, debt + elapsed * fps)
        let count = min(2, Int(debt + 0.000001))
        debt = max(0, debt - Double(count))
        return count
    }
}

/// Install, pause and destroy only on the owning core RunLoop.
final class FrameClock: NSObject {
    private var link: CADisplayLink?
    private var debt: FrameDebt
    private let tick: (Int) -> Void
    init(fps: Double, tick: @escaping (Int) -> Void) {
        debt = FrameDebt(fps: fps); self.tick = tick
        super.init()
    }
    func start() {
        debt.reset()
        if link == nil {
            let display = CADisplayLink(target: self, selector: #selector(fired(_:)))
            display.add(to: .current, forMode: .default)
            link = display
        }
        link?.isPaused = false
    }
    /// Drop accumulated catch-up after a lockstep wait; call on the owning core RunLoop.
    func resetDebt() { debt.reset() }
    func pause() { link?.isPaused = true; debt.reset() }
    func stop() { link?.invalidate(); link = nil; debt.reset() }
    @objc private func fired(_ display: CADisplayLink) { tick(debt.frames(at: display.timestamp)) }
}

/// Each lifecycle source owns only its own reason. Explicit resume also clears route loss.
struct PauseCoordinator {
    private(set) var reasons = Set<String>()
    private(set) var active = false
    var running: Bool { active && reasons.isEmpty }
    mutating func set(_ reason: String, active: Bool) {
        if active { reasons.insert(reason) } else { reasons.remove(reason) }
    }
    mutating func resume() { reasons.remove("user"); reasons.remove("route") }
    mutating func begin() { active = true }
    mutating func end() { active = false; reasons.removeAll() }
    func reconcile(currentlyRunning: Bool, start: () throws -> Void, pause: () -> Void) rethrows -> Bool {
        if running && !currentlyRunning { try start() }
        if !running && currentlyRunning { pause() }
        return running
    }
}
