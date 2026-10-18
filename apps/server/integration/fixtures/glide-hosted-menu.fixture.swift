// Opt-in native fixture. Every window, menu and file belongs to this fresh
// private application. Its launcher never activates or raises the application.
import AppKit
import ApplicationServices
import Darwin
import ScreenCaptureKit

private struct Birth: Equatable {
  let seconds: UInt64
  let microseconds: UInt64
  var json: [String: Any] { ["seconds": seconds, "microseconds": microseconds] }
}
private func birth(_ pid: pid_t) -> Birth? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
    info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
  return Birth(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
private func foreground() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication, let value = birth(app.processIdentifier) else { return [:] }
  return ["pid": app.processIdentifier, "birth": value.json]
}
private func write(_ value: Any, _ path: String) {
  do { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic) }
  catch { exit(1) }
}

private func inspectHosted(_ root: Int32, birth expected: Birth) {
  typealias GetPID = @convention(c) (AXUIElement, UnsafeMutablePointer<Int32>) -> AXError
  typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  guard birth(root) == expected,
    let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_NOW | RTLD_LOCAL),
    let symbol = dlsym(library, "_AXUIElementGetActualPid"), let windowSymbol = dlsym(library, "_AXUIElementGetWindow") else { exit(1) }
  let actual = unsafeBitCast(symbol, to: GetPID.self)
  let getWindow = unsafeBitCast(windowSymbol, to: GetWindow.self)
  let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
  let application = AXUIElementCreateApplication(root)
  AXUIElementSetMessagingTimeout(application, 0.02)
  var stack: [(AXUIElement, Int)] = [(application, 0)], visited = [AXUIElement](), values = [[String: Any]]()
  func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    var result: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
  }
  for name in [kAXFocusedUIElementAttribute, kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
    if let result = value(application, name), CFGetTypeID(result) == AXUIElementGetTypeID() { stack.append((unsafeBitCast(result, to: AXUIElement.self), 0)) }
  }
  while let (element, depth) = stack.popLast(), visited.count < 512, DispatchTime.now().uptimeNanoseconds < deadline {
    guard !visited.contains(where: { CFEqual($0, element) }) else { continue }
    visited.append(element)
    AXUIElementSetMessagingTimeout(element, 0.02)
    var logical: Int32 = 0, pid: Int32 = 0
    guard AXUIElementGetPid(element, &logical) == .success, actual(element, &pid) == .success,
      let identity = birth(pid), logical == root else { continue }
    let role = value(element, kAXRoleAttribute) as? String ?? ""
    if role == kAXMenuBarRole { continue }
    let title = value(element, kAXTitleAttribute) as? String ?? ""
    var window: CGWindowID = 0
    _ = getWindow(element, &window)
    var rawWindow = UnsafeRawPointer(bitPattern: UInt(window))
    let identifiers = CFArrayCreate(kCFAllocatorDefault, &rawWindow, 1, nil)
    let windows = window > 0 ? CGWindowListCreateDescriptionFromArray(identifiers) as? [[String: Any]] : nil
    let owner = (windows?.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window })?[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
    values.append(["role": role, "title": String(title.prefix(256)), "logicalPID": logical, "actualPID": pid, "birth": identity.json, "windowId": window, "windowOwner": owner])
    if depth < 24, let children = value(element, kAXChildrenAttribute) as? [AXUIElement] {
      stack.append(contentsOf: children.prefix(128).map { ($0, depth + 1) })
    }
  }
  guard birth(root) == expected else { exit(1) }
  let recipients = Set(values.compactMap { $0["actualPID"] as? Int32 } + [root])
  let ownedWindows = ((CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []).prefix(4096).compactMap { info -> [String: Any]? in
    guard let owner = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, recipients.contains(owner),
      let window = info[kCGWindowNumber as String], let bounds = info[kCGWindowBounds as String], let layer = info[kCGWindowLayer as String] else { return nil }
    return ["owner": owner, "windowId": window, "bounds": bounds, "layer": layer]
  }
  let point = NSEvent.mouseLocation
  let result: [String: Any] = ["root": root, "birth": expected.json, "elements": values, "ownedWindows": ownedWindows, "foreground": foreground(), "pointer": ["x": point.x, "y": point.y]]
  if ProcessInfo.processInfo.environment["CAFE_GLIDE_CAPTURE_GEOMETRY"] == "1", CGPreflightScreenCaptureAccess() {
    Task { @MainActor in
      var observed = result
      if let content = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) {
        observed["captureWindows"] = content.windows.filter { $0.owningApplication?.processID == root }.prefix(64).map { window -> [String: Any] in
          let filter = SCContentFilter(desktopIndependentWindow: window)
          func rectangle(_ value: CGRect) -> [String: Any] { ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height] }
          return ["windowId": window.windowID, "frame": rectangle(window.frame), "contentRect": rectangle(filter.contentRect), "scale": filter.pointPixelScale]
        }
      }
      guard let data = try? JSONSerialization.data(withJSONObject: observed, options: [.sortedKeys]) else { exit(1) }
      try? FileHandle.standardOutput.write(contentsOf: data + Data([10])); exit(0)
    }
    NSApplication.shared.run()
  } else {
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) else { exit(1) }
    try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
  }
}

