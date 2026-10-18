// Own one fresh TextEdit process and one private document. The helper never
// reuses an existing process or activates an application or window.
import AppKit
import ApplicationServices
import Darwin

private struct Birth: Equatable {
  let seconds: UInt64
  let microseconds: UInt64
  var json: [String: Any] { ["seconds": seconds, "microseconds": microseconds] }
}
private func birth(_ pid: pid_t) -> Birth? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
    info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
  return Birth(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
private func foreground() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication, let identity = birth(app.processIdentifier) else { return [:] }
  return ["pid": Int(app.processIdentifier), "birth": identity.json]
}
private enum WindowOrder {
  private typealias Connection = @convention(c) () -> Int32
  private typealias Query = @convention(c) (Int32, UInt32, UnsafeMutablePointer<UInt8>) -> Int32
  private static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL)
  static func ordered(_ id: CGWindowID) -> Bool? {
    guard let library, let connectionSymbol = dlsym(library, "SLSMainConnectionID"),
      let querySymbol = dlsym(library, "SLSWindowIsOrderedIn") else { return nil }
    let connection = unsafeBitCast(connectionSymbol, to: Connection.self)()
    let query = unsafeBitCast(querySymbol, to: Query.self)
    var result: UInt8 = 0
    guard query(connection, id, &result) == 0, result <= 1 else { return nil }
    return result != 0
  }
}

