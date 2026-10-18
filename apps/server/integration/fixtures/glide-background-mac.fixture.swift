// Explicit native background qualification. Only this fresh application's
// private receipt directory and controls are accessed; no document/network use.
import AppKit
import Darwin

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
private func foregroundIdentity() -> [String: Any] {
  guard let app = NSWorkspace.shared.frontmostApplication, let identity = birth(app.processIdentifier) else { return [:] }
  return ["pid": Int(app.processIdentifier), "birth": identity.json]
}
private func writeJSON(_ value: Any, _ path: String) {
  do { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: URL(fileURLWithPath: path), options: .atomic) }
  catch { exit(1) }
}
private enum DesktopSpaces {
  private typealias Connection = @convention(c) () -> Int32
  private typealias Displays = @convention(c) (Int32) -> Unmanaged<CFArray>?
  private static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL)
  private static func inventory() -> [[String: Any]]? {
    guard let library, let connectionSymbol = dlsym(library, "SLSMainConnectionID"),
      let displaysSymbol = dlsym(library, "SLSCopyManagedDisplaySpaces") else { return nil }
    let connection = unsafeBitCast(connectionSymbol, to: Connection.self)()
    let query = unsafeBitCast(displaysSymbol, to: Displays.self)
    guard let displays = query(connection)?.takeRetainedValue() as? [[String: Any]], !displays.isEmpty, displays.count <= 16 else { return nil }
    return displays
  }
  static func hasInactiveOrdinarySpace() -> Bool {
    guard let displays = inventory() else { return false }
    return displays.contains { display in
      guard let current = (display["Current Space"] as? [String: Any])?["id64"] as? NSNumber,
        let spaces = display["Spaces"] as? [[String: Any]], spaces.count <= 64 else { return false }
      return spaces.contains { ($0["type"] as? NSNumber)?.intValue == 0 && ($0["id64"] as? NSNumber)?.uint64Value != current.uint64Value }
    }
  }
  static func active() -> [[String: Any]] {
    guard let displays = inventory() else { return [] }
    return displays.compactMap { display in
      guard let name = display["Display Identifier"] as? String,
        let current = (display["Current Space"] as? [String: Any])?["id64"] as? NSNumber else { return nil }
      return ["display": name, "space": current]
    }.sorted { ($0["display"] as? String ?? "") < ($1["display"] as? String ?? "") }
  }
}

