// Opt-in OpenAI integration fixture. Only this fresh app and its private
// receipt file are used; no user documents, account or global settings.
import AppKit
import Darwin

private struct Birth: Equatable {
  let seconds: UInt64
  let microseconds: UInt64
}
private func birth(_ pid: pid_t) -> Birth? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
    info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
  return Birth(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
private func writeJSON(_ value: Any, _ path: String) {
  do { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic) }
  catch { exit(1) }
}

// The owner retains this exact Launch Services instance and kernel birth. EOF
// retires only that instance; the app itself observes the owner's native exit.
private final class LaunchOwner: NSObject, NSApplicationDelegate {
  let bundle: URL
  let receipt: String
  var owned: NSRunningApplication?
  var ownedBirth: Birth?
  var stopping = false
  var retiringOwned = false
  var termination: NSObjectProtocol?
  var signals: [DispatchSourceSignal] = []
  init(bundle: URL, receipt: String) { self.bundle = bundle.resolvingSymlinksInPath(); self.receipt = receipt }
  func isOwned(_ app: NSRunningApplication) -> Bool {
    guard !app.isTerminated, let original = ownedBirth,
      birth(app.processIdentifier) == original,
      let current = NSRunningApplication(processIdentifier: app.processIdentifier) else { return false }
    return current.bundleURL?.resolvingSymlinksInPath().path == bundle.path
  }
  func stop() {
    stopping = true
    guard let owned else { return }
    guard isOwned(owned) else { exit(0) }
    guard !retiringOwned else { return }
    retiringOwned = true
    owned.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if self.isOwned(owned) { owned.forceTerminate() }
    }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    guard CGSessionCopyCurrentDictionary() != nil, let identity = birth(getpid()) else { exit(1) }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
    for value in [SIGTERM, SIGINT] {
      let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
      source.setEventHandler { self.stop() }; source.resume(); signals.append(source)
    }
    termination = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { _ in
      if let app = self.owned, !self.isOwned(app) { exit(0) }
    }
    DispatchQueue.global().async {
      _ = FileHandle.standardInput.readDataToEndOfFile()
      DispatchQueue.main.async { self.stop() }
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment
    configuration.arguments = [receipt, String(getpid()), String(identity.seconds), String(identity.microseconds)]
    NSWorkspace.shared.openApplication(at: bundle, configuration: configuration) { app, error in
      DispatchQueue.main.async {
        guard error == nil, let app, app.bundleURL?.resolvingSymlinksInPath().path == self.bundle.path,
          let identity = birth(app.processIdentifier) else { exit(1) }
        self.owned = app; self.ownedBirth = identity
        if self.stopping { self.stop() }
      }
    }
  }
}

private final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  let receipt: String
  let field = NSTextField(string: "initial")
  let status = NSTextField(labelWithString: "waiting")
  var window: NSWindow!
  var events: [[String: Any]] = []
  var ownerExit: DispatchSourceProcess?
  var readyObserver: NSObjectProtocol?
  var readyPublished = false
  init(receipt: String) { self.receipt = receipt }
  func record(_ kind: String) {
    guard events.count < 128 else { exit(1) }
    events.append([
      "kind": kind, "field": field.stringValue, "status": status.stringValue,
      "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid(),
      "visibility": ["visible": window.isVisible, "onActiveSpace": window.isOnActiveSpace,
        "occluded": !window.occlusionState.contains(.visible), "hidden": NSApplication.shared.isHidden,
        "minimized": window.isMiniaturized],
    ])
    writeJSON(events, receipt)
  }
  func controlTextDidChange(_ notification: Notification) { record("field changed") }
  @objc func apply() { status.stringValue = "applied: " + field.stringValue; record("applied") }
  func applicationDidFinishLaunching(_ notification: Notification) {
    guard CommandLine.arguments.count == 5, let pid = pid_t(CommandLine.arguments[2]),
      let seconds = UInt64(CommandLine.arguments[3]), let microseconds = UInt64(CommandLine.arguments[4]) else { exit(1) }
    let identity = Birth(seconds: seconds, microseconds: microseconds)
    guard birth(pid) == identity else { exit(0) }
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    source.setEventHandler { exit(0) }; source.resume(); ownerExit = source
    guard birth(pid) == identity else { exit(0) }
    let menu = NSMenu(), edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "Edit")
    submenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    submenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    submenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = submenu; menu.addItem(edit); NSApplication.shared.mainMenu = menu
    let panel = NSPanel(contentRect: NSRect(x: 100, y: 100, width: 560, height: 260), styleMask: [.titled, .closable, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.hidesOnDeactivate = false
    window = panel
    window.title = "Cafe OpenAI Computer Qualification"
    window.isReleasedWhenClosed = false
    // This disposable window joins the current Space without changing the
    // selected Space, raising another app or activating itself. Off-Space
    // capture is not part of this installed OpenAI interface's qualification.
    window.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .fullScreenAuxiliary]
    window.level = .floating
    field.frame = NSRect(x: 30, y: 200, width: 500, height: 30)
    field.setAccessibilityIdentifier("background-field")
    field.setAccessibilityLabel("Background input")
    field.delegate = self
    status.frame = NSRect(x: 30, y: 60, width: 500, height: 60)
    status.setAccessibilityIdentifier("background-status")
    let button = NSButton(title: "Apply background fixture", target: self, action: #selector(apply))
    button.frame = NSRect(x: 30, y: 150, width: 250, height: 30)
    window.contentView!.addSubview(field); window.contentView!.addSubview(button); window.contentView!.addSubview(status)
    window.orderFrontRegardless()
    window.displayIfNeeded()
    record("window created")
    func publishReady() {
      guard !self.readyPublished, self.window.isOnActiveSpace,
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]],
        windows.contains(where: { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid() && ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == self.window.windowNumber }) else { return }
      self.readyPublished = true
      if let observer = self.readyObserver { NotificationCenter.default.removeObserver(observer); self.readyObserver = nil }
      self.record("ready")
    }
    readyObserver = NotificationCenter.default.addObserver(forName: NSApplication.didUpdateNotification, object: NSApplication.shared, queue: .main) { _ in publishReady() }
    DispatchQueue.main.async { publishReady() }
  }
}

guard let expected = ProcessInfo.processInfo.environment["CFFIXED_USER_HOME"],
  URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path == URL(fileURLWithPath: expected).resolvingSymlinksInPath().path,
  setenv("HOME", expected, 1) == 0 else { exit(1) }
let application = NSApplication.shared
if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--launch-owned" {
  let delegate = LaunchOwner(bundle: URL(fileURLWithPath: CommandLine.arguments[2]), receipt: CommandLine.arguments[3])
  application.setActivationPolicy(.prohibited); application.delegate = delegate; application.run()
} else {
  guard CommandLine.arguments.count == 5 else { exit(1) }
  let delegate = Fixture(receipt: CommandLine.arguments[1])
  application.setActivationPolicy(.accessory); application.delegate = delegate; application.run()
}
