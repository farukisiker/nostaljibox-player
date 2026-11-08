public struct InputSnapshot: Equatable {
    public var buttons: UInt16          // bit n = RetroPad id n (0...13)
    public init(buttons: UInt16 = 0) { self.buttons = buttons }
}
public protocol InputSource: AnyObject {
    /// Called on the core thread once per retro_run (input_poll). Must be cheap and lock-free.
    func snapshot(port: Int) -> InputSnapshot
}
/// Merges several sources (touch pad + MFi) with bitwise OR.
public final class InputMixer: InputSource {
    private let sources: [InputSource]
    public init(_ sources: [InputSource]) { self.sources = sources }
    public func snapshot(port: Int) -> InputSnapshot {
        var buttons: UInt16 = 0
        for source in sources { buttons |= source.snapshot(port: port).buttons }
        return InputSnapshot(buttons: buttons)
    }
}