// Qualification-only: move this newly created window to an existing inactive
// ordinary Space. The selected desktop is never changed and no Space is made.
// Function declarations follow yabai's primary source src/misc/extern.h.
private func prepareOwnedOffSpace(_ window: NSWindow) -> [String: Any] {
  guard ProcessInfo.processInfo.environment["CAFE_GLIDE_FIXTURE_OFFSPACE"] == "1" else { return ["requested": false] }
  typealias Connection = @convention(c) () -> Int32
  typealias Displays = @convention(c) (Int32) -> Unmanaged<CFArray>?
  typealias Display = @convention(c) (Int32, UInt32) -> Unmanaged<CFString>?
  typealias Move = @convention(c) (Int32, CFArray, UInt64) -> Void
  typealias Spaces = @convention(c) (Int32, UInt32, CFArray) -> Unmanaged<CFArray>?
  guard let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL),
    let connectionSymbol = dlsym(handle, "SLSMainConnectionID"), let displaysSymbol = dlsym(handle, "SLSCopyManagedDisplaySpaces"),
    let displaySymbol = dlsym(handle, "SLSCopyManagedDisplayForWindow"), let moveSymbol = dlsym(handle, "SLSMoveWindowsToManagedSpace"),
    let spacesSymbol = dlsym(handle, "SLSCopySpacesForWindows") else { return ["requested": true, "failure": "owned-window Space SPI unavailable"] }
  let connection = unsafeBitCast(connectionSymbol, to: Connection.self)()
  let copyDisplays = unsafeBitCast(displaysSymbol, to: Displays.self), copyDisplay = unsafeBitCast(displaySymbol, to: Display.self)
  let move = unsafeBitCast(moveSymbol, to: Move.self), copySpaces = unsafeBitCast(spacesSymbol, to: Spaces.self)
  guard let rawBefore = copyDisplays(connection)?.takeRetainedValue() as? [[String: Any]], rawBefore.count <= 16 else { return ["requested": true, "failure": "bounded display metadata unavailable"] }
  let display = copyDisplay(connection, UInt32(window.windowNumber))?.takeRetainedValue() as String?
  guard let display, let ownDisplay = rawBefore.first(where: { ($0["Display Identifier"] as? String) == display }) else {
    return ["requested": true, "failure": "owned display metadata mismatch", "windowDisplay": display ?? "missing", "displayIdentifiers": rawBefore.compactMap { $0["Display Identifier"] as? String }]
  }
  guard let current = (ownDisplay["Current Space"] as? [String: Any])?["id64"] as? NSNumber,
    let spaces = ownDisplay["Spaces"] as? [[String: Any]], spaces.count <= 64 else { return ["requested": true, "failure": "bounded ordinary Space metadata unavailable", "displayKeys": ownDisplay.keys.sorted()] }
  guard let target = spaces.first(where: { ($0["type"] as? NSNumber)?.intValue == 0 && ($0["id64"] as? NSNumber)?.uint64Value != current.uint64Value }),
    let targetID = (target["id64"] as? NSNumber)?.uint64Value else {
    return ["requested": true, "failure": "no existing inactive ordinary Space", "currentSpace": current, "spaces": spaces.map { ["id": $0["id64"] ?? 0, "type": $0["type"] ?? -1] }]
  }
  func currentSpaces(_ displays: [[String: Any]]) -> [String: UInt64] {
    Dictionary(uniqueKeysWithValues: displays.compactMap { item in
      guard let display = item["Display Identifier"] as? String, let id = (item["Current Space"] as? [String: Any])?["id64"] as? NSNumber else { return nil }
      return (display, id.uint64Value)
    })
  }
  let ids = [NSNumber(value: window.windowNumber)] as CFArray
  move(connection, ids, targetID)
  let memberships = (copySpaces(connection, 7, ids)?.takeRetainedValue() as? [NSNumber])?.map(\.uint64Value) ?? []
  let after = (copyDisplays(connection)?.takeRetainedValue() as? [[String: Any]]) ?? []
  return ["requested": true, "targetSpace": targetID, "windowSpaces": memberships,
    "moved": memberships.contains(targetID) && !memberships.contains(current.uint64Value),
    "currentSpacesUnchanged": currentSpaces(rawBefore) == currentSpaces(after)]
}