private final class Owner: NSObject, NSApplicationDelegate {
  let bundle: URL
  let receipt: String
  var application: NSRunningApplication?
  var applicationBirth: Birth?
  var stopping = false
  var signals = [DispatchSourceSignal]()
  var termination: NSObjectProtocol?
  init(bundle: URL, receipt: String) { self.bundle = bundle.resolvingSymlinksInPath(); self.receipt = receipt }
  func matches(_ application: NSRunningApplication) -> Bool {
    !application.isTerminated && applicationBirth.map({ birth(application.processIdentifier) == $0 }) == true && application.bundleURL?.resolvingSymlinksInPath() == bundle
  }
  func stop() {
    stopping = true
    guard let application else { return }
    guard matches(application) else { exit(0) }
    application.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if self.matches(application) { application.forceTerminate() }
    }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    guard let identity = birth(getpid()), !foreground().isEmpty else { exit(1) }
    let point = NSEvent.mouseLocation
    write(["foreground": foreground(), "pointer": ["x": point.x, "y": point.y]], receipt + ".initial")
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
    for value in [SIGTERM, SIGINT] {
      let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
      source.setEventHandler { self.stop() }; source.resume(); signals.append(source)
    }
    termination = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { _ in
      if let application = self.application, !self.matches(application) { exit(0) }
    }
    DispatchQueue.global().async {
      _ = FileHandle.standardInput.readDataToEndOfFile()
      DispatchQueue.main.async { self.stop() }
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false; configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment
    configuration.arguments = [receipt, String(getpid()), String(identity.seconds), String(identity.microseconds)]
    NSWorkspace.shared.openApplication(at: bundle, configuration: configuration) { application, error in
      DispatchQueue.main.async {
        guard error == nil, let application, application.bundleURL?.resolvingSymlinksInPath() == self.bundle, let identity = birth(application.processIdentifier) else { exit(1) }
        self.application = application; self.applicationBirth = identity
        if self.stopping { self.stop() }
      }
    }
  }
}

private final class FixtureWindow: NSWindow {
  var received: ((NSEvent) -> Void)?
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
  override func sendEvent(_ event: NSEvent) {
    super.sendEvent(event)
    if [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .keyDown, .keyUp, .flagsChanged].contains(event.type) { received?(event) }
  }
}
private final class ContextArea: NSView {
  override var acceptsFirstResponder: Bool { true }
}

