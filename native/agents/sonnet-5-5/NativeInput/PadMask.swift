// SPDX-License-Identifier: GPL-3.0-or-later
import Foundation

/// The 16-bit input mask shared between the main thread (writer) and the core thread (reader).
/// It lives in one aligned heap word: aligned 16-bit loads and stores are single-copy atomic on
/// arm64 (API.md §6), so the core thread never needs a lock. No other packages are involved.
final class PadMask: @unchecked Sendable {
    private let storage: UnsafeMutablePointer<UInt16>

    init() {
        storage = UnsafeMutablePointer<UInt16>.allocate(capacity: 1)
        storage.initialize(to: 0)
    }

    deinit {
        storage.deallocate()
    }

    var value: UInt16 {
        get { storage.pointee }
        set { storage.pointee = newValue }
    }
}
