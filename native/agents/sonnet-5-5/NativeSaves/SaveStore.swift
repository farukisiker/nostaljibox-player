// SPDX-License-Identifier: GPL-3.0-or-later
// ROMs, battery saves and save states of the native player (API.md §6, §7; PLAN §1.6).
//
//   <root>/roms/<gameId>/<romName>      excluded from iCloud backup (can be rebuilt from the library)
//   <root>/roms/<gameId>/.meta.json     {"name","size","sourceSize","hash"} for hasRom
//   <root>/saves/<romHash>.srm          backed up; kept when a game is deleted, keyed by ROM hash
//   <root>/states/<gameId>.<slot>.state excluded from backup
//   <root>/system/                      the core's system directory
//
// <root> is `Library/Application Support/NostaljiBox` unless a test injects another URL.
import Foundation
import LibretroHost

public final class SaveStore: SaveStoring {
    public let rootURL: URL
    public let systemDirectory: URL
    public let saveDirectory: URL
    public let romsDirectory: URL
    public let statesDirectory: URL

    private let fileManager: FileManager

    private struct Meta: Codable {
        var name: String
        var size: Int
        var sourceSize: Int
        var hash: String
    }

    public init(rootURL: URL? = nil, fileManager: FileManager = .default) throws {
        let root = try rootURL ?? fileManager
            .url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("NostaljiBox", isDirectory: true)
        self.fileManager = fileManager
        self.rootURL = root
        romsDirectory = root.appendingPathComponent("roms", isDirectory: true)
        saveDirectory = root.appendingPathComponent("saves", isDirectory: true)
        statesDirectory = root.appendingPathComponent("states", isDirectory: true)
        systemDirectory = root.appendingPathComponent("system", isDirectory: true)
        for directory in [romsDirectory, saveDirectory, statesDirectory, systemDirectory] {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        // ROMs and states can be rebuilt (the library keeps the ROM), saves cannot.
        for directory in [romsDirectory, statesDirectory] {
            try SaveStore.excludeFromBackup(directory)
        }
    }

    // MARK: ROMs

    public func romURL(gameId: String, romName: String) -> URL {
        gameDirectory(gameId).appendingPathComponent(SaveStore.sanitize(romName), isDirectory: false)
    }

    public func hasRom(gameId: String, size: Int, hash: String) -> Bool {
        guard let meta = readMeta(gameId), meta.hash == hash else { return false }
        guard size == meta.size || size == meta.sourceSize else { return false }
        let file = romURL(gameId: gameId, romName: meta.name)
        return fileSize(file) == meta.size
    }

    @discardableResult
    public func storeRom(gameId: String, romName: String, data: Data, hash: String) throws -> URL {
        try storeRom(gameId: gameId, romName: romName, data: data, hash: hash, sourceSize: nil)
    }

    /// Like the protocol method; `sourceSize` is the byte count JS knows the ROM by (the raw zip)
    /// when `data` is the extracted inner ROM, so `hasRom({ size })` still matches. A game keeps
    /// one ROM: older files in its folder are replaced.
    @discardableResult
    public func storeRom(gameId: String, romName: String, data: Data, hash: String, sourceSize: Int?) throws -> URL {
        let directory = gameDirectory(gameId)
        if fileManager.fileExists(atPath: directory.path) { try fileManager.removeItem(at: directory) }
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = SaveStore.sanitize(romName)
        let url = directory.appendingPathComponent(name, isDirectory: false)
        try data.write(to: url, options: .atomic)
        let meta = Meta(name: name, size: data.count, sourceSize: sourceSize ?? data.count, hash: hash)
        try JSONEncoder().encode(meta).write(to: metaURL(gameId), options: .atomic)
        return url
    }

    // MARK: SRAM

    public func loadSRAM(romHash: String) -> Data? {
        try? Data(contentsOf: sramURL(romHash))
    }

    public func saveSRAM(_ data: Data, romHash: String) throws {
        try fileManager.createDirectory(at: saveDirectory, withIntermediateDirectories: true)
        try data.write(to: sramURL(romHash), options: .atomic)
    }

    // MARK: States

    public func stateURL(gameId: String, slot: Int) -> URL {
        statesDirectory.appendingPathComponent("\(SaveStore.sanitize(gameId)).\(slot).state", isDirectory: false)
    }

    public func listStates(gameId: String) -> [(slot: Int, mtime: Date)] {
        stateFiles(gameId).compactMap { entry -> (slot: Int, mtime: Date)? in
            guard let date = (try? entry.url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate else {
                return nil
            }
            return (slot: entry.slot, mtime: date)
        }
        .sorted { $0.slot < $1.slot }
    }

    // MARK: Delete

    /// Removes `roms/<gameId>/` and `states/<gameId>.*`; SRAM stays. Returns the bytes freed.
    public func deleteGame(gameId: String) throws -> Int {
        var removed = 0
        let directory = gameDirectory(gameId)
        if fileManager.fileExists(atPath: directory.path) {
            removed += treeSize(directory)
            try fileManager.removeItem(at: directory)
        }
        for entry in stateFiles(gameId) {
            removed += fileSize(entry.url) ?? 0
            try fileManager.removeItem(at: entry.url)
        }
        return removed
    }

    // MARK: Helpers

    /// One path component: directories and "..", Windows separators and empty names are neutralised.
    static func sanitize(_ name: String) -> String {
        let last = (name.replacingOccurrences(of: "\\", with: "/") as NSString).lastPathComponent
        let cleaned = last.replacingOccurrences(of: ":", with: "_")
        return (cleaned.isEmpty || cleaned == "." || cleaned == "..") ? "_" : cleaned
    }

    private static func excludeFromBackup(_ directory: URL) throws {
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
    }

    private func gameDirectory(_ gameId: String) -> URL {
        romsDirectory.appendingPathComponent(SaveStore.sanitize(gameId), isDirectory: true)
    }

    private func metaURL(_ gameId: String) -> URL {
        gameDirectory(gameId).appendingPathComponent(".meta.json", isDirectory: false)
    }

    private func readMeta(_ gameId: String) -> Meta? {
        guard let data = try? Data(contentsOf: metaURL(gameId)) else { return nil }
        return try? JSONDecoder().decode(Meta.self, from: data)
    }

    private func sramURL(_ romHash: String) -> URL {
        saveDirectory.appendingPathComponent("\(SaveStore.sanitize(romHash)).srm", isDirectory: false)
    }

    /// `states/<gameId>.<slot>.state` entries of one game; the slot must be digits, so a game id
    /// that is a prefix of another ("g1" and "g1.5") never picks up the other's files.
    private func stateFiles(_ gameId: String) -> [(url: URL, slot: Int)] {
        let prefix = SaveStore.sanitize(gameId) + "."
        let names = (try? fileManager.contentsOfDirectory(atPath: statesDirectory.path)) ?? []
        var found: [(url: URL, slot: Int)] = []
        for name in names where name.hasPrefix(prefix) && name.hasSuffix(".state") {
            let middle = name.dropFirst(prefix.count).dropLast(".state".count)
            if let slot = Int(middle), !middle.isEmpty, middle.allSatisfy({ $0.isASCII && $0.isNumber }) {
                found.append((url: statesDirectory.appendingPathComponent(name), slot: slot))
            }
        }
        return found
    }

    private func fileSize(_ url: URL) -> Int? {
        guard let attributes = try? fileManager.attributesOfItem(atPath: url.path) else { return nil }
        return (attributes[.size] as? NSNumber)?.intValue
    }

    private func treeSize(_ directory: URL) -> Int {
        guard let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: nil) else { return 0 }
        var total = 0
        for case let url as URL in enumerator { total += fileSize(url) ?? 0 }
        return total
    }
}