private final class Fixture: NSObject, NSApplicationDelegate, NSMenuDelegate {
  let receipt: String
  let popup = NSPopUpButton(frame: NSRect(x: 30, y: 190, width: 240, height: 32), pullsDown: false)
  let status = NSTextField(labelWithString: "waiting")
  var window: FixtureWindow!
  var eventMonitor: Any?
  var highlighted = ""
  var panel: NSOpenPanel?
  var events = [[String: Any]]()
  var foregroundObserver: NSObjectProtocol?
  var ownerExit: DispatchSourceProcess?
  init(receipt: String) { self.receipt = receipt }
  func record(_ kind: String, event: NSEvent? = nil) {
    guard events.count < 128, let identity = birth(getpid()) else { exit(1) }
    let point = NSEvent.mouseLocation
    var value: [String: Any] = [
      "sequence": events.count, "kind": kind, "pid": getpid(), "birth": identity.json,
      "foreground": foreground(), "pointer": ["x": point.x, "y": point.y],
      "windowNumber": window.windowNumber, "active": NSApplication.shared.isActive,
      "onActiveSpace": window.isOnActiveSpace,
      "status": status.stringValue, "selection": popup.titleOfSelectedItem ?? "", "highlighted": highlighted, "panelVisible": panel?.isVisible ?? false,
      "panelWindowNumber": panel?.windowNumber ?? 0,
    ]
    if let event {
      value["eventType"] = event.type.rawValue; value["eventWindowNumber"] = event.windowNumber
      value["eventLocation"] = ["x": event.locationInWindow.x, "y": event.locationInWindow.y]
      if event.type == .keyDown || event.type == .keyUp { value["keyCode"] = event.keyCode; value["characters"] = event.characters ?? "" }
    }
    events.append(value); write(events, receipt)
  }
  @objc func selected() { status.stringValue = "popup: " + (popup.titleOfSelectedItem ?? ""); record("popup selected") }
  @objc func contextSelected(_ item: NSMenuItem) { status.stringValue = "context: " + item.title; record("context selected") }
  @objc func openPanel() {
    let panel = NSOpenPanel()
    panel.title = "Owned Glide Hosted Panel"
    panel.setAccessibilityIdentifier("owned-glide-hosted-panel")
    panel.directoryURL = URL(fileURLWithPath: receipt).deletingLastPathComponent()
    panel.canChooseDirectories = false; panel.canChooseFiles = true; panel.allowsMultipleSelection = false
    panel.canCreateDirectories = false
    panel.message = "Private Glide fixture only"
    self.panel = panel
    panel.beginSheetModal(for: window) { response in
      self.status.stringValue = response == .OK ? "panel accepted" : "panel cancelled"
      if response == .OK, panel.url?.resolvingSymlinksInPath() != URL(fileURLWithPath: self.receipt).deletingLastPathComponent().appendingPathComponent("Owned Choice.txt").resolvingSymlinksInPath() { exit(1) }
      self.record("panel completed"); self.panel = nil
    }
    record("panel started")
  }
  func menuWillOpen(_ menu: NSMenu) { record(menu === popup.menu ? "popup opened" : "context opened") }
  func menuDidClose(_ menu: NSMenu) { record(menu === popup.menu ? "popup closed" : "context closed") }
  func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
    highlighted = item?.title ?? ""
    record("menu highlighted")
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    guard CommandLine.arguments.count == 5, let pid = pid_t(CommandLine.arguments[2]), let seconds = UInt64(CommandLine.arguments[3]), let microseconds = UInt64(CommandLine.arguments[4]), birth(pid) == Birth(seconds: seconds, microseconds: microseconds) else { exit(1) }
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
    source.setEventHandler { exit(0) }; source.resume(); ownerExit = source
    let unframed = ProcessInfo.processInfo.environment["CAFE_GLIDE_UNFRAMED_ROOT"] == "1"
    window = FixtureWindow(contentRect: NSRect(x: 100, y: 100, width: 420, height: 290), styleMask: unframed ? [.borderless] : [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Owned Glide Menus"
    window.isReleasedWhenClosed = false
    let view = window.contentView!
    popup.addItems(withTitles: ["Fixture One", "Fixture Two", "Fixture Three"])
    popup.setAccessibilityLabel("Owned popup")
    popup.target = self; popup.action = #selector(selected); popup.menu?.delegate = self
    view.addSubview(popup)
    let context = ContextArea(frame: NSRect(x: 30, y: 75, width: 330, height: 70))
    context.setAccessibilityElement(true); context.setAccessibilityRole(.group); context.setAccessibilityLabel("Owned context area")
    let menu = NSMenu(title: "Owned context menu")
    menu.delegate = self
    for title in ["Context Alpha", "Context Beta"] {
      let item = NSMenuItem(title: title, action: #selector(contextSelected(_:)), keyEquivalent: "")
      item.target = self; menu.addItem(item)
    }
    context.menu = menu; view.addSubview(context)
    status.frame = NSRect(x: 30, y: 25, width: 350, height: 30)
    status.setAccessibilityLabel("Owned menu status"); view.addSubview(status)
    let dialog = NSButton(title: "Open owned hosted panel", target: self, action: #selector(openPanel))
    dialog.frame = NSRect(x: 30, y: 235, width: 300, height: 30); view.addSubview(dialog)
    foregroundObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in self.record("foreground changed") }
    window.received = { self.record("window input", event: $0) }
    eventMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .mouseMoved, .leftMouseDragged, .keyDown, .keyUp]) { [weak self] event in
      self?.record("menu input", event: event)
      return event
    }
    window.order(.below, relativeTo: 0); window.displayIfNeeded()
    DispatchQueue.main.async { self.record("ready") }
  }
}

let application = NSApplication.shared
if CommandLine.arguments.count == 5, CommandLine.arguments[1] == "--inspect-hosted",
  let pid = Int32(CommandLine.arguments[2]), let seconds = UInt64(CommandLine.arguments[3]), let microseconds = UInt64(CommandLine.arguments[4]) {
  application.setActivationPolicy(.prohibited)
  inspectHosted(pid, birth: Birth(seconds: seconds, microseconds: microseconds))
} else if CommandLine.arguments.count == 4, CommandLine.arguments[1] == "--launch-owned" {
  let delegate = Owner(bundle: URL(fileURLWithPath: CommandLine.arguments[2]), receipt: CommandLine.arguments[3])
  application.setActivationPolicy(.prohibited); application.delegate = delegate; application.run()
} else {
  guard CommandLine.arguments.count == 5 else { exit(1) }
  let delegate = Fixture(receipt: CommandLine.arguments[1])
  application.setActivationPolicy(.regular); application.delegate = delegate; application.run()
}
