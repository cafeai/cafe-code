// Synthetic native qualification app. It has no document/profile/network access.
import AppKit

// An unbundled copy owns a Launch Services-launched GUI instance. This gives the
// app normal activation rights while keeping its HOME/preferences private and
// retaining an exact process-generation fence for cleanup after parent EOF.
final class LaunchOwner: NSObject, NSApplicationDelegate {
  let bundle: URL
  let receipt: String
  var owned: NSRunningApplication?
  var launchedAt: Date?
  var stopping = false
  var termination: NSObjectProtocol?
  var signals: [DispatchSourceSignal] = []
  init(bundle: URL, receipt: String) { self.bundle = bundle.resolvingSymlinksInPath(); self.receipt = receipt }
  func isOwned(_ app: NSRunningApplication) -> Bool {
    guard !app.isTerminated, let date = launchedAt, let current = NSRunningApplication(processIdentifier: app.processIdentifier) else { return false }
    return current.launchDate == date && current.bundleURL?.resolvingSymlinksInPath() == bundle
  }
  func stop() {
    stopping = true
    guard let owned else { return }
    guard isOwned(owned) else { exit(0) }
    owned.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if self.isOwned(owned) { owned.forceTerminate() }
    }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
    for value in [SIGTERM, SIGINT] {
      let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
      source.setEventHandler { self.stop() }; source.resume(); signals.append(source)
    }
    termination = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { event in
      if let app = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication, app.processIdentifier == self.owned?.processIdentifier, app.launchDate == self.launchedAt { exit(0) }
    }
    DispatchQueue.global().async {
      _ = FileHandle.standardInput.readDataToEndOfFile()
      DispatchQueue.main.async { self.stop() }
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment
    configuration.arguments = [receipt]
    NSWorkspace.shared.openApplication(at: bundle, configuration: configuration) { app, error in
      DispatchQueue.main.async {
        guard error == nil, let app, app.bundleURL?.resolvingSymlinksInPath() == self.bundle, let date = app.launchDate else { exit(1) }
        self.owned = app; self.launchedAt = date
        if self.stopping { self.stop() }
      }
    }
  }
}

final class PointerArea: NSView {
  let status: NSTextField
  private var dragged = false
  init(status: NSTextField) { self.status = status; super.init(frame: NSRect(x: 30, y: 25, width: 500, height: 60)) }
  required init?(coder: NSCoder) { fatalError("No archived fixture views") }
  override var acceptsFirstResponder: Bool { true }
  override func mouseDown(with event: NSEvent) { dragged = false }
  override func mouseDragged(with event: NSEvent) { dragged = true; status.stringValue = "pointer dragged" }
  override func mouseUp(with event: NSEvent) { if !dragged { status.stringValue = "pointer clicked" } }
  override func scrollWheel(with event: NSEvent) { status.stringValue = event.scrollingDeltaY < 0 ? "pointer scrolled down" : "pointer scrolled up" }
}

final class Fixture: NSObject, NSApplicationDelegate {
  let field = NSTextField(string: "initial")
  let status = NSTextField(labelWithString: "waiting")
  var window: NSWindow!
  func applicationDidFinishLaunching(_ notification: Notification) {
    let menu = NSMenu()
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "Edit")
    submenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    submenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    submenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = submenu; menu.addItem(edit); NSApplication.shared.mainMenu = menu
    window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 560, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Cafe Glide Qualification"
    // This fixture qualifies the foreground backend, including when the test
    // runner's desktop is a fullscreen Space. Own the visible window context
    // explicitly rather than depending on saved per-user AppKit/Space defaults.
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    let view = window.contentView!
    field.frame = NSRect(x: 30, y: 210, width: 500, height: 30)
    field.setAccessibilityIdentifier("fixture-field")
    field.setAccessibilityLabel("Fixture input")
    status.frame = NSRect(x: 30, y: 100, width: 500, height: 60)
    status.setAccessibilityIdentifier("fixture-status")
    let button = NSButton(title: "Apply fixture", target: self, action: #selector(apply))
    button.frame = NSRect(x: 30, y: 165, width: 180, height: 30)
    view.addSubview(field); view.addSubview(button); view.addSubview(status)
    let pointer = PointerArea(status: status)
    pointer.setAccessibilityElement(true)
    pointer.setAccessibilityRole(.group)
    pointer.setAccessibilityLabel("Fixture pointer area")
    view.addSubview(pointer)
    window.makeKeyAndOrderFront(nil)
    window.displayIfNeeded()
    NSApplication.shared.activate()
    let receipt = CommandLine.arguments[1]
    DispatchQueue.main.async {
      let current = NSRunningApplication.current
      let ownWindows = ((CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []).filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid() }.prefix(16).map { info in Dictionary(uniqueKeysWithValues: [kCGWindowNumber,kCGWindowLayer,kCGWindowIsOnscreen,kCGWindowBounds].compactMap { key in info[key as String].map { (key as String, $0) } }) }
      let identity: [String: Any] = ["pid":Int(current.processIdentifier), "bundleId":current.bundleIdentifier ?? "missing", "path":current.bundleURL?.path ?? "missing", "launchDate":current.launchDate?.timeIntervalSince1970 ?? -1, "visible":self.window.isVisible, "key":self.window.isKeyWindow, "active":app.isActive, "windowNumber":self.window.windowNumber, "windows":ownWindows]
      try! JSONSerialization.data(withJSONObject: identity).write(to: URL(fileURLWithPath: receipt + ".identity"), options: .atomic)
      try! Data("ready".utf8).write(to: URL(fileURLWithPath: receipt), options: .atomic)
    }
  }
  @objc func apply() { status.stringValue = "applied: " + field.stringValue }
}
let app = NSApplication.shared
if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--launch-owned" {
  let delegate = LaunchOwner(bundle: URL(fileURLWithPath: CommandLine.arguments[2]), receipt: CommandLine.arguments[3])
  app.setActivationPolicy(.prohibited); app.delegate = delegate; app.run()
} else {
  let delegate = Fixture()
  app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
}
