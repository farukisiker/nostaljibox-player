import Foundation
import UIKit
import WebKit
import Capacitor
import LibretroHost
#if canImport(NativeInput)
import NativeInput
#endif
#if canImport(NativeSaves)
import NativeSaves
#endif
#if canImport(NativeZip)
import NativeZip
#endif

@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = ["isAvailable", "hasRom", "start", "stop", "pause", "resume", "reset", "saveState", "loadState", "listStates", "getStateBase64", "loadStateBase64", "setPadVisible", "setPadEnabled", "setScaling", "setOption", "setStatsVisible", "getStats", "deleteGame"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
    private struct CoreEntry: Decodable { let systems: [String]
        let framework: String
        let version: String }
    private struct Failure: Error { let code: String
        let message: String }
    private let io = DispatchQueue(label: "native.player.files")
    private var storage: SaveStoring?
    private var session: EmulatorSession?
    private var webOpaque = true
    private var scrollOpaque = true
    private var statsOverlay: StatsOverlay?
    private var requestedPadVisible = true
    private var webBackground: UIColor?
    private var scrollBackground: UIColor?
    private var underPageBackground: UIColor?
    /// The video view sandwiched below the web view (PLAN §1.1); nil when nothing is installed.
    private var root: UIView?
    private var observation: NSKeyValueObservation?
    private var observers: [NSObjectProtocol] = []
    private var operations: [(@escaping () -> Void) -> Void] = []
    private var busy = false
    #if canImport(NativeInput)
    private var pad: TouchPadView?
    private var gamepad: GamepadInput?
    #endif
    private func enqueue(_ operation: @escaping (@escaping () -> Void) -> Void) {
        DispatchQueue.main.async { self.operations.append(operation)
            self.next() }
    }
    private func next() {
        guard !busy, !operations.isEmpty else { return }
        busy = true
        let operation = operations.removeFirst()
        operation { [weak self] in self?.busy = false
            self?.next() }
    }
    private func store() throws -> SaveStoring {
        if let storage = storage { return storage }
        #if canImport(NativeSaves)
        let result: SaveStoring = try SaveStore()
        #else
        let result: SaveStoring = try FallbackSaveStore()
        #endif
        storage = result
        return result
    }
    private func manifest() -> [String: CoreEntry] {
        guard let url = Bundle.module.url(forResource: "cores-manifest", withExtension: "json"), let data = try? Data(contentsOf: url), let entries = try? JSONDecoder().decode([String: CoreEntry].self, from: data) else { return [:] }
        return entries
    }
    private func valid(_ value: String) -> Bool { !value.isEmpty && value != "." && value != ".." && value.count <= 255 && !value.hasPrefix(".") && !value.contains("/") && !value.contains("\\") && !value.contains(":") && !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }
    private func validHash(_ hash: String) -> Bool { hash.count == 16 && hash.allSatisfy { "0123456789abcdef".contains($0) } }
    private func fnv(_ data: Data) -> String { var hash: UInt64 = 14695981039346656037
        for byte in data { hash = (hash ^ UInt64(byte)) &* 1099511628211 }
        return String(format: "%016llx", hash) }
    private var containers: [String] {
        #if canImport(NativeZip)
        return ["zip"]
        #else
        return []
        #endif
    }
    @objc func isAvailable(_ call: CAPPluginCall) {
        let system = call.getString("system") ?? ""
        let entries = manifest()
        let types = containers
        io.async { if let item = entries.sorted(by: { $0.key < $1.key }).first(where: { $0.value.systems.contains(system) }), CoreLocator.isLoadable(item.value.framework) { call.resolve(["available": true, "core": item.key, "version": item.value.version, "containers": types]) } else { call.resolve(["available": false, "containers": types]) } }
    }
    @objc func hasRom(_ call: CAPPluginCall) {
        guard let id = call.getString("gameId"), valid(id), let size = call.getInt("size"), size >= 0, let hash = call.getString("hash"), validHash(hash) else { call.resolve(["cached": false])
            return }
        io.async { let cached = (try? self.store().hasRom(gameId: id, size: size, hash: hash)) ?? false
            call.resolve(["cached": cached]) }
    }
    /// Validation/argument failures before a session began only reject (API.md: "reject + error
    /// event" is for a start that tore down a running session; the session itself emits that).
    private func fail(_ call: CAPPluginCall, _ code: String, _ message: String) { call.reject(message, code) }
    @objc func start(_ call: CAPPluginCall) {

        let base64 = call.getString("romBase64")
        let layout = call.getArray("pad") ?? []
        let scaling = call.getString("scaling") ?? "fit"
        let showPad = call.getBool("showPad") ?? true
        let showStats = call.getBool("showStats") ?? false
        enqueue { done in
            self.stopCurrent(reason: "user") { _ in
                guard let id = call.getString("gameId"), self.valid(id), let hash = call.getString("hash"), self.validHash(hash), let rawName = call.getString("romName"), let system = call.getString("system"), let coreName = call.getString("core"), let entry = self.manifest()[coreName], entry.systems.contains(system), let coreURL = CoreLocator.url(for: entry.framework) else { self.fail(call, "core-load", "Invalid game or unavailable core")
                    done()
                    return }
                let name = (rawName.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
                guard self.valid(name) else { self.fail(call, "rom-rejected", "Invalid ROM filename")
                    done()
                    return }
                self.io.async {
                    do {
                        let storage = try self.store()
                        let romURL: URL
                        if let base64 = base64 {
                            guard let raw = Data(base64Encoded: base64), self.fnv(raw) == hash else { throw Failure(code: "rom-rejected", message: "ROM data or hash is invalid") }
                            var bytes = raw
                            var filename = name
                            if raw.starts(with: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || raw.starts(with: [0x52, 0x61, 0x72, 0x21]) || raw.starts(with: [0x1f, 0x8b]) {
                                throw Failure(code: "unsupported-archive", message: "Archive format is unsupported")
                            }
                            if raw.starts(with: [0x50, 0x4b, 0x05, 0x06]) || raw.starts(with: [0x50, 0x4b, 0x07, 0x08]) {
                                throw Failure(code: "unsupported-archive", message: "Empty or spanned ZIP is unsupported")
                            }
                            if raw.starts(with: [0x50, 0x4b, 0x03, 0x04]) {
                                #if canImport(NativeZip)
                                do { let extracted = try ZipExtractor.extractRom(from: raw, preferredName: name, romExtensions: ZipExtractor.defaultRomExtensions)
                                    filename = (extracted.name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
                                    bytes = extracted.data } catch { throw Failure(code: "unsupported-archive", message: "Cannot extract ROM archive") }
                                #else
                                throw Failure(code: "unsupported-archive", message: "ZIP support is unavailable")
                                #endif
                            }
                            guard self.valid(filename) else { throw Failure(code: "rom-rejected", message: "Invalid ROM filename") }
                            #if canImport(NativeSaves)
                            romURL = try (storage as! SaveStore).storeRom(gameId: id, romName: filename, data: bytes, hash: hash, sourceSize: raw.count)
                            #else
                            romURL = try (storage as! FallbackSaveStore).storeRom(gameId: id, romName: filename, data: bytes, hash: hash, sourceSize: raw.count)
                            #endif
                        } else {
                            let candidate = storage.romURL(gameId: id, romName: name)
                            let metaURL = candidate.deletingLastPathComponent().appendingPathComponent(".meta.json")
                            guard let metaData = try? Data(contentsOf: metaURL), let meta = (try? JSONSerialization.jsonObject(with: metaData)) as? [String: Any], let cachedName = meta["name"] as? String, self.valid(cachedName), let sourceSize = meta["sourceSize"] as? Int, storage.hasRom(gameId: id, size: sourceSize, hash: hash) else { throw Failure(code: "rom-missing", message: "Cached ROM is missing") }
                            romURL = storage.romURL(gameId: id, romName: cachedName)
                        }
                        DispatchQueue.main.async {
                            do {
                                let (renderer, input) = try self.install(layout: layout, visible: showPad)
                                renderer.setScaling(scaling)
                                self.statsOverlay?.isHidden = !showStats
                                let session = EmulatorSession()
                                self.session = session
                                session.onEvent = { [weak self, weak session] event, payload in
                                    guard let self = self, let session = session, self.session === session else { return }
                                    self.notifyListeners(event, data: payload)
                                    if event == "stats" { self.statsOverlay?.update(stats: payload) }
                                    if event == "stopped", payload["reason"] as? String == "error" {
                                        self.enqueue { done in
                                            guard self.session === session else { done()
                                                return }
                                            self.stopCurrent(reason: "error") { _ in done() }
                                        }
                                    }
                                }
                                session.setScaling(scaling)
                                session.setStatsVisible(showStats)
                                session.setPauseReason("background", active: UIApplication.shared.applicationState != .active)
                                session.start(coreURL: coreURL, romURL: romURL, romHash: hash, gameId: id, storage: storage, input: input, renderer: renderer) { result in
                                    switch result {
                                        case .success(let info): call.resolve(info)
                                        case .failure(let error): self.stopCurrent(reason: "error") { _ in let e = error as? SessionError
                                            call.reject(e?.message ?? error.localizedDescription, e?.code ?? "internal")
                                            done() }
                                        return
                                    }
                                    done()
                                }
                            } catch { self.restore()
                                self.fail(call, "internal", error.localizedDescription)
                                done() }
                        }
                    } catch { DispatchQueue.main.async { let e = error as? Failure
                            self.fail(call, e?.code ?? "internal", e?.message ?? error.localizedDescription)
                            done() } }
                }
            }
        }
    }
    private func install(layout: [Any], visible: Bool) throws -> (MetalRenderer, InputSource?) {
        // Sandwich inside the web view's own superview (the UIWindow: CAPBridgeViewController.loadView
        // makes the WKWebView the root view). controller.view is never reassigned: its setter only
        // re-points the controller and would leave the window empty.
        guard let web = bridge?.webView, let host = web.superview else { throw Failure(code: "internal", message: "Web view unavailable") }
        let video = NativePlayerView(frame: web.frame)
        video.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        let renderer = try MetalRenderer(view: video.metalView)
        webOpaque = web.isOpaque
        scrollOpaque = web.scrollView.isOpaque
        webBackground = web.backgroundColor
        scrollBackground = web.scrollView.backgroundColor
        underPageBackground = web.underPageBackgroundColor
        host.insertSubview(video, belowSubview: web)
        web.scrollView.isOpaque = false
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.underPageBackgroundColor = .clear
        root = video
        var input: InputSource?
        #if canImport(NativeInput)
        requestedPadVisible = visible
        let touch = TouchPadView(layout: (try? PadLayout(json: layout)) ?? .empty, frame: web.frame)
        touch.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        touch.setVisible(visible)
        host.insertSubview(touch, aboveSubview: web)
        pad = touch
        let controllerInput = GamepadInput()
        gamepad = controllerInput
        touch.setVisible(visible && !controllerInput.isConnected)
        controllerInput.onConnectionChange = { [weak self] connected, name in self?.pad?.setVisible((self?.requestedPadVisible ?? false) && !connected)
            var payload: [String: Any] = ["connected": connected]
            if let name = name { payload["name"] = name }
            self?.notifyListeners("controllerChanged", data: payload) }
        input = InputMixer([touch, controllerInput])
        #endif
        let overlay = StatsOverlay(frame: .zero)
        overlay.isHidden = true
        overlay.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(overlay)
        NSLayoutConstraint.activate([
        overlay.leadingAnchor.constraint(equalTo: web.safeAreaLayoutGuide.leadingAnchor, constant: 12),
        overlay.topAnchor.constraint(equalTo: web.safeAreaLayoutGuide.topAnchor, constant: 12)
        ])
        statsOverlay = overlay
        let center = NotificationCenter.default
        // Control Center, the notification shade and an incoming-call banner only resign active;
        // they pause the core under the same "background" reason as a real background transition.
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.releaseInput()
            self?.session?.setPauseReason("background", active: true) })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.session?.setPauseReason("background", active: false) })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.releaseInput()
            self?.session?.setPauseReason("background", active: true) })
        observers.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.session?.setPauseReason("background", active: false) })
        observers.append(center.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in _ = self?.session?.flushSRAM() })
        observation = web.observe(\.url, options: [.new]) { [weak self, weak video] view, _ in
            guard let self = self, let video = video, let url = view.url, url.lastPathComponent != "play.html" else { return }
            self.enqueue { done in
                guard self.root === video else { done()
                    return }
                self.stopCurrent(reason: "navigation") { _ in done() }
            }
        }
        return (renderer, input)
    }
    private func restore() {
        observation?.invalidate()
        observation = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        #if canImport(NativeInput)
        pad?.releaseAll()
        gamepad?.releaseAll()
        pad?.removeFromSuperview()
        pad = nil
        gamepad = nil
        #endif
        if root != nil, let web = bridge?.webView { web.isOpaque = webOpaque
            web.scrollView.isOpaque = scrollOpaque
            web.backgroundColor = webBackground
            web.scrollView.backgroundColor = scrollBackground
            web.underPageBackgroundColor = underPageBackground }
        statsOverlay?.removeFromSuperview()
        statsOverlay = nil
        root?.removeFromSuperview()
        root = nil
    }
    private func releaseInput() {
        #if canImport(NativeInput)
        pad?.releaseAll()
        gamepad?.releaseAll()
        #endif
    }
    private func stopCurrent(reason: String, completion: @escaping (Bool) -> Void) {
        guard let current = session else { restore()
            completion(false)
            return }
        #if canImport(NativeInput)
        pad?.releaseAll()
        gamepad?.releaseAll()
        #endif
        current.stop(reason: reason) { saved in self.session = nil
            self.restore()
            completion(saved) }
    }
    @objc func stop(_ call: CAPPluginCall) { enqueue { done in self.stopCurrent(reason: "user") { saved in call.resolve(["sramSaved": saved])
                done() } } }
    private func withSession(_ call: CAPPluginCall, _ body: @escaping (EmulatorSession, @escaping () -> Void) -> Void) { enqueue { done in guard let session = self.session else { call.reject("No active session", "no-session")
                done()
                return }
            body(session, done) } }
    @objc func pause(_ call: CAPPluginCall) { withSession(call) { session, done in self.releaseInput()
            session.pause { call.resolve()
                done() } } }
    @objc func resume(_ call: CAPPluginCall) { withSession(call) { session, done in session.resume { call.resolve()
                done() } } }
    @objc func reset(_ call: CAPPluginCall) { withSession(call) { session, done in session.reset { call.resolve()
                done() } } }
    @objc func setPadVisible(_ call: CAPPluginCall) { withSession(call) { _, done in
            #if canImport(NativeInput)
            self.requestedPadVisible = call.getBool("visible") ?? true
            self.pad?.setVisible(self.requestedPadVisible && !(self.gamepad?.isConnected ?? false))
            #endif
            call.resolve()
            done() } }
    @objc func setPadEnabled(_ call: CAPPluginCall) { withSession(call) { _, done in
            #if canImport(NativeInput)
            self.pad?.setEnabled(call.getBool("enabled") ?? true)
            #endif
            call.resolve()
            done() } }
    @objc func setScaling(_ call: CAPPluginCall) { withSession(call) { session, done in session.setScaling(call.getString("mode") ?? "fit")
            call.resolve()
            done() } }
    @objc func setStatsVisible(_ call: CAPPluginCall) { withSession(call) { session, done in let visible = call.getBool("visible") ?? false
            self.statsOverlay?.isHidden = !visible
            session.setStatsVisible(visible)
            call.resolve()
            done() } }
    @objc func getStats(_ call: CAPPluginCall) { withSession(call) { session, done in session.getStats { stats in call.resolve(stats)
                done() } } }
    @objc func setOption(_ call: CAPPluginCall) { withSession(call) { session, done in guard let key = call.getString("key"), let value = call.getString("value") else { call.reject("Missing option", "internal")
                done()
                return }
            session.setOption(key: key, value: value) { ok in if ok { call.resolve() } else { call.reject("Invalid option", "internal") }
                done() } } }
    @objc func deleteGame(_ call: CAPPluginCall) { guard let id = call.getString("gameId"), valid(id) else { call.reject("Invalid game ID", "internal")
            return }
        io.async { do { let bytes = try self.store().deleteGame(gameId: id)
                call.resolve(["removedBytes": bytes]) } catch { call.reject(error.localizedDescription, "internal") } } }
    private func rejectStateError(_ call: CAPPluginCall, _ error: Error) {
        let failure = error as? SessionError
        call.reject(failure?.message ?? error.localizedDescription, failure?.code ?? "internal")
    }
    @objc func saveState(_ call: CAPPluginCall) { withSession(call) { session, done in
        guard let slot = call.getInt("slot"), (1...3).contains(slot) else { call.reject("Invalid state slot", "internal"); done(); return }
        session.saveState(slot: slot) { result in
            switch result {
            case .success(let payload): call.resolve(payload)
            case .failure(let error): self.rejectStateError(call, error)
            }
            done()
        }
    } }
    @objc func loadState(_ call: CAPPluginCall) { withSession(call) { session, done in
        guard let slot = call.getInt("slot"), (1...3).contains(slot) else { call.reject("Invalid state slot", "internal"); done(); return }
        session.loadState(slot: slot) { result in
            switch result {
            case .success: call.resolve()
            case .failure(let error): self.rejectStateError(call, error)
            }
            done()
        }
    } }
    @objc func listStates(_ call: CAPPluginCall) { withSession(call) { session, done in
        session.listStates { result in
            switch result {
            case .success(let states): call.resolve(["states": states])
            case .failure(let error): self.rejectStateError(call, error)
            }
            done()
        }
    } }
    @objc func getStateBase64(_ call: CAPPluginCall) { withSession(call) { session, done in
        session.serializeState { result in
            switch result {
            case .success(let data): call.resolve(["data": data.base64EncodedString()])
            case .failure(let error): self.rejectStateError(call, error)
            }
            done()
        }
    } }
    @objc func loadStateBase64(_ call: CAPPluginCall) { withSession(call) { session, done in
        guard let encoded = call.getString("data"), let data = Data(base64Encoded: encoded), !data.isEmpty else { call.reject("Invalid state data", "internal"); done(); return }
        session.unserializeState(data) { result in
            switch result {
            case .success: call.resolve()
            case .failure(let error): self.rejectStateError(call, error)
            }
            done()
        }
    } }
}









