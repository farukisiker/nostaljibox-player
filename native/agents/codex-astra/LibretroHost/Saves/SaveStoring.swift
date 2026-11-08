import Foundation

public protocol SaveStoring: AnyObject {
    func romURL(gameId: String, romName: String) -> URL          // roms/<gameId>/<romName>
    func hasRom(gameId: String, size: Int, hash: String) -> Bool
    func storeRom(gameId: String, romName: String, data: Data, hash: String) throws -> URL
    func loadSRAM(romHash: String) -> Data?
    func saveSRAM(_ data: Data, romHash: String) throws
    func stateURL(gameId: String, slot: Int) -> URL
    func listStates(gameId: String) -> [(slot: Int, mtime: Date)]
    func deleteGame(gameId: String) throws -> Int                // removed bytes
    var systemDirectory: URL { get }
    var saveDirectory: URL { get }
}
