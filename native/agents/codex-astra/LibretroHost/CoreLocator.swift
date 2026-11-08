import Foundation
import Darwin

public enum CoreLocator {
    public static func url(for core: String) -> URL? {
        guard !core.isEmpty, core.unicodeScalars.allSatisfy({
            CharacterSet.alphanumerics.contains($0) || $0 == "_" || $0 == "-"
        }) else { return nil }
        var roots: [URL] = []
        if let directory = ProcessInfo.processInfo.environment["NB_CORES_DIR"] {
            roots.append(URL(fileURLWithPath: directory, isDirectory: true))
        }
        if let frameworks = Bundle.main.privateFrameworksURL { roots.append(frameworks) }
        return roots.map { $0.appendingPathComponent("\(core).framework/\(core)") }
            .first { FileManager.default.fileExists(atPath: $0.path) }
    }

    // isAvailable must probe without initializing or replacing the active C session.
    public static func isLoadable(_ core: String) -> Bool {
        guard let url = url(for: core) else { return false }
        return (try? CoreHandles.open(url)) != nil
    }
}

enum CoreHandles {
    private static let lock = NSLock()
    private static var handles: [String: UnsafeMutableRawPointer] = [:]
    static func open(_ url: URL) throws -> UnsafeMutableRawPointer {
        lock.lock()
        defer { lock.unlock() }
        let path = url.standardizedFileURL.resolvingSymlinksInPath().path
        if let cached = handles[path] { return cached }
        guard let handle = dlopen(path, RTLD_NOW | RTLD_LOCAL) else {
            let message = dlerror().map { String(cString: $0) } ?? "dlopen failed"
            throw LibretroCoreError.coreLoad(message)
        }
        // Intentionally kept for process lifetime, even if symbol validation later fails.
        handles[path] = handle
        return handle
    }
}
