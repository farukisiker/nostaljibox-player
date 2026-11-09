import UIKit

/// Small native diagnostic label; update once per second on the main thread.
public final class StatsOverlay: UILabel {
    public override init(frame: CGRect) {
        super.init(frame: frame)
        font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        textColor = .white
        backgroundColor = UIColor.black.withAlphaComponent(0.65)
        layer.cornerRadius = 5
        clipsToBounds = true
        isUserInteractionEnabled = false
        numberOfLines = 2
        accessibilityIdentifier = "native-player-stats"
        update(stats: [:])
    }

    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    /// Takes a `stats` event payload / `getStats` result (API.md §3).
    public func update(stats: [String: Any]) {
        text = Self.text(for: stats)
        accessibilityLabel = text
        invalidateIntrinsicContentSize()
    }

    public func update(fps: Double, footprintMB: Double) {
        update(stats: ["fps": fps, "footprintMB": footprintMB])
    }

    /// Line 1: "<measured>/<target> fps · core <retro_run ms> · <MB> · und <underruns>", so a PAL
    /// game (50/50) is told apart from an NTSC game running slow (50/60).
    /// Line 2: display-link tick rate on the core thread and the per-frame upload/render time.
    static func text(for stats: [String: Any]) -> String {
        func number(_ key: String) -> Double { (stats[key] as? NSNumber)?.doubleValue ?? 0 }
        let first = String(format: "%.0f/%.0f fps · core %.1f ms · %.0f MB · und %.0f",
                           number("fps"), number("targetFps"), number("coreMs"),
                           number("footprintMB"), number("audioUnderruns"))
        let second = String(format: "link %.0f Hz · upload %.2f ms", number("linkHz"), number("uploadMs"))
        return first + "\n" + second
    }

    public override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 12, height: size.height + 8)
    }

    public override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 6, dy: 4))
    }
}
