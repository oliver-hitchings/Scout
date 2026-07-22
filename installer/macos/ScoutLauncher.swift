import AppKit
import Darwin
import Foundation

@main
final class ScoutLauncher: NSObject, NSApplicationDelegate {
    private let dashboardURL = URL(string: "http://127.0.0.1:8459/")!
    private var server: Process?
    private var statusItem: NSStatusItem?
    private var quitting = false

    private lazy var workspaceURL: URL = {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--workspace"), arguments.indices.contains(index + 1) {
            return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
        }
        if let configured = ProcessInfo.processInfo.environment["SCOUT_WORKSPACE"], !configured.isEmpty {
            return URL(fileURLWithPath: configured, isDirectory: true)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Documents/Scout Workspace", isDirectory: true)
    }()

    private var logURL: URL {
        workspaceURL.appendingPathComponent("logs/ui-stdout.log")
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMenus()
        startOrOpen()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openDashboard(nil)
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopOwnedServer()
    }

    private func configureMenus() {
        let main = NSMenu()
        let app = NSMenuItem()
        main.addItem(app)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Open Scout", action: #selector(openDashboard(_:)), keyEquivalent: "o")
        appMenu.addItem(withTitle: "Show diagnostic log", action: #selector(showLog(_:)), keyEquivalent: "l")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Scout", action: #selector(quitScout(_:)), keyEquivalent: "q")
        app.submenu = appMenu
        NSApp.mainMenu = main

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Scout"
        item.menu = appMenu.copy() as? NSMenu
        statusItem = item
    }

    private func startOrOpen() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.isHealthy() {
                DispatchQueue.main.async { self.openDashboard(nil) }
                return
            }
            do {
                try self.startServer()
                for _ in 0..<50 {
                    if self.isHealthy() {
                        DispatchQueue.main.async { self.openDashboard(nil) }
                        return
                    }
                    Thread.sleep(forTimeInterval: 0.3)
                }
                throw NSError(domain: "ScoutLauncher", code: 2, userInfo: [NSLocalizedDescriptionKey: "Scout did not become ready within 15 seconds."])
            } catch {
                DispatchQueue.main.async { self.showStartupFailure(error) }
            }
        }
    }

    private func isHealthy() -> Bool {
        var request = URLRequest(url: dashboardURL.appendingPathComponent("api/app-info"))
        request.timeoutInterval = 0.8
        let semaphore = DispatchSemaphore(value: 0)
        var healthy = false
        URLSession.shared.dataTask(with: request) { _, response, _ in
            healthy = (response as? HTTPURLResponse)?.statusCode == 200
            semaphore.signal()
        }.resume()
        _ = semaphore.wait(timeout: .now() + 1.0)
        return healthy
    }

    private func startServer() throws {
        guard let resources = Bundle.main.resourceURL else {
            throw NSError(domain: "ScoutLauncher", code: 3, userInfo: [NSLocalizedDescriptionKey: "Scout could not locate its application resources."])
        }
        let node = resources.appendingPathComponent("runtime/node")
        let script = resources.appendingPathComponent("app/ui/server.mjs")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: script.path) else {
            throw NSError(domain: "ScoutLauncher", code: 4, userInfo: [NSLocalizedDescriptionKey: "Scout's bundled runtime is incomplete. Reinstall Scout."])
        }
        try FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try FileHandle(forWritingTo: logURL)
        try log.seekToEnd()

        let process = Process()
        process.executableURL = node
        process.arguments = [script.path]
        var environment = ProcessInfo.processInfo.environment
        environment["SCOUT_WORKSPACE"] = workspaceURL.path
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        environment["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.npm-global/bin", environment["PATH"] ?? ""].joined(separator: ":")
        process.environment = environment
        process.standardOutput = log
        process.standardError = log
        process.terminationHandler = { [weak self] task in
            guard let self, !self.quitting, task.terminationStatus != 0 else { return }
            DispatchQueue.main.async {
                self.showStartupFailure(NSError(domain: "ScoutLauncher", code: Int(task.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "Scout's local server stopped unexpectedly."]))
            }
        }
        try process.run()
        server = process
    }

    @objc private func openDashboard(_ sender: Any?) {
        if isHealthy() { NSWorkspace.shared.open(dashboardURL) }
        else if server?.isRunning != true { startOrOpen() }
    }

    @objc private func showLog(_ sender: Any?) {
        if FileManager.default.fileExists(atPath: logURL.path) { NSWorkspace.shared.activateFileViewerSelecting([logURL]) }
        else { NSWorkspace.shared.activateFileViewerSelecting([workspaceURL]) }
    }

    private func showStartupFailure(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = "Scout could not open"
        alert.informativeText = "\(error.localizedDescription)\n\nDiagnostic log: \(logURL.path)"
        alert.addButton(withTitle: "Show log")
        alert.addButton(withTitle: "Close")
        if alert.runModal() == .alertFirstButtonReturn { showLog(nil) }
    }

    private func stopOwnedServer() {
        guard let server, server.isRunning else { return }
        server.terminate()
        let pid = server.processIdentifier
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if server.isRunning { Darwin.kill(pid, SIGKILL) }
        }
    }

    @objc private func quitScout(_ sender: Any?) {
        quitting = true
        stopOwnedServer()
        NSApp.terminate(nil)
    }
}
