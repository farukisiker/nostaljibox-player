import UIKit
import MetalKit

/// Video-only layer placed below Capacitor's web view. UIKit construction/layout stays on main.
/// The drawable is sized here (main thread) and published to the renderer through the MTKView
/// delegate, so the core thread never reads UIKit geometry.
public final class NativePlayerView: UIView {
    public let metalView: MTKView

    public override init(frame: CGRect) {
        metalView = MTKView(frame: CGRect(origin: .zero, size: frame.size), device: MTLCreateSystemDefaultDevice())
        super.init(frame: frame)
        backgroundColor = .black
        isUserInteractionEnabled = false
        metalView.isPaused = true
        metalView.enableSetNeedsDisplay = false
        metalView.autoResizeDrawable = false
        metalView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(metalView)
        updateDrawableSize()
    }

    public required init?(coder: NSCoder) { fatalError("Use init(frame:)") }

    public override func layoutSubviews() {
        super.layoutSubviews()
        metalView.frame = bounds
        updateDrawableSize()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        setNeedsLayout()
    }

    public override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        setNeedsLayout()
    }

    private func updateDrawableSize() {
        let scale = window?.screen.scale ?? traitCollection.displayScale
        if scale > 0 { metalView.contentScaleFactor = scale }
        let size = CGSize(width: floor(bounds.width * metalView.contentScaleFactor),
                          height: floor(bounds.height * metalView.contentScaleFactor))
        // Setting drawableSize notifies the delegate (mtkView(_:drawableSizeWillChange:)).
        if metalView.drawableSize != size { metalView.drawableSize = size }
    }
}
