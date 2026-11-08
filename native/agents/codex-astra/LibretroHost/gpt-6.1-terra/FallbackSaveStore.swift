import Foundation

/// Minimal persistent store used when the optional NativeSaves module is not linked.
public final class FallbackSaveStore: SaveStoring {
    private struct Meta: Codable { let name: String
        let size: Int
        let sourceSize: Int
        let hash: String }
    private let root: URL
    public let systemDirectory: URL
    public let saveDirectory: URL
    private var roms: URL { root.appendingPathComponent("roms", isDirectory: true) }
    private var states: URL { root.appendingPathComponent("states", isDirectory: true) }
    public init(rootURL: URL? = nil) throws {
        root = try rootURL ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("NostaljiBox", isDirectory: true)
        systemDirectory = root.appendingPathComponent("system", isDirectory: true)
        saveDirectory = root.appendingPathComponent("saves", isDirectory: true)
        for url in [roms, states, systemDirectory, saveDirectory] {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        for directory in [roms, states] {
            var url = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        }
    }
    private func safe(_ s: String) -> String { let x = (s.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        return x.isEmpty || x == "." || x == ".." ? "_" : x }
    private func dir(_ id: String) -> URL { roms.appendingPathComponent(safe(id), isDirectory: true) }
    public func romURL(gameId: String, romName: String) -> URL { dir(gameId).appendingPathComponent(safe(romName)) }
    public func hasRom(gameId: String, size: Int, hash: String) -> Bool {
        guard let data = try? Data(contentsOf: dir(gameId).appendingPathComponent(".meta.json")), let meta = try? JSONDecoder().decode(Meta.self, from: data), meta.hash == hash, meta.sourceSize == size, let attrs = try? FileManager.default.attributesOfItem(atPath: romURL(gameId: gameId, romName: meta.name).path), (attrs[.size] as? NSNumber)?.intValue == meta.size else { return false }
        return true
    }
    public func storeRom(gameId: String, romName: String, data: Data, hash: String) throws -> URL { try storeRom(gameId: gameId, romName: romName, data: data, hash: hash, sourceSize: data.count) }
    public func storeRom(gameId: String, romName: String, data: Data, hash: String, sourceSize: Int) throws -> URL {
        let directory = dir(gameId)
        if FileManager.default.fileExists(atPath: directory.path) { try FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = romURL(gameId: gameId, romName: romName)
        try data.write(to: url, options: .atomic)
        try JSONEncoder().encode(Meta(name: safe(romName), size: data.count, sourceSize: sourceSize, hash: hash)).write(to: directory.appendingPathComponent(".meta.json"), options: .atomic)
        return url
    }
    public func loadSRAM(romHash: String) -> Data? { try? Data(contentsOf: saveDirectory.appendingPathComponent(safe(romHash) + ".srm")) }
    public func saveSRAM(_ data: Data, romHash: String) throws { try data.write(to: saveDirectory.appendingPathComponent(safe(romHash) + ".srm"), options: .atomic) }
    public func stateURL(gameId: String, slot: Int) -> URL { states.appendingPathComponent("\(safe(gameId)).\(slot).state") }
    public func listStates(gameId: String) -> [(slot: Int, mtime: Date)] { (1...3).compactMap { slot in guard let attrs = try? FileManager.default.attributesOfItem(atPath: stateURL(gameId: gameId, slot: slot).path), let date = attrs[.modificationDate] as? Date else { return nil }
        return (slot, date) } }
    public func deleteGame(gameId: String) throws -> Int {
        let fm = FileManager.default
        var total = 0
        let directory = dir(gameId)
        if let items = fm.enumerator(at: directory, includingPropertiesForKeys: [.fileSizeKey]) { for case let url as URL in items { total += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 } }
        if fm.fileExists(atPath: directory.path) { try fm.removeItem(at: directory) }
        for entry in listStates(gameId: gameId) { let url = stateURL(gameId: gameId, slot: entry.slot)
        total += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        try fm.removeItem(at: url) }
        return total
    }
}

