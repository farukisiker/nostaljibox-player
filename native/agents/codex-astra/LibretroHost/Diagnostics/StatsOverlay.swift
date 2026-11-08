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
        accessibilityIdentifier = "native-player-stats"
        update(fps: 0, footprintMB: 0)
    }

    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    public func update(fps: Double, footprintMB: Double) {
        text = String(format: "%.1f fps  %.0f MB", fps, footprintMB)
        accessibilityLabel = text
        invalidateIntrinsicContentSize()
    }

    public override var intrinsicContentSize: CGSize {
        let size = super.intrinsicContentSize
        return CGSize(width: size.width + 12, height: size.height + 8)
    }

    public override func drawText(in rect: CGRect) {
        super.drawText(in: rect.insetBy(dx: 6, dy: 4))
    }
}
