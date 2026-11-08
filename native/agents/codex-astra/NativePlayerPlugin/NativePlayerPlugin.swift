import Foundation
import Capacitor
import LibretroHost

@objc(NativePlayerPlugin)
public class NativePlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlayerPlugin"
    public let jsName = "NativePlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasRom", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listStates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStateBase64", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadStateBase64", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPadVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPadEnabled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScaling", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOption", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStatsVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStats", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteGame", returnType: CAPPluginReturnPromise)
    ]

    private struct CoreEntry: Decodable {
        let systems: [String]
        let framework: String
        let version: String
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        guard let system = call.getString("system"),
              let url = Bundle.module.url(forResource: "cores-manifest", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let manifest = try? JSONDecoder().decode([String: CoreEntry].self, from: data),
              let entry = manifest.sorted(by: { $0.key < $1.key }).first(where: { $0.value.systems.contains(system) }),
              CoreLocator.isLoadable(entry.value.framework) else {
            call.resolve(["available": false, "containers": []])
            return
        }
        call.resolve(["available": true, "core": entry.key,
                      "version": entry.value.version, "containers": ["zip"]])
    }

    // WP2 replaces these stubs when session/view lifecycle support lands.
    @objc func hasRom(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func start(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func pause(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func resume(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func reset(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func stop(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func saveState(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func loadState(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func listStates(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func getStateBase64(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func loadStateBase64(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func setPadVisible(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func setPadEnabled(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func setScaling(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func setOption(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func setStatsVisible(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func getStats(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
    @objc func deleteGame(_ call: CAPPluginCall) { call.reject("Native player is unavailable", "unavailable") }
}