private final class Owner: NSObject, NSApplicationDelegate {
  let directory: URL
  let document: URL
  let receipt: URL
  let bundle = URL(fileURLWithPath: "/System/Applications/TextEdit.app").resolvingSymlinksInPath()
  var app: NSRunningApplication?
  var identity: Birth?
  var launchObservation: NSKeyValueObservation?
  var signals: [DispatchSourceSignal] = []
  var events: [[String: Any]] = []
  var stopping = false
  var ready = false
  var windowID: CGWindowID?
  var nativeOrders: [[String: Any]] = []
  var foregroundObserver: NSObjectProtocol?
  var terminationObserver: NSObjectProtocol?
  init(directory: URL) {
    self.directory = directory.resolvingSymlinksInPath()
    document = self.directory.appendingPathComponent("Private Glide Qualification.txt")
    receipt = self.directory.appendingPathComponent("events")
  }
  func owned() -> Bool {
    guard let app, let identity, !app.isTerminated, birth(app.processIdentifier) == identity,
      NSRunningApplication(processIdentifier: app.processIdentifier)?.bundleURL?.resolvingSymlinksInPath() == bundle else { return false }
    return true
  }
  func record(_ kind: String, windows: [CGWindowID] = []) {
    guard events.count < 128 else { stop(); return }
    if kind == "probe", let app, let windowID {
      guard let current = ownWindows(app), current.count == 1,
        (current[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value == windowID else {
        record("probe window ownership refused"); stop(); return
      }
    }
    let point = NSEvent.mouseLocation
    events.append(["kind": kind, "sequence": events.count, "foreground": foreground(), "pointer": ["x": point.x, "y": point.y], "pid": app.map { Int($0.processIdentifier) } ?? 0, "birth": identity?.json ?? [:], "windows": windows, "nativeOrders": nativeOrders])
    do { try JSONSerialization.data(withJSONObject: events, options: [.sortedKeys]).write(to: receipt, options: .atomic) }
    catch { stop() }
  }
  func stop() {
    guard !stopping else { return }
    stopping = true
    guard owned(), let app else { exit(0) }
    // Force only our exact fresh generation. Ordinary terminate could display
    // an unsaved-document prompt after the intentional private edit.
    if owned() { app.forceTerminate() }
  }
  func inspectOwnedWindow() {
    guard !ready, owned(), let app, let ownWindows = ownWindows(app) else { return }
    guard ownWindows.count <= 1 else { record("unexpected own windows"); stop(); return }
    let windows = ownWindows.compactMap { value -> CGWindowID? in
      guard let number = value[kCGWindowNumber as String] as? NSNumber,
        let raw = value[kCGWindowBounds as String] as? [String: Any], let rectangle = CGRect(dictionaryRepresentation: raw as CFDictionary),
        rectangle.width > 100, rectangle.height > 100 else { return nil }
      return number.uint32Value
    }
    guard windows.count == 1 else { return }
    ready = true; windowID = windows[0]
    record("ready", windows: windows)
  }
  func ownWindows(_ app: NSRunningApplication) -> [[String: Any]]? {
    guard let values = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]], values.count <= 4096 else { return nil }
    var unknown = false
    nativeOrders = []
    let result = values.filter { value in
      guard (value[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
        (value[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
        (value[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1 > 0,
        let raw = value[kCGWindowBounds as String] as? [String: Any], let rectangle = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
      guard rectangle.width > 1, rectangle.height > 1, let id = value[kCGWindowNumber as String] as? NSNumber else { return false }
      guard let ordered = WindowOrder.ordered(id.uint32Value) else { unknown = true; return false }
      nativeOrders.append(["id": id.uint32Value, "orderedIn": ordered])
      // Exclude only records proven unordered by WindowServer. Unknown order
      // or any additional ordered document/window refuses the binding.
      return ordered
    }
    return unknown ? nil : result
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    try? FileHandle.standardError.write(contentsOf: Data("textedit.owner.preflight\n".utf8))
    guard !foreground().isEmpty,
      document.deletingLastPathComponent() == directory,
      FileManager.default.fileExists(atPath: document.path),
      ProcessInfo.processInfo.environment["HOME"].map({ URL(fileURLWithPath: $0).resolvingSymlinksInPath() }) == directory,
      ProcessInfo.processInfo.environment["CFFIXED_USER_HOME"].map({ URL(fileURLWithPath: $0).resolvingSymlinksInPath() }) == directory else { exit(1) }
    record("initial")
    guard !NSWorkspace.shared.runningApplications.contains(where: { $0.bundleIdentifier == "com.apple.TextEdit" }) else {
      record("existing TextEdit prevents this private launch qualification"); exit(1)
    }
    try? FileHandle.standardError.write(contentsOf: Data("textedit.owner.open\n".utf8))
    for signalNumber in [SIGTERM, SIGINT] {
      signal(signalNumber, SIG_IGN)
      let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
      source.setEventHandler { self.stop() }; source.resume(); signals.append(source)
    }
    foregroundObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in self.record("foreground changed") }
    terminationObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { notification in
      if let value = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, value.processIdentifier == self.app?.processIdentifier { exit(0) }
    }
    DispatchQueue.global().async {
      var buffered = Data()
      while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { DispatchQueue.main.async { self.stop() }; return }
        buffered.append(chunk)
        guard buffered.count <= 1024 else { DispatchQueue.main.async { self.stop() }; return }
        while let end = buffered.firstIndex(of: 10) {
          let command = String(data: buffered.prefix(upTo: end), encoding: .utf8)
          buffered.removeSubrange(...end)
          DispatchQueue.main.async {
            if command == "probe", self.owned() { self.record("probe") }
            else if let command, command.hasPrefix("bind "), self.owned(),
              let id = UInt32(command.dropFirst(5)), id > 0, let app = self.app,
              let windows = self.ownWindows(app), windows.count == 1,
              (windows[0][kCGWindowNumber as String] as? NSNumber)?.uint32Value == id {
              self.windowID = id; self.record("bound", windows: [id])
            }
            else { self.stop() }
          }
        }
      }
    }
    let previous = Set(NSWorkspace.shared.runningApplications.map(\.processIdentifier))
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    configuration.promptsUserIfNeeded = false
    configuration.environment = ProcessInfo.processInfo.environment
    // AppKit documents this test-only argument as ignoring existing restorable
    // state/untitled documents and redirecting new restoration state to temp:
    // https://developer.apple.com/library/archive/releasenotes/AppKit/RN-AppKitOlderNotes/#10_7_Notes
    configuration.arguments = ["-ApplePersistenceIgnoreState", "YES"]
    NSWorkspace.shared.open([document], withApplicationAt: bundle, configuration: configuration) { app, error in
      DispatchQueue.main.async {
        try? FileHandle.standardError.write(contentsOf: Data("textedit.owner.opened status=\((error as NSError?)?.code ?? 0) app=\(app != nil)\n".utf8))
        guard let app, !previous.contains(app.processIdentifier),
          app.bundleURL?.resolvingSymlinksInPath() == self.bundle, let identity = birth(app.processIdentifier) else { exit(1) }
        self.app = app; self.identity = identity
        guard error == nil else { self.record("private document open refused"); self.stop(); return }
        if self.stopping { self.stopping = false; self.stop(); return }
        // NSWorkspace's completion may precede application launch completion.
        // Observe that exact owned process's actual launch receipt, without
        // polling or requiring a second ephemeral executable's AX grant.
        self.launchObservation = app.observe(\.isFinishedLaunching, options: [.initial, .new]) { app, _ in
          DispatchQueue.main.async {
            guard self.owned(), app.isFinishedLaunching else { return }
            self.inspectOwnedWindow()
            if !self.ready { self.ready = true; self.record("ready") }
          }
        }
      }
    }
  }
}

guard CommandLine.arguments.count == 2 else { exit(1) }
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
private let owner = Owner(directory: URL(fileURLWithPath: CommandLine.arguments[1]))
application.delegate = owner
application.run()