// The unbundled owner launches with activates=false and retains a kernel birth
// tuple plus canonical bundle path. EOF/signals retire only that exact instance.
private final class LaunchOwner: NSObject, NSApplicationDelegate {
  let bundle: URL
  let receipt: String
  let watchOnly: Bool
  var owned: NSRunningApplication?
  var ownedBirth: Birth?
  var stopping = false
  var termination: NSObjectProtocol?
  var launchObserver: NSObjectProtocol?
  var setupObserver: NSObjectProtocol?
  var setupDeadline: DispatchWorkItem?
  var signals: [DispatchSourceSignal] = []
  init(bundle: URL, receipt: String, watchOnly: Bool = false) { self.bundle = bundle.resolvingSymlinksInPath(); self.receipt = receipt; self.watchOnly = watchOnly }
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
    owned.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
      if self.isOwned(owned) { owned.forceTerminate() }
    }
  }
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Choosing Ready in Cafe may precede the user's return to the show. Admit
    // the baseline only after an actual Space-change notification establishes
    // a safe inactive ordinary desktop. This query never switches a Space.
    if ProcessInfo.processInfo.environment["CAFE_GLIDE_FIXTURE_OFFSPACE"] == "1" {
      setupObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in self.admitOffSpaceSetup() }
      let deadline = DispatchWorkItem {
        writeJSON(["failure": "No safe inactive ordinary Space became available before setup deadline", "spaces": DesktopSpaces.active()], self.receipt + ".setup")
        exit(1)
      }
      setupDeadline = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: deadline)
      admitOffSpaceSetup()
    } else { launch() }
  }
  private func admitOffSpaceSetup() {
    guard setupObserver != nil, DesktopSpaces.hasInactiveOrdinarySpace() else { return }
    if let observer = setupObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    setupObserver = nil; setupDeadline?.cancel(); setupDeadline = nil
    launch()
  }
  private func launch() {
    let initial = foregroundIdentity()
    guard !initial.isEmpty, initial["pid"] as? Int != Int(getpid()) else { exit(1) }
    let pointer = NSEvent.mouseLocation
    writeJSON(["foreground": initial, "pointer": ["x": pointer.x, "y": pointer.y], "spaces": DesktopSpaces.active()], receipt + ".initial")
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
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
    guard let ownerBirth = birth(getpid()) else { exit(1) }
    if watchOnly {
      launchObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { event in
        guard let app = event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
          app.bundleURL?.resolvingSymlinksInPath().path == self.bundle.path, let identity = birth(app.processIdentifier) else { return }
        self.owned = app; self.ownedBirth = identity
        if self.stopping { self.stop() }
      }
      writeJSON(["pid": Int(getpid()), "seconds": ownerBirth.seconds, "microseconds": ownerBirth.microseconds], receipt + ".owner")
      return
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.createsNewApplicationInstance = true
    configuration.environment = ProcessInfo.processInfo.environment
    configuration.arguments = [receipt, String(getpid()), String(ownerBirth.seconds), String(ownerBirth.microseconds)]
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

private final class FixtureWindow: NSWindow {
  var didReceive: ((NSEvent) -> Void)?
  override func sendEvent(_ event: NSEvent) {
    super.sendEvent(event)
    if [.keyDown, .keyUp, .leftMouseDown, .leftMouseUp, .leftMouseDragged, .scrollWheel].contains(event.type) { didReceive?(event) }
  }
}
private final class PointerArea: NSView {
  let changed: (String, NSEvent) -> Void
  private var dragged = false
  init(changed: @escaping (String, NSEvent) -> Void) {
    self.changed = changed
    super.init(frame: NSRect(x: 30, y: 25, width: 500, height: 60))
  }
  required init?(coder: NSCoder) { fatalError("No archived fixture views") }
  override var acceptsFirstResponder: Bool { true }
  override func mouseDown(with event: NSEvent) { dragged = false }
  override func mouseDragged(with event: NSEvent) { dragged = true; changed("pointer dragged", event) }
  override func mouseUp(with event: NSEvent) { if !dragged { changed("pointer clicked", event) } }
  override func scrollWheel(with event: NSEvent) { changed(event.scrollingDeltaY < 0 ? "pointer scrolled down" : "pointer scrolled up", event) }
}

// Intentionally broken AX provider: acknowledges setter dispatch but ignores
// it. Native qualification must observe no change and must not continue typing.
private final class NoOpField: NSTextField {
  override func setAccessibilityValue(_ value: Any?) {}
}
private final class UnfocusableField: NSView {
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .textField }
  override func accessibilityValue() -> Any? { "unfocusable" }
  override func isAccessibilityFocused() -> Bool { false }
  override func setAccessibilityFocused(_ focused: Bool) {}
}
private final class UnconfirmedButton: NSView {
  var pressed: (() -> Void)?
  override func isAccessibilityElement() -> Bool { true }
  override func accessibilityRole() -> NSAccessibility.Role? { .button }
  override func accessibilityPerformPress() -> Bool { pressed?(); return false }
}

private final class Fixture: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  let field = NSTextField(string: "initial")
  let status = NSTextField(labelWithString: "waiting")
  let receipt: String
  var window: FixtureWindow!
  var events: [[String: Any]] = []
  var foregroundObserver: NSObjectProtocol?
  var ownerExit: DispatchSourceProcess?
  var offSpacePreparation: [String: Any] = [:]
  var witness: NSWindow?
  var controlSource: DispatchSourceFileSystemObject?
  var controlHandle: FileHandle?
  var controlHandled = false
  var pointerArea: PointerArea?
  var applyButton: NSButton?
  var visibilityObserver: NSObjectProtocol?
  var minimizeObserver: NSObjectProtocol?
  var hideObserver: NSObjectProtocol?
  var unconfirmedSource: DispatchSourceFileSystemObject?
  var unconfirmedCount = 0
  init(receipt: String) { self.receipt = receipt }
  func record(_ kind: String, event: NSEvent? = nil) {
    guard events.count < 128, let identity = birth(getpid()) else { exit(1) }
    let pointer = NSEvent.mouseLocation
    func rectangle(_ view: NSView?) -> [String: Any] {
      guard let view else { return [:] }
      let value = window.convertToScreen(view.convert(view.bounds, to: nil))
      return ["x": value.minX, "y": CGDisplayBounds(CGMainDisplayID()).height - value.maxY, "width": value.width, "height": value.height]
    }
    var value: [String: Any] = [
      "sequence": events.count, "kind": kind, "pid": Int(getpid()), "birth": identity.json,
      "foreground": foregroundIdentity(), "pointer": ["x": pointer.x, "y": pointer.y],
      "windowNumber": window.windowNumber, "key": window.isKeyWindow, "main": window.isMainWindow,
      "active": NSApplication.shared.isActive, "field": field.stringValue, "status": status.stringValue,
      "offSpacePreparation": offSpacePreparation,
      "spaces": DesktopSpaces.active(),
      "controls": ["field": rectangle(field), "apply": rectangle(applyButton), "pointer": rectangle(pointerArea)],
      "witnessWindowNumber": witness?.windowNumber ?? 0,
      "visibility": ["visible": window.isVisible, "onActiveSpace": window.isOnActiveSpace,
                     "occluded": !window.occlusionState.contains(.visible), "hidden": NSApplication.shared.isHidden,
                     "windows": NSApplication.shared.windows.count, "minimized": window.isMiniaturized],
    ]
    if let event {
      value["eventType"] = Int(event.type.rawValue)
      value["eventWindowNumber"] = event.windowNumber
      value["eventLocation"] = ["x": event.locationInWindow.x, "y": event.locationInWindow.y]
    }
    events.append(value)
    writeJSON(events, receipt)
  }
  func controlTextDidChange(_ obj: Notification) { record("field changed") }
  @objc func apply() { status.stringValue = "applied: " + field.stringValue; record("applied") }
  @objc func hideOwned() { _ = NSRunningApplication.current.hide(); record("owned hide requested") }
  @objc func minimizeOwned() { window.miniaturize(nil); record("owned window minimized") }
  func applicationDidFinishLaunching(_ notification: Notification) {
    // Retire this app itself if its launcher dies during or after LS opening.
    // Thus a hard-timeout escalation cannot orphan a late-launched GUI child.
    let arguments = CommandLine.arguments.count == 5 ? Array(CommandLine.arguments.dropFirst(2)) : (Bundle.main.object(forInfoDictionaryKey: "GlideFixtureOwner") as? [String] ?? [])
    guard arguments.count == 3, let ownerPID = pid_t(arguments[0]),
          let seconds = UInt64(arguments[1]),
          let microseconds = UInt64(arguments[2]) else { exit(1) }
    let ownerBirth = Birth(seconds: seconds, microseconds: microseconds)
    guard birth(ownerPID) == ownerBirth else { exit(0) }
    let source = DispatchSource.makeProcessSource(identifier: ownerPID, eventMask: .exit, queue: .main)
    source.setEventHandler { exit(0) }; source.resume(); ownerExit = source
    guard birth(ownerPID) == ownerBirth else { exit(0) }
    let menu = NSMenu()
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    let submenu = NSMenu(title: "Edit")
    submenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    submenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    submenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    edit.submenu = submenu; menu.addItem(edit); NSApplication.shared.mainMenu = menu
    window = FixtureWindow(contentRect: NSRect(x: 100, y: 100, width: 560, height: 300), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
    window.title = "Cafe Background Glide Qualification"
    // Never join the user's fullscreen Space, become key, raise or activate.
    // An ordinary ordered-behind window retains a real WindowServer identity.
    window.isReleasedWhenClosed = false
    let view = window.contentView!
    field.frame = NSRect(x: 30, y: 210, width: 500, height: 30)
    field.setAccessibilityIdentifier("background-field")
    field.setAccessibilityLabel("Background input")
    field.delegate = self
    status.frame = NSRect(x: 30, y: 100, width: 500, height: 60)
    status.setAccessibilityIdentifier("background-status")
    let button = NSButton(title: "Apply background fixture", target: self, action: #selector(apply))
    applyButton = button
    button.frame = NSRect(x: 30, y: 165, width: 250, height: 30)
    view.addSubview(field); view.addSubview(button); view.addSubview(status)
    let noOp = NoOpField(string: "no-op initial")
    noOp.frame = NSRect(x: 30, y: 250, width: 500, height: 25)
    noOp.setAccessibilityLabel("Deliberate no-op input")
    view.addSubview(noOp)
    let overlap = NoOpField(string: "overlap initial")
    overlap.frame = noOp.frame
    overlap.setAccessibilityLabel("Distinct overlapping input")
    view.addSubview(overlap)
    let unfocusable = UnfocusableField(frame: NSRect(x: 300, y: 165, width: 230, height: 30))
    unfocusable.setAccessibilityLabel("Unfocusable fixture input")
    view.addSubview(unfocusable)
    let unconfirmed = UnconfirmedButton(frame: NSRect(x: 30, y: 0, width: 160, height: 20))
    unconfirmed.setAccessibilityLabel("Unconfirmed fixture action")
    // Hold this exact AX callback after its effect until the controller has
    // observed the real native AX timeout. This is an owned gate, not a sleep or
    // a guessed delay, and cleanup releases it before terminating the fixture.
    let releasePath = receipt + ".unconfirmed-release"
    guard FileManager.default.createFile(atPath: releasePath, contents: Data()), let releaseHandle = FileHandle(forReadingAtPath: releasePath) else { exit(1) }
    let gate = DispatchSemaphore(value: 0)
    let releaseSource = DispatchSource.makeFileSystemObjectSource(fileDescriptor: releaseHandle.fileDescriptor, eventMask: .write, queue: .global())
    var released = false
    releaseSource.setEventHandler {
      guard !released, let data = FileManager.default.contents(atPath: releasePath), data.starts(with: Data("release".utf8)) else { return }
      released = true; gate.signal(); releaseSource.cancel()
    }
    releaseSource.setCancelHandler { try? releaseHandle.close() }
    releaseSource.resume(); unconfirmedSource = releaseSource
    unconfirmed.pressed = { self.unconfirmedCount += 1; self.status.stringValue = "unconfirmed count=\(self.unconfirmedCount)"; self.record("unconfirmed action"); gate.wait() }
    view.addSubview(unconfirmed)
    for (title, selector, x) in [("Hide fixture", #selector(hideOwned), 200.0), ("Minimize fixture", #selector(minimizeOwned), 370.0)] {
      let control = NSButton(title: title, target: self, action: selector)
      control.frame = NSRect(x: x, y: 0, width: 160, height: 20)
      view.addSubview(control)
    }
    let pointer = PointerArea { value, event in self.status.stringValue = value; self.record(value, event: event) }
    pointerArea = pointer
    pointer.setAccessibilityElement(true)
    pointer.setAccessibilityRole(.group)
    pointer.setAccessibilityLabel("Background pointer area")
    view.addSubview(pointer)
    window.didReceive = { self.record("window input", event: $0) }
    foregroundObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in self.record("foreground changed") }
    window.order(.below, relativeTo: 0)
    window.displayIfNeeded()
    if ProcessInfo.processInfo.environment["CAFE_GLIDE_FIXTURE_SECOND_WINDOW"] == "1" {
      let other = NSWindow(contentRect: NSRect(x: 700, y: 100, width: 240, height: 120), styleMask: [.titled, .closable], backing: .buffered, defer: false)
      other.title = "Untouched Glide Witness"
      other.isReleasedWhenClosed = false
      let label = NSTextField(labelWithString: "witness unchanged")
      label.frame = NSRect(x: 20, y: 40, width: 200, height: 30)
      other.contentView?.addSubview(label)
      other.order(.below, relativeTo: 0)
      other.displayIfNeeded()
      witness = other
    }
    offSpacePreparation = prepareOwnedOffSpace(window)
    visibilityObserver = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { _ in self.record("owned visibility changed") }
    minimizeObserver = NotificationCenter.default.addObserver(forName: NSWindow.didMiniaturizeNotification, object: window, queue: .main) { _ in self.record("owned minimize completed") }
    hideObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didHideApplicationNotification, object: nil, queue: .main) { event in
      guard (event.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.processIdentifier == getpid() else { return }
      self.record("owned hide completed")
    }
    if ProcessInfo.processInfo.environment["CAFE_GLIDE_FIXTURE_WINDOW_CONTROL"] == "1" {
      let path = receipt + ".control"
      guard FileManager.default.createFile(atPath: path, contents: Data()), let handle = FileHandle(forReadingAtPath: path) else { exit(1) }
      controlHandle = handle
      let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: handle.fileDescriptor, eventMask: .write, queue: .main)
      source.setEventHandler {
        guard !self.controlHandled, let data = FileManager.default.contents(atPath: path),
          String(data: data, encoding: .utf8) == "move-away-and-back" else { return }
        self.controlHandled = true
        let original = self.window.frame
        self.window.setFrame(original.offsetBy(dx: 12, dy: 0), display: false)
        self.record("owned window moved")
        self.window.setFrame(original, display: false)
        self.record("owned window restored")
      }
      source.setCancelHandler { try? handle.close() }
      source.resume(); controlSource = source
    }
    DispatchQueue.main.async { self.record("ready") }
  }
}

if let privateHome = Bundle.main.object(forInfoDictionaryKey: "GlideFixturePrivateHome") as? String {
  let expected = URL(fileURLWithPath: privateHome).resolvingSymlinksInPath().path
  let environment = ProcessInfo.processInfo.environment
  let homeMatches = environment["HOME"].map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == expected } ?? false
  let fixedMatches = environment["CFFIXED_USER_HOME"].map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path == expected } ?? false
  let foundationMatches = URL(fileURLWithPath: NSHomeDirectory()).resolvingSymlinksInPath().path == expected
  guard fixedMatches, foundationMatches else {
    if let receipt = Bundle.main.object(forInfoDictionaryKey: "GlideFixtureReceipt") as? String { writeJSON(["homeMatches": homeMatches, "fixedMatches": fixedMatches], receipt + ".home-refusal") }
    exit(1)
  }
  // Launch Services preserves the login HOME over LSEnvironment on this host.
  // CFFIXED_USER_HOME and Foundation must already resolve to our private home;
  // bind this fixture process's remaining C HOME before creating NSApplication.
  guard setenv("HOME", privateHome, 1) == 0, let home = getenv("HOME"), URL(fileURLWithPath: String(cString: home)).resolvingSymlinksInPath().path == expected else { exit(1) }
}
let app = NSApplication.shared
if CommandLine.arguments.count == 4, ["--launch-owned", "--watch-owned"].contains(CommandLine.arguments[1]) {
  let delegate = LaunchOwner(bundle: URL(fileURLWithPath: CommandLine.arguments[2]), receipt: CommandLine.arguments[3], watchOnly: CommandLine.arguments[1] == "--watch-owned")
  app.setActivationPolicy(.prohibited); app.delegate = delegate; app.run()
} else {
  guard let receipt = CommandLine.arguments.count == 5 ? CommandLine.arguments[1] : Bundle.main.object(forInfoDictionaryKey: "GlideFixtureReceipt") as? String else { exit(1) }
  let delegate = Fixture(receipt: receipt)
  app.setActivationPolicy(.regular); app.delegate = delegate; app.run()
}
