import UIKit
import MetalKit

/// Video-only layer placed below Capacitor's web view. UIKit construction/layout stays on main.
public final class NativePlayerView: UIView {
    public let metalView: MTKView

    public override init(frame: CGRect) {
        metalView = MTKView(frame: .zero, device: MTLCreateSystemDefaultDevice())
        super.init(frame: frame)
        backgroundColor = .black
        isUserInteractionEnabled = false
        metalView.isPaused = true
        metalView.enableSetNeedsDisplay = false
        metalView.autoResizeDrawable = true
        metalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(metalView)
    }

    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    public override func layoutSubviews() {
        super.layoutSubviews()
        metalView.frame = bounds
        let scale = window?.screen.scale ?? traitCollection.displayScale
        metalView.drawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    }

    public override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }
}
