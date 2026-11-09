// swift-tools-version: 5.9
//
// Link layer for the native player (owner: Claude, lead architect). Every model writes its own code
// under agents/<model>/; this manifest only wires those folders together. Who wrote what, and how to
// ask them: docs/native-player/AGENTS.md in the app repo, and agents/README.md here.
//
// A module is added only once its folder exists, so agents can land their work at different times.
// Prebuilt cores come from agents/gemini-argon/ios-cores/release.json once that agent has published
// them as a GitHub release ({"cores": {"supafaust": {"url": "...zip", "checksum": "..."}}}).
import Foundation
import PackageDescription

let root = Context.packageDirectory
func exists(_ path: String) -> Bool { FileManager.default.fileExists(atPath: root + "/" + path) }

/// Metal shader sources under a module folder (any sub-agent sub-folder), relative to that folder.
/// SwiftPM compiles them into the module's default.metallib (Bundle.module).
func metalFiles(in module: String) -> [String] {
    let base = root + "/" + module
    guard let walker = FileManager.default.enumerator(atPath: base) else { return [] }
    return walker.compactMap { $0 as? String }.filter { $0.hasSuffix(".metal") }.sorted()
}

struct CoreRelease: Decodable { let url: String; let checksum: String }
struct Release: Decodable { let cores: [String: CoreRelease] }
let releasePath = root + "/agents/gemini-argon/ios-cores/release.json"
let release = (try? Data(contentsOf: URL(fileURLWithPath: releasePath)))
    .flatMap { try? JSONDecoder().decode(Release.self, from: $0) }
let cores = (release?.cores ?? [:]).sorted { $0.key < $1.key }

var targets: [Target] = [
    // codex-astra: C bridge to the libretro API, core loader, emulation session, video, audio.
    .target(name: "LibretroC", path: "agents/codex-astra/LibretroC", publicHeadersPath: "include"),
    .target(name: "LibretroHost", dependencies: ["LibretroC"], path: "agents/codex-astra/LibretroHost",
            resources: metalFiles(in: "agents/codex-astra/LibretroHost").map { .process($0) }),
]
var pluginDeps: [Target.Dependency] = [
    "LibretroHost",
    .product(name: "Capacitor", package: "capacitor-swift-pm"),
    .product(name: "Cordova", package: "capacitor-swift-pm"),
]
// Input (touch pad + game controllers), save files, ZIP extraction: whichever agent folder holds the module.
let agentFolders = ((try? FileManager.default.contentsOfDirectory(atPath: root + "/agents")) ?? [])
    .filter { exists("agents/\($0)") && !$0.hasPrefix(".") }.sorted()
func folder(of module: String) -> String? { agentFolders.first { exists("agents/\($0)/\(module)") } }
var moduleFolder: [String: String] = [:]
for module in ["NativeInput", "NativeSaves", "NativeZip"] {
    guard let owner = folder(of: module) else { continue }
    moduleFolder[module] = owner
    targets.append(.target(name: module, dependencies: ["LibretroHost"], path: "agents/\(owner)/\(module)"))
    pluginDeps.append(.target(name: module))
}
// gemini-argon: prebuilt cores (dynamic xcframeworks, opened with dlopen by path).
for (name, core) in cores {
    targets.append(.binaryTarget(name: name, url: core.url, checksum: core.checksum))
    pluginDeps.append(.target(name: name))
}
// codex-astra: the Capacitor plugin (one @objc(NativePlayerPlugin) class). When a sub-agent of the lead
// has written a replacement plugin in a model-named sub-folder, that one is compiled and the lead's
// original stub (and its manifest) are excluded, so the file and class names stay unique.
let pluginDir = "agents/codex-astra/NativePlayerPlugin"
let pluginSubfolders = ((try? FileManager.default.contentsOfDirectory(atPath: root + "/" + pluginDir)) ?? []).sorted()
let replacement = pluginSubfolders.first { exists("\(pluginDir)/\($0)/NativePlayerPlugin.swift") }
let pluginExclude = replacement == nil ? [] : ["NativePlayerPlugin.swift", "cores-manifest.json"].filter { exists("\(pluginDir)/\($0)") }
let manifest = [replacement.map { "\($0)/cores-manifest.json" }, "cores-manifest.json"]
    .compactMap { $0 }.first { exists("\(pluginDir)/\($0)") && !pluginExclude.contains($0) }
targets.append(.target(name: "NativePlayerPlugin", dependencies: pluginDeps, path: pluginDir,
                       exclude: pluginExclude, resources: manifest.map { [.copy($0)] } ?? []))
// Tests, one target per agent folder (agents/<folder>/Tests → <Folder>Tests). Fixtures are read from
// NB_FIXTURES_DIR (agents/gemini-argon/fixtures).
for owner in agentFolders where exists("agents/\(owner)/Tests") {
    let name = owner.split(separator: "-").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined() + "Tests"
    let own: [Target.Dependency] = moduleFolder.filter { $0.value == owner }.keys.sorted().map { .target(name: $0) }
    targets.append(.testTarget(name: name, dependencies: own + ["LibretroHost"], path: "agents/\(owner)/Tests"))
}

let package = Package(
    name: "NostaljiboxNativePlayer",
    platforms: [.iOS(.v15)],
    products: [.library(name: "NostaljiboxNativePlayer", targets: ["NativePlayerPlugin"])],
    dependencies: [.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")],
    targets: targets,
    cLanguageStandard: .c11
)
