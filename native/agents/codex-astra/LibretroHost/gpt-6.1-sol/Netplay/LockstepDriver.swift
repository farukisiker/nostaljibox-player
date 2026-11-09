import Foundation

public struct LockstepConfiguration {
    public let role: Int, epoch: Int, applied: [UInt16], delay: Int, batch: Int, checkEvery: Int
    public init(role: Int, epoch: Int, applied: [UInt16], delay: Int = 4, batch: Int = 2,
                checkEvery: Int = 300) throws {
        guard (0...1).contains(role), epoch >= 0, epoch < Int.max, applied.count == 2,
              (1...10).contains(delay), (1...delay).contains(batch), checkEvery >= 60 else {
            throw SessionError(code: "internal", message: "invalid lockstep params")
        }
        self.role = role; self.epoch = epoch; self.applied = applied
        self.delay = delay; self.batch = batch; self.checkEvery = checkEvery
    }
}

/// Core-thread-only state machine. Frame and packet windows are bounded even for malformed peers.
struct LockstepDriver {
    private(set) var configuration: LockstepConfiguration?
    private(set) var hold = false
    private(set) var frame = 0
    private(set) var waits = 0
    private(set) var desyncs = 0
    private var desyncFrames = Set<Int>()
    private(set) var waiting = false
    private var waitingSince: TimeInterval?
    private var local: [Int: UInt16] = [:]
    private var remote: [Int: UInt16] = [:]
    private var future: [Int: UInt16] = [:]
    private var futureEpoch: Int?
    private var batchFrom = 0
    private var batchMasks: [UInt16] = []
    private let window = 4096
    var active: Bool { configuration != nil }
    var mayPrefill: Bool { !hold && !active }
    var epoch: Int { configuration?.epoch ?? 0 }

    mutating func setHold(_ value: Bool) { hold = value }
    mutating func start(_ config: LockstepConfiguration) {
        configuration = config; frame = 0; waits = 0; desyncs = 0; desyncFrames.removeAll()
        waiting = false; waitingSince = nil
        local.removeAll(); remote = futureEpoch == config.epoch ? future : [:]
        future.removeAll(); futureEpoch = nil; batchMasks.removeAll(); batchFrom = config.delay
    }
    mutating func stop() {
        self = LockstepDriver() // also releases a pre-driver hold and pending packets
    }
    mutating func push(epoch incoming: Int, from: Int, masks: [UInt16]) {
        guard incoming >= 0, from >= 0, !masks.isEmpty, masks.count <= 1024,
              from <= Int.max - masks.count else { return }
        if incoming == epoch, active {
            for (offset, mask) in masks.enumerated() {
                let target = from + offset
                if target >= frame, target - frame < window { remote[target] = mask }
            }
        } else if epoch < Int.max, incoming == epoch + 1 {
            if futureEpoch != incoming { future.removeAll(); futureEpoch = incoming }
            for (offset, mask) in masks.enumerated() {
                let target = from + offset
                if target < window { future[target] = mask }
            }
        }
    }
    private mutating func flush(_ emit: (String, [String: Any]) -> Void) {
        guard !batchMasks.isEmpty else { return }
        emit("lockstepInputs", ["epoch": epoch, "from": batchFrom, "masks": batchMasks.map(Int.init)])
        batchMasks.removeAll(keepingCapacity: true)
    }
    private func state(_ value: Bool, emit: (String, [String: Any]) -> Void) {
        emit("lockstepState", ["waiting": value, "frame": frame, "waits": waits, "desyncs": desyncs])
    }
    /// JS compares peer hashes; only reports for already simulated frames of this epoch count.
    mutating func noteDesync(epoch incoming: Int, frame reported: Int,
                             emit: (String, [String: Any]) -> Void) {
        guard active, incoming == epoch, reported > 0, reported <= frame,
              let config = configuration, reported % config.checkEvery == 0,
              desyncFrames.insert(reported).inserted else { return }
        desyncs += 1
        state(waiting, emit: emit)
    }
    /// Returns actual runs, permitting the session to account for partial ticks accurately.
    mutating func advance(count: Int, producing: Bool, now: TimeInterval,
                          sample: () -> UInt16, run: (UInt16, UInt16) -> Void,
                          checksum: () -> String, emit: (String, [String: Any]) -> Void) -> Int {
        guard producing, !hold, let config = configuration else { return 0 }
        var ran = 0
        for _ in 0..<max(0, min(2, count)) {
            guard frame <= Int.max - config.delay - 1 else { break }
            let own: UInt16, other: UInt16
            if frame < config.delay {
                own = config.applied[config.role]; other = config.applied[1 - config.role]
            } else if let l = local[frame], let r = remote[frame] { own = l; other = r }
            else {
                if waitingSince == nil { waitingSince = now; waits += 1 }
                flush(emit)
                break
            }
            if waitingSince != nil {
                waitingSince = nil
                if waiting { waiting = false; state(false, emit: emit) }
            }
            run(config.role == 0 ? own : other, config.role == 0 ? other : own)
            let target = frame + config.delay
            let mask = sample()
            local[target] = mask
            if batchMasks.isEmpty { batchFrom = target }
            batchMasks.append(mask)
            local.removeValue(forKey: frame); remote.removeValue(forKey: frame)
            frame += 1; ran += 1
            if batchMasks.count >= config.batch { flush(emit) }
            if frame % config.checkEvery == 0 {
                emit("lockstepChecksum", ["epoch": config.epoch, "frame": frame, "hash": checksum()])
            }
        }
        if let since = waitingSince, !waiting, now - since >= 1.5 {
            waiting = true; state(true, emit: emit)
        }
        return ran
    }
    var stalled: Bool { waitingSince != nil }
}
