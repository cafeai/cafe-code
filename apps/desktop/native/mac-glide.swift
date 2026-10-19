// Dedicated Glide service. This does not share dictation's one-shot
// authority. The parent owns this exact child and an immutable app allowlist.
// Requests and replies are 4-byte big-endian length-prefixed UTF-8 JSON.
import AppKit
import ApplicationServices
import Carbon
import Darwin
import ScreenCaptureKit

private let maxFrame = 12 * 1024 * 1024
private let maxNodes = 2048
private let maxTextBytes = 256 * 1024
private func diagnostic(_ phase: String) { try? FileHandle.standardError.write(contentsOf: Data(("glide.phase=" + phase + "\n").utf8)) }

private func nativeUserTemporaryDirectory() throws -> String {
  let length = confstr(_CS_DARWIN_USER_TEMP_DIR, nil, 0)
  guard length > 1, length <= Int(PATH_MAX) else { throw Failure("Native user input namespace is unavailable.") }
  var buffer = [CChar](repeating: 0, count: length)
  guard confstr(_CS_DARWIN_USER_TEMP_DIR, &buffer, length) == length else { throw Failure("Native user input namespace changed.") }
  return String(cString: buffer)
}

private struct Failure: Error {
  let message: String
  let interruption: BackgroundActivityPolicy.Interruption?
  let candidates: [[String: Any]]?
  init(_ message: String, interruption: BackgroundActivityPolicy.Interruption? = nil, candidates: [[String: Any]]? = nil) {
    self.message = message; self.interruption = interruption; self.candidates = candidates
  }
}
private struct ObservationChanged: Error {}

@MainActor
private func installedApplication(_ selector: String) throws -> (id: String, url: URL, name: String) {
  guard !selector.isEmpty, selector.utf8.count <= 1024 else { throw Failure("Specify an application bundle ID or absolute .app path.") }
  let url: URL?
  if selector.hasPrefix("/") { url = URL(fileURLWithPath: selector).standardizedFileURL.resolvingSymlinksInPath() }
  else if selector.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$", options: .regularExpression) != nil { url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: selector)?.resolvingSymlinksInPath() }
  else { url = nil }
  guard let url, url.pathExtension == "app", url.path.utf8.count <= 1024,
    let bundle = Bundle(url: url), let id = bundle.bundleIdentifier,
    id.range(of: "^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$", options: .regularExpression) != nil,
    bundle.object(forInfoDictionaryKey: "CFBundlePackageType") as? String == "APPL", bundle.executableURL != nil,
    selector.hasPrefix("/") || id == selector else { throw Failure("Installed application is unavailable or ambiguous. Use its exact bundle ID or canonical .app path.") }
  let name = bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? url.deletingPathExtension().lastPathComponent
  return (id, url, String(name.prefix(1024)))
}

// The background pipe reader can revoke while the main actor awaits an OS API.
// All mutable state is protected by this lock; cleanup remains separately
// permitted after revocation so owned held input/clipboard can be released.
private final class ConnectionAuthority: @unchecked Sendable {
  private let lock = NSLock()
  private var admitted = true
  var isLive: Bool { lock.lock(); defer { lock.unlock() }; return admitted }
  func revoke() { lock.lock(); admitted = false; lock.unlock() }
}

private func number(_ value: Any?) -> Double? {
  guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID(), value.doubleValue.isFinite else { return nil }
  return value.doubleValue
}
private func integer(_ value: Any?) -> Int? {
  guard let value = number(value), value.rounded() == value, value >= 0, value <= 9_007_199_254_740_991 else { return nil }
  return Int(value)
}
private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var result: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
}
private func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
  return unsafeBitCast(value, to: AXUIElement.self)
}
private func stringAttribute(_ element: AXUIElement, _ name: String) -> String {
  guard let value = attribute(element, name) else { return "" }
  if let text = value as? String { return String(text.prefix(1024)) }
  if let value = value as? NSNumber { return value.stringValue }
  return ""
}
private func frame(_ element: AXUIElement) -> CGRect? {
  guard let position = attribute(element, kAXPositionAttribute), let size = attribute(element, kAXSizeAttribute), CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
  var point = CGPoint.zero, dimensions = CGSize.zero
  guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point), AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions), point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite else { return nil }
  return CGRect(origin: point, size: dimensions)
}
private func sameFrame(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
  abs(lhs.minX - rhs.minX) < 1 && abs(lhs.minY - rhs.minY) < 1 && abs(lhs.width - rhs.width) < 1 && abs(lhs.height - rhs.height) < 1
}
private func setAttribute(_ element: AXUIElement, _ name: String, _ value: CFTypeRef, trace: GlideActionTrace? = nil, admit: () throws -> Void) throws {
  var settable = DarwinBoolean(false)
  guard AXUIElementIsAttributeSettable(element, name as CFString, &settable) == .success, settable.boolValue else { throw Failure("The requested accessibility attribute is not writable.") }
  try admit()
  trace?.beginAX("ax-write")
  let result = AXUIElementSetAttributeValue(element, name as CFString, value)
  trace?.endAX(result.rawValue)
  guard result == .success else { throw Failure("Accessibility write was not confirmed. Obtain fresh app state before repeating it.") }
}
private func perform(_ element: AXUIElement, _ action: String, trace: GlideActionTrace? = nil, admit: () throws -> Void) throws {
  try admit()
  trace?.beginAX("ax-action")
  let status = AXUIElementPerformAction(element, action as CFString)
  trace?.endAX(status.rawValue)
  guard status == .success else { throw Failure("Accessibility action was not confirmed (OS status \(status.rawValue)). It may have taken effect; inspect fresh app state.") }
}
private func children(_ element: AXUIElement) -> [AXUIElement] {
  var count: CFIndex = 0
  guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success, count > 0 else { return [] }
  var values: CFArray?
  guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, min(count, 128), &values) == .success else { return [] }
  return (values as? [AXUIElement]) ?? []
}
private func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
  return Array(((names as? [String]) ?? []).prefix(32))
}
private func windowOwner(_ id: CGWindowID) -> pid_t? {
  guard let value = NativeWindowMetadata.exact(id),
    let pid = integer(value[kCGWindowOwnerPID as String]), pid > 0, pid <= Int32.max else { return nil }
  return pid_t(pid)
}
private func windowBounds(_ id: CGWindowID, owner: pid_t) -> CGRect? {
  guard let value = NativeWindowMetadata.exact(id), integer(value[kCGWindowOwnerPID as String]) == Int(owner),
    let raw = value[kCGWindowBounds as String] as? [String: Any], let rectangle = CGRect(dictionaryRepresentation: raw as CFDictionary),
    rectangle.minX.isFinite, rectangle.minY.isFinite, rectangle.width.isFinite, rectangle.height.isFinite,
    abs(rectangle.minX) <= 100_000, abs(rectangle.minY) <= 100_000,
    rectangle.width > 1, rectangle.height > 1, rectangle.width <= 100_000, rectangle.height <= 100_000 else { return nil }
  return rectangle
}
private enum ActiveDesktops {
  private typealias Connection = @convention(c) () -> Int32
  private typealias Displays = @convention(c) (Int32) -> Unmanaged<CFArray>?
  private static let library = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW | RTLD_LOCAL)
  static func current() -> [[String: Any]]? {
    guard let library, let connectionSymbol = dlsym(library, "SLSMainConnectionID"),
      let displaysSymbol = dlsym(library, "SLSCopyManagedDisplaySpaces") else { return nil }
    let query = unsafeBitCast(displaysSymbol, to: Displays.self)
    let connection = unsafeBitCast(connectionSymbol, to: Connection.self)()
    return query(connection)?.takeRetainedValue() as? [[String: Any]]
  }
}

// Launch Services may omit launchDate for a directly launched application.
// The OS birth tuple is required instead; absence is inconclusive, never a PID-
// only fallback. Snapshot/action/cleanup all recheck the same process generation.
private func processIdentity(_ pid: pid_t) -> ProcessIdentity? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
        info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(),
        info.pbi_start_tvsec > 0 else { return nil }
  return ProcessIdentity(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}

/// The app bundle macOS privacy (TCC) attributes this helper's requests to.
/// TCC charges the *responsible* process, which child processes inherit from
/// the ancestor that launched them; it is not necessarily this helper, the
/// provider daemon or whichever Cafe copy is installed in /Applications. A
/// source desktop launched from a terminal is attributed to that terminal.
/// `responsibility_get_pid_responsible_for_pid` is the libsystem query TCC
/// itself uses; resolve it dynamically so an absent symbol degrades to "unknown"
/// rather than guessing. A PID can be reused after the original responsible
/// process exits (for example a detached daemon outliving the desktop), so the
/// candidate must have started no later than our parent: responsibility is
/// inherited at spawn, never adopted from a later process.
private func responsibleApplication() -> [String: Any]? {
  typealias ResponsibleFor = @convention(c) (pid_t) -> pid_t
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_get_pid_responsible_for_pid") else { return nil }
  let pid = unsafeBitCast(symbol, to: ResponsibleFor.self)(getpid())
  guard pid > 0, pid != getpid(), let start = processIdentity(pid), let parent = processIdentity(getppid()),
    (start.seconds, start.microseconds) <= (parent.seconds, parent.microseconds) else { return nil }
  var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
  // Revalidate after reading the path so an exit/reuse between calls is refused.
  guard let again = processIdentity(pid), again.seconds == start.seconds, again.microseconds == start.microseconds else { return nil }
  let executable = URL(fileURLWithPath: String(cString: buffer)).resolvingSymlinksInPath()
  // Nested helper bundles (Contents/Frameworks/... Helper.app) belong to the
  // outermost application, which is the entry users see in Settings.
  var bundle = URL(fileURLWithPath: "/")
  var found = false
  for component in executable.pathComponents.dropFirst() {
    bundle.appendPathComponent(component)
    if component.hasSuffix(".app") { found = true; break }
  }
  let target = found ? bundle : executable
  guard target.path.utf8.count <= 1024 else { return nil }
  var result: [String: Any] = ["path": target.path, "name": String(target.deletingPathExtension().lastPathComponent.prefix(128))]
  if found, let info = Bundle(url: target) {
    if let id = info.bundleIdentifier, id.utf8.count <= 255 { result["bundleId"] = id }
    if let name = (info.object(forInfoDictionaryKey: "CFBundleDisplayName") ?? info.object(forInfoDictionaryKey: "CFBundleName")) as? String, !name.isEmpty {
      result["name"] = String(name.prefix(128))
    }
  }
  return result
}

private struct NodeRecord {
  let element: AXUIElement
  let role: String
  let identifier: String
  let title: String
  let bounds: CGRect?
  let depth: Int
}
private struct NativeWindow {
  let id: CGWindowID
  let bounds: CGRect
  let title: String
  let onScreen: Bool
}
private struct ObservedMenu {
  let element: AXUIElement
  let recipient: FocusProcess
  let windowID: CGWindowID
  let bounds: CGRect
  let axBounds: CGRect
}
private struct Snapshot {
  let application: NSRunningApplication
  let birth: ProcessIdentity
  let window: AXUIElement?
  let axBounds: CGRect?
  let serverWindow: NativeWindow
  let windowID: CGWindowID
  let bounds: CGRect
  let nodes: [Int: NodeRecord]
  let lines: [String]
  let windowGeneration: UInt64?
  let menu: ObservedMenu?
}

// Window notifications invalidate the exact selected AX object even if it is
// moved away and back between two requests. Unsupported notifications retain
// the ordinary on-demand process/window/node identity and geometry checks.
private final class WindowInvalidations: @unchecked Sendable {
  private struct Watched { let element: AXUIElement; var generation: UInt64 }
  private struct Application { let birth: ProcessIdentity; let observer: AXObserver; var windows: [CGWindowID: Watched] }
  private let lock = NSLock()
  private var applications: [pid_t: Application] = [:]
  private let names = [kAXWindowMovedNotification, kAXWindowResizedNotification, kAXUIElementDestroyedNotification]

  func watch(_ root: FocusProcess, window: AXUIElement, id: CGWindowID) throws -> UInt64? {
    lock.lock(); defer { lock.unlock() }
    if let previous = applications[root.pid], previous.birth != root.birth {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(previous.observer), .defaultMode)
      applications.removeValue(forKey: root.pid)
    }
    if applications[root.pid] == nil {
      guard applications.count < 16 else { throw Failure("Accessibility observer capacity reached.") }
      var observer: AXObserver?
      let status = AXObserverCreate(root.pid, { _, element, _, context in
        guard let context else { return }
        Unmanaged<WindowInvalidations>.fromOpaque(context).takeUnretainedValue().invalidate(element)
      }, &observer)
      if status == .notImplemented || status == .notificationUnsupported { return nil }
      guard status == .success, let observer else { throw Failure("Selected application accessibility observer is unavailable.") }
      applications[root.pid] = Application(birth: root.birth, observer: observer, windows: [:])
      CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }
    guard var application = applications[root.pid] else { return nil }
    if let previous = application.windows[id], CFEqual(previous.element, window) { return previous.generation }
    guard application.windows[id] != nil || applications.values.reduce(0, { $0 + $1.windows.count }) < 64 else { throw Failure("Accessibility window observer capacity reached.") }
    let prior = application.windows[id]
    if let prior { for name in names { AXObserverRemoveNotification(application.observer, prior.element, name as CFString) } }
    var subscribed = false
    for name in names {
      let status = AXObserverAddNotification(application.observer, window, name as CFString, Unmanaged.passUnretained(self).toOpaque())
      if status == .success || status == .notificationAlreadyRegistered { subscribed = true }
      else if status != .notificationUnsupported && status != .notImplemented { throw Failure("Selected window accessibility observation could not be admitted.") }
    }
    guard subscribed else { return nil }
    let generation = (prior?.generation ?? 0) + 1
    application.windows[id] = Watched(element: window, generation: generation)
    applications[root.pid] = application
    return generation
  }
  private func invalidate(_ element: AXUIElement) {
    lock.lock(); defer { lock.unlock() }
    for pid in Array(applications.keys) {
      guard var application = applications[pid] else { continue }
      for id in Array(application.windows.keys) {
        guard var watched = application.windows[id], CFEqual(watched.element, element) else { continue }
        if watched.generation < UInt64.max { watched.generation += 1 }
        application.windows[id] = watched
      }
      applications[pid] = application
    }
  }
  func generation(_ root: FocusProcess, id: CGWindowID) -> UInt64? {
    // Service callbacks already queued by AppKit without an arbitrary wait.
    var drained = false
    for _ in 0..<64 { if CFRunLoopRunInMode(.defaultMode, 0, true) != .handledSource { drained = true; break } }
    guard drained else { return nil }
    lock.lock(); defer { lock.unlock() }
    guard let application = applications[root.pid], application.birth == root.birth else { return nil }
    return application.windows[id]?.generation
  }
  func close() {
    lock.lock(); defer { lock.unlock() }
    for application in applications.values { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(application.observer), .defaultMode) }
    applications.removeAll()
  }
  func retain(_ scopes: [FocusProcess: Set<CGWindowID>]) {
    lock.lock(); defer { lock.unlock() }
    for pid in Array(applications.keys) {
      guard var application = applications[pid] else { continue }
      let retained = scopes[FocusProcess(pid: pid, birth: application.birth)] ?? []
      for id in Array(application.windows.keys) where !retained.contains(id) {
        if let watched = application.windows.removeValue(forKey: id) {
          for name in names { AXObserverRemoveNotification(application.observer, watched.element, name as CFString) }
        }
      }
      if application.windows.isEmpty {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(application.observer), .defaultMode)
        applications.removeValue(forKey: pid)
      } else { applications[pid] = application }
    }
  }
}

private enum WindowReferences {
  private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  private static let getWindow: GetWindow? = {
    guard let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_NOW | RTLD_LOCAL),
      let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: GetWindow.self)
  }()
  static func id(_ element: AXUIElement) -> CGWindowID? {
    var id: CGWindowID = 0
    guard let getWindow, getWindow(element, &id) == .success, id > 0 else { return nil }
    return id
  }
}

private enum InputMode: String { case background, foreground }

// The background path addresses a window explicitly. It never posts to the
// global HID stream. The private window-local field is the same SPI used by
// the inspected native driver; absence refuses input before any mouse-down.
@MainActor
private enum WindowEvents {
  private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
  private static let setWindowLocation: SetWindowLocation? = {
    guard let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW | RTLD_LOCAL),
          let symbol = dlsym(handle, "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(symbol, to: SetWindowLocation.self)
  }()

  static func address(_ event: CGEvent, point: CGPoint, windowID: CGWindowID, bounds: CGRect) throws {
    guard let setter = setWindowLocation, bounds.contains(point) else { throw Failure("Background window event routing is unavailable. No foreground fallback was attempted.") }
    event.location = point
    event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
    event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
    // WindowServer's local location retains Quartz's top-left origin. AppKit
    // flips this when decoding the CGEvent into locationInWindow; flipping here
    // as well would target the opposite vertical position inside the window.
    setter(event, CGPoint(x: point.x - bounds.minX, y: point.y - bounds.minY))
  }

  static func mouse(type: NSEvent.EventType, point: CGPoint, button: CGMouseButton, count: Int, number: Int, flags: CGEventFlags, windowID: CGWindowID, bounds: CGRect) throws -> CGEvent {
    guard let native = NSEvent.mouseEvent(with: type, location: point, modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)), timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: Int(windowID), context: nil, eventNumber: number, clickCount: count, pressure: type == .leftMouseUp || type == .rightMouseUp || type == .otherMouseUp ? 0 : 1),
          let event = native.cgEvent else { throw Failure("Could not create a window-targeted mouse event.") }
    event.flags = flags
    event.setIntegerValueField(.mouseEventButtonNumber, value: Int64(button.rawValue))
    // Native Sky marks synthesized mouse events with subtype 3.
    event.setIntegerValueField(.mouseEventSubtype, value: 3)
    try address(event, point: point, windowID: windowID, bounds: bounds)
    return event
  }
}

private struct HeldPointer {
  let app: NSRunningApplication
  let birth: ProcessIdentity
  let recipient: FocusProcess
  let windowID: CGWindowID
  let bounds: CGRect
  let point: CGPoint
  let button: CGMouseButton
  let number: Int
}

// Narrow reconstruction of Sky's same-process AppKit focus-steal protection.
// Only process-notification events for exact registered process generations are
// intercepted. Human keyboard/mouse events and unrelated apps pass untouched.
private final class BackgroundFocusGuard: @unchecked Sendable {
  private typealias ReleaseFocus = @convention(c) (UInt32) -> Int32
  private typealias GetFocus = @convention(c) (UnsafeMutablePointer<ProcessSerialNumber>, UnsafeMutablePointer<DarwinBoolean>) -> Int32
  private typealias GetPID = @convention(c) (UnsafePointer<ProcessSerialNumber>, UnsafeMutablePointer<pid_t>) -> Int32
  private let lock = NSLock()
  private var policies: [FocusProcess: BackgroundFocusPolicy] = [:]
  private var inputSubjects: Set<FocusProcess> = []
  private var auxiliaryProof: BackgroundIncomingFocusProofPolicy.Proof?
  private var auxiliaryPolicy = BackgroundAuxiliaryFocusPolicy()
  private var auxiliaryRetiring = false
  private var approvedRoot: FocusProcess?
  private var outsideRevoke: (@Sendable () -> Void)?
  private let authority: ConnectionAuthority
  private var rescueGuard: GlideKeyRescueGuard?
  private var rescueProcesses: [FocusProcess] = []
  private var retainedForeground: FocusProcess?
  private var admissionEpoch: UInt64 = 0
  private let incomingLane = BackgroundIncomingFocusLane()
  private var incomingDiagnostics: [String] = []
  private var failed = false
  private var inputRevoked = false
  private var stopping = false
  private var outsideActivity = BackgroundActivityPolicy()
  private let releaseFocus: ReleaseFocus
  private let getFocus: GetFocus
  private let getPID: GetPID
  private var tap: CFMachPort?
  private var activityTap: CFMachPort?
  private var runLoop: CFRunLoop?
  private let ready = DispatchSemaphore(value: 0)
  private let finished = DispatchSemaphore(value: 0)
  private static let subtype = CGEventField(rawValue: 64)!
  private static let theftID = CGEventField(rawValue: 71)!
  private static let subjectPID = CGEventField(rawValue: 73)!

  init(authority: ConnectionAuthority) throws {
    self.authority = authority
    guard let library = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW | RTLD_LOCAL),
          let release = dlsym(library, "CPSReleaseKeyFocusWithID"),
          let get = dlsym(library, "CPSGetKeyFocusProcess"),
          let processLibrary = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_NOW | RTLD_LOCAL),
          let getPIDSymbol = dlsym(processLibrary, "GetProcessPID") else { throw Failure("Background focus protection SPI is unavailable. No foreground fallback was attempted.") }
    releaseFocus = unsafeBitCast(release, to: ReleaseFocus.self)
    getFocus = unsafeBitCast(get, to: GetFocus.self)
    getPID = unsafeBitCast(getPIDSymbol, to: GetPID.self)
    // AX calls and text input may block MainActor. The active suppression tap
    // must remain serviced while those operations are in progress. A run-loop
    // receipt, rather than just Thread.start(), admits the first input.
    let thread = Thread { [self] in run() }
    thread.name = "cafe-glide-background-focus"
    thread.qualityOfService = .userInitiated
    thread.start()
    guard ready.wait(timeout: .now() + 1) == .success else {
      stop()
      throw Failure("Background focus protection did not become ready. No input was sent.")
    }
    do { try check() } catch { stop(); throw error }
  }

  private func run() {
    defer { finished.signal() }
    guard let created = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .tailAppendEventTap, options: .defaultTap, eventsOfInterest: CGEventMask(1) << 21, callback: { _, type, event, context in
      guard let context else { return Unmanaged.passUnretained(event) }
      return Unmanaged<BackgroundFocusGuard>.fromOpaque(context).takeUnretainedValue().handle(type, event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
      lock.lock(); failed = true; lock.unlock(); ready.signal(); return
    }
    guard let runSource = CFMachPortCreateRunLoopSource(nil, created, 0) else {
      CFMachPortInvalidate(created)
      lock.lock(); failed = true; lock.unlock(); ready.signal(); return
    }
    // Retain focus protection for queued target work, as Sky's app controller
    // does. Cafe's takeover policy is deliberately conservative: outside key,
    // button or wheel input disarms protection before passing that input on.
    // No key values/text are inspected or retained. Foreign synthesized input
    // also disarms; source PID is not treated as proof of hardware input.
    let activityMask = [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
    guard let activity = CGEvent.tapCreate(tap: .cgAnnotatedSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: activityMask, callback: { _, type, event, context in
      guard let context else { return Unmanaged.passUnretained(event) }
      return Unmanaged<BackgroundFocusGuard>.fromOpaque(context).takeUnretainedValue().observeActivity(type, event)
    }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
      CFMachPortInvalidate(created)
      lock.lock(); failed = true; lock.unlock(); ready.signal(); return
    }
    guard let activitySource = CFMachPortCreateRunLoopSource(nil, activity, 0) else {
      CFMachPortInvalidate(created); CFMachPortInvalidate(activity)
      lock.lock(); failed = true; lock.unlock(); ready.signal(); return
    }
    let loop = CFRunLoopGetCurrent()!
    lock.lock()
    guard !stopping else { lock.unlock(); CFMachPortInvalidate(created); CFMachPortInvalidate(activity); ready.signal(); return }
    tap = created; activityTap = activity; runLoop = loop
    lock.unlock()
    CFRunLoopAddSource(loop, runSource, .defaultMode)
    CFRunLoopAddSource(loop, activitySource, .defaultMode)
    CGEvent.tapEnable(tap: created, enable: true)
    CGEvent.tapEnable(tap: activity, enable: true)
    CFRunLoopPerformBlock(loop, CFRunLoopMode.defaultMode.rawValue) { [self] in
      ready.signal()
      lock.lock(); let shouldStop = stopping; lock.unlock()
      if shouldStop { CFRunLoopStop(loop) }
    }
    CFRunLoopRun()
    CGEvent.tapEnable(tap: created, enable: false)
    CGEvent.tapEnable(tap: activity, enable: false)
    CFMachPortInvalidate(created)
    CFMachPortInvalidate(activity)
    CFRunLoopRemoveSource(loop, runSource, .defaultMode)
    CFRunLoopRemoveSource(loop, activitySource, .defaultMode)
    lock.lock(); tap = nil; activityTap = nil; runLoop = nil; failed = true; policies.removeAll(); approvedRoot = nil; outsideRevoke = nil; rescueGuard?.retirePending(); lock.unlock()
  }

  func register(_ pid: pid_t, birth: ProcessIdentity, retainedForeground: FocusProcess, previousGeneration: UInt64? = nil) throws -> UInt64 {
    try check(previousGeneration)
    var psn = ProcessSerialNumber(), flags = DarwinBoolean(false), focusedPID: pid_t = 0
    guard getFocus(&psn, &flags) == 0, getPID(&psn, &focusedPID) == 0,
          focusedPID > 0, let focusedBirth = processIdentity(focusedPID),
          processIdentity(pid) == birth else { throw Failure("Actual keyboard focus could not be established for background input.") }
    guard FocusProcess(pid: focusedPID, birth: focusedBirth) == retainedForeground else { throw Failure("Actual keyboard focus (pid \(focusedPID)) and the retained foreground owner (pid \(retainedForeground.pid)) differ. Background control refused before synthetic focus; unresolved auxiliary focus has no guessed owner mapping.") }
    let root = FocusProcess(pid: pid, birth: birth)
    let authority = self.authority
    lock.lock()
    // Actual CPS focus was just proven restored to the retained external app.
    // Retire the previous theft tuple and obsolete hosted/auxiliary streams
    // before a new operation; name discovery cannot reserve that old capacity.
    rescueGuard?.retirePending()
    let reuseRescue = rescueProcesses == [root] && processIdentity(root.pid) == root.birth
    lock.unlock()
    let replacement = reuseRescue ? nil : try GlideKeyRescueGuard(processes: [root], identity: { pid in authority.isLive ? processIdentity(pid) : nil })
    lock.lock()
    if let previousGeneration, previousGeneration != outsideActivity.generation {
      let interruption = outsideActivity.interruption
      lock.unlock(); replacement?.stop()
      throw Failure("Outside input interrupted background control before focus re-admission. Further input stopped; inspect fresh state.", interruption: interruption)
    }
    guard admissionEpoch < UInt64.max else { failed = true; lock.unlock(); replacement?.stop(); throw Failure("Background admission identity exhausted.") }
    admissionEpoch += 1
    let retired = replacement != nil ? rescueGuard : nil
    if let replacement { rescueGuard = replacement; rescueProcesses = [root] }
    if self.retainedForeground != retainedForeground { rescueGuard?.retirePending() }
    self.retainedForeground = retainedForeground
    inputRevoked = false
    var policy = BackgroundFocusPolicy()
    policy.arm(root, current: FocusProcess(pid: focusedPID, birth: focusedBirth))
    policies = [root: policy]
    inputSubjects = [root]
    auxiliaryProof = nil; auxiliaryPolicy.disarm(); auxiliaryRetiring = false
    approvedRoot = root
    let generation = outsideActivity.beginAdmission()
    lock.unlock()
    retired?.stop()
    try check(generation)
    return generation
  }
  func check(_ generation: UInt64? = nil) throws {
    lock.lock()
    let invalid = failed || stopping || (generation != nil && inputRevoked), interrupted = generation.map { $0 != outsideActivity.generation } ?? false
    let tap = self.tap, activity = activityTap, rescue = rescueGuard, interruption = outsideActivity.interruption
    let phases = incomingDiagnostics
    incomingDiagnostics.removeAll(keepingCapacity: true)
    lock.unlock()
    for phase in phases { diagnostic(phase) }
    guard !invalid, let tap, let activity, CFMachPortIsValid(tap), CGEvent.tapIsEnabled(tap: tap), CFMachPortIsValid(activity), CGEvent.tapIsEnabled(tap: activity) else { throw Failure("Background focus protection stopped. Inspect app state before continuing.") }
    guard !interrupted else { throw Failure("Outside input interrupted background control. Further input stopped; inspect fresh state. Event provenance does not establish physical user input.", interruption: interruption) }
    if generation != nil { try rescue?.validate() }
  }
  func activityGeneration() throws -> UInt64 {
    try check()
    lock.lock(); defer { lock.unlock() }
    return outsideActivity.beginAdmission()
  }
  func registerRecipient(root: FocusProcess, recipient: FocusProcess) throws {
    try check()
    guard processIdentity(root.pid) == root.birth, processIdentity(recipient.pid) == recipient.birth else { throw Failure("Hosted input process identity changed.") }
    var psn = ProcessSerialNumber(), flags = DarwinBoolean(false), pid: pid_t = 0
    guard getFocus(&psn, &flags) == 0, getPID(&psn, &pid) == 0, let birth = processIdentity(pid) else { throw Failure("Actual keyboard focus is unavailable for hosted input.") }
    let authority = self.authority
    lock.lock()
    let expectedEpoch = admissionEpoch, expectedGeneration = outsideActivity.generation
    let expectedRescue = rescueGuard
    let needsReplacement = !rescueProcesses.contains(recipient)
    let auxiliary = auxiliaryProof?.rawSubject
    var streams = root == recipient ? [root] : [root, recipient]
    if let auxiliary, !streams.contains(auxiliary) { streams.append(auxiliary) }
    lock.unlock()
    let replacement = needsReplacement ? try GlideKeyRescueGuard(processes: streams, auxiliary: auxiliary, identity: { pid in authority.isLive ? processIdentity(pid) : nil }) : nil
    lock.lock()
    guard !failed, !stopping, !inputRevoked, approvedRoot == root, policies[root] != nil,
      admissionEpoch == expectedEpoch, outsideActivity.generation == expectedGeneration,
      rescueGuard === expectedRescue, auxiliaryProof?.rawSubject == auxiliary else {
      lock.unlock(); replacement?.stop(); throw Failure("Hosted recipient focus scope changed during preparation. Obtain fresh app state.")
    }
    if !inputSubjects.contains(recipient) {
      guard inputSubjects.count < 2 else { lock.unlock(); replacement?.stop(); throw Failure("Hosted recipient changed within an operation. Obtain fresh state.") }
      inputSubjects.insert(recipient)
    }
    if policies[recipient] == nil {
      var policy = BackgroundFocusPolicy()
      policy.arm(recipient, current: FocusProcess(pid: pid, birth: birth))
      policies[recipient] = policy
    }
    if let replacement {
      let previous = rescueGuard
      if let previous { replacement.inheritPending(from: previous) }
      rescueGuard = replacement; rescueProcesses = streams
      lock.unlock()
      previous?.stop()
    } else { lock.unlock() }
  }
  func registerAuxiliary(_ proof: BackgroundIncomingFocusProofPolicy.Proof) throws {
    try check(proof.generation)
    lock.lock()
    guard !failed, !stopping, approvedRoot == proof.root,
      proof.admits(root: proof.root, generation: outsideActivity.generation, isLive: { processIdentity($0.pid) == $0.birth }),
      auxiliaryProof.map({ $0.rawSubject == proof.rawSubject }) ?? true else { lock.unlock(); throw Failure("Incoming auxiliary focus proof changed or expired before dispatch.") }
    if auxiliaryProof?.rawSubject == proof.rawSubject && auxiliaryProof?.generation == proof.generation { lock.unlock(); return }
    let expectedEpoch = admissionEpoch, expectedRescue = rescueGuard
    let expectedAuxiliary = auxiliaryProof?.rawSubject
    var streams = [proof.root] + inputSubjects.filter { $0 != proof.root }.sorted { $0.pid < $1.pid }
    if !streams.contains(proof.rawSubject) { streams.append(proof.rawSubject) }
    let current = retainedForeground
    lock.unlock()
    guard let current else { throw Failure("Incoming auxiliary has no retained foreground owner.") }
    let authority = self.authority
    let replacement = try GlideKeyRescueGuard(processes: streams, auxiliary: proof.rawSubject, identity: { pid in authority.isLive ? processIdentity(pid) : nil })
    lock.lock()
    guard !failed, !stopping, !inputRevoked, approvedRoot == proof.root,
      admissionEpoch == expectedEpoch, rescueGuard === expectedRescue,
      auxiliaryProof?.rawSubject == expectedAuxiliary,
      proof.admits(root: proof.root, generation: outsideActivity.generation, isLive: { processIdentity($0.pid) == $0.birth }) else { lock.unlock(); replacement.stop(); throw Failure("Incoming auxiliary focus proof was revoked during setup.") }
    let previous = rescueGuard
    if let previous { replacement.inheritPending(from: previous) }
    rescueGuard = replacement; rescueProcesses = streams
    auxiliaryProof = proof; auxiliaryPolicy.arm(proof.rawSubject, current: current, suppressesNewFront: proof.specialAuxiliary)
    auxiliaryRetiring = false
    lock.unlock()
    previous?.stop()
    try check(proof.generation)
  }
  func setOutsideRevoke(_ revoke: (@Sendable () -> Void)?) { lock.lock(); outsideRevoke = revoke; lock.unlock() }
  func admits(root: FocusProcess, generation: UInt64) -> Bool {
    lock.lock(); defer { lock.unlock() }
    return !failed && !stopping && !inputRevoked && approvedRoot == root && outsideActivity.generation == generation
  }
  func disarm() { lock.lock(); policies.removeAll(); inputSubjects.removeAll(); auxiliaryProof = nil; auxiliaryPolicy.disarm(); approvedRoot = nil; retainedForeground = nil; rescueGuard?.retirePending(); lock.unlock() }
  func stop() {
    lock.lock()
    if stopping { lock.unlock(); return }
    stopping = true; failed = true; policies.removeAll(); inputSubjects.removeAll(); auxiliaryProof = nil; auxiliaryPolicy.disarm(); approvedRoot = nil; outsideRevoke = nil
    let tap = self.tap, activity = activityTap, loop = runLoop, rescue = rescueGuard
    rescueGuard = nil; rescueProcesses.removeAll(); retainedForeground = nil
    lock.unlock()
    if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
    if let activity { CGEvent.tapEnable(tap: activity, enable: false); CFMachPortInvalidate(activity) }
    if let loop { CFRunLoopStop(loop); CFRunLoopWakeUp(loop) }
    rescue?.stop()
    // The thread retains this callback context until its source is retired.
    // A blocked OS callback cannot make connection cleanup wait indefinitely.
    _ = finished.wait(timeout: .now() + 1)
  }
  private func observeActivity(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    lock.lock()
    var revoke: (@Sendable () -> Void)?
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { failed = true; rescueGuard?.retirePending() }
    else if outsideActivity.observe(sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID), helperPID: getpid(), event: type == .scrollWheel ? "scroll" : type == .keyDown ? "key-down" : "button-down") {
      if outsideActivity.exhausted { failed = true }
      for key in Array(policies.keys) { policies[key]?.revokeFutureAdmission() }
      inputSubjects.removeAll(); auxiliaryPolicy.revokeFutureAdmission(); auxiliaryRetiring = true; approvedRoot = nil
      revoke = outsideRevoke
    }
    lock.unlock()
    // Menu callbacks may query the generation while holding their own state
    // lock. Revoke only after releasing this lock to keep one lock order.
    revoke?()
    return Unmanaged.passUnretained(event)
  }
  private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
    let pass = Unmanaged.passUnretained(event)
    lock.lock(); defer { lock.unlock() }
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput { failed = true; rescueGuard?.retirePending(); return pass }
    guard !stopping, type.rawValue == 21 else { return pass }
    let kind = UInt16(truncatingIfNeeded: event.getIntegerValueField(Self.subtype))
    let rawSubject = event.getIntegerValueField(Self.subjectPID), rawTarget = event.getIntegerValueField(.eventTargetUnixProcessID)
    guard rawSubject >= 0, rawSubject <= Int32.max, rawTarget >= 0, rawTarget <= Int32.max else { return pass }
    func identity(_ pid: pid_t) -> FocusProcess? {
      guard pid > 0, let birth = processIdentity(pid) else { return nil }
      return FocusProcess(pid: pid, birth: birth)
    }
    let subject = identity(pid_t(rawSubject)), target = identity(pid_t(rawTarget))
    rescueGuard?.observeFocus(kind: kind, subject: subject)
    guard !failed else { return pass }
    // A newly launched prohibited service may not exist at pre-dispatch time.
    // Resolve only the exact raw Taken subject on an independent AX lane. The
    // original callback can wait at most 40ms total for proof + PID-tap receipt;
    // all late work is read-only and cannot publish admission afterward.
    if kind == 0x4000, let subject, let target, policies[subject] == nil,
       auxiliaryProof?.rawSubject != subject, let root = approvedRoot,
       let foreground = retainedForeground, let rescue = rescueGuard, !inputRevoked {
      guard target == foreground else {
        inputRevoked = true
        for key in Array(policies.keys) { policies[key]?.revokeFutureAdmission() }
        auxiliaryPolicy.revokeFutureAdmission()
        let revoke = outsideRevoke
        lock.unlock(); revoke?(); lock.lock()
        return pass
      }
      let generation = outsideActivity.generation, epoch = admissionEpoch
      if incomingDiagnostics.count < 8 { incomingDiagnostics.append("incoming.observed") }
      let recipient = inputSubjects.first { $0 != root }
      let now = DispatchTime.now().uptimeNanoseconds
      let (before, overflow) = now.addingReportingOverflow(BackgroundIncomingFocusWork.maximumNanoseconds)
      guard !overflow else { inputRevoked = true; return pass }
      let authority = self.authority
      lock.unlock()
      let proof = incomingLane.resolve(root: root, subject: subject, retainedForeground: foreground,
        generation: generation, knownRecipient: recipient, before: before,
        identity: { pid in authority.isLive ? processIdentity(pid) : nil })
      let preparation = proof.flatMap { rescue.prepareAuxiliary(proof: $0, before: before) }
      lock.lock()
      let unchanged = !failed && !stopping && !inputRevoked && authority.isLive &&
        approvedRoot == root && retainedForeground == foreground && admissionEpoch == epoch &&
        outsideActivity.generation == generation && rescueGuard === rescue &&
        processIdentity(foreground.pid) == foreground.birth && processIdentity(subject.pid) == subject.birth &&
        (auxiliaryProof.map { $0.rawSubject == subject } ?? true)
      if unchanged, let proof, let preparation,
         proof.admits(root: root, generation: generation, isLive: { processIdentity($0.pid) == $0.birth }),
         DispatchTime.now().uptimeNanoseconds < before, preparation.commit() {
        auxiliaryProof = proof
        auxiliaryPolicy.arm(subject, current: foreground, suppressesNewFront: proof.specialAuxiliary)
        auxiliaryRetiring = false
        if !rescueProcesses.contains(subject) { rescueProcesses.append(subject) }
        if incomingDiagnostics.count < 8 { incomingDiagnostics.append("incoming.admitted") }
      } else {
        if incomingDiagnostics.count < 8 { incomingDiagnostics.append(DispatchTime.now().uptimeNanoseconds >= before ? "incoming.expired" : "incoming.refused") }
        // A retired callback cannot revoke a replacement operation either.
        let sameOperation = admissionEpoch == epoch && approvedRoot == root && retainedForeground == foreground &&
          outsideActivity.generation == generation && rescueGuard === rescue
        if sameOperation {
          inputRevoked = true
          for key in Array(policies.keys) { policies[key]?.revokeFutureAdmission() }
          auxiliaryPolicy.revokeFutureAdmission()
        }
        let revoke = sameOperation ? outsideRevoke : nil
        lock.unlock()
        preparation?.cancel()
        revoke?()
        lock.lock()
        return pass
      }
    }
    var suppress = false, releases = Set<UInt32>(), auxiliaryReleases = Set<UInt32>()
    let proof = auxiliaryProof.flatMap { proof in
      let root = auxiliaryRetiring ? proof.root : approvedRoot
      let generation = auxiliaryRetiring ? proof.generation : outsideActivity.generation
      return root.map({ proof.admits(root: $0, generation: generation, isLive: { processIdentity($0.pid) == $0.birth }) }) == true ? proof : nil
    }
    if proof != nil {
      switch auxiliaryPolicy.observe(kind: kind, subject: subject, target: target, token: event.getIntegerValueField(Self.theftID), isLive: { processIdentity($0.pid) == $0.birth }) {
      case .pass: break
      case .suppress: suppress = true
      case .invalidToken: failed = true
      case .release(let token): releases.insert(token); auxiliaryReleases.insert(token)
      }
      // The raw auxiliary policy supersedes an ordinary hosted policy for the
      // same exact PID; input authority still comes only from AX routing.
    }
    for process in Array(policies.keys) {
      if process == proof?.rawSubject { continue }
      guard var policy = policies[process] else { continue }
      switch policy.observe(kind: kind, subject: subject, target: target, token: event.getIntegerValueField(Self.theftID), isLive: { processIdentity($0.pid) == $0.birth }) {
      case .pass: break
      case .suppress: suppress = true
      case .invalidToken: failed = true
      case .release(let token): releases.insert(token)
      }
      policies[process] = policy
    }
    for token in releases {
      let success = releaseFocus(token) == 0
      if auxiliaryReleases.contains(token) { auxiliaryPolicy.noteReleaseResult(token: token, success: success) }
      if !success { failed = true }
    }
    if suppress && kind == 0x4000 {
      guard let subject, let target, let retainedForeground,
        rescueGuard?.admit(subject: subject, target: target, retainedForeground: retainedForeground) == true else {
          // Refuse agent work without disabling the already admitted focus
          // release. An unpaired recipient never mints keyboard authority.
          inputRevoked = true
          return nil
        }
    }
    if kind == 0x4000 && !suppress && approvedRoot != nil {
      // Unknown or unpaired focus notifications never leave agent dispatch
      // authorized merely because their PID/birth metadata was unavailable.
      inputRevoked = true
      for key in Array(policies.keys) { policies[key]?.revokeFutureAdmission() }
      auxiliaryPolicy.revokeFutureAdmission()
    }
    return suppress ? nil : pass
  }
}

private struct SyntheticFocus {
  let app: NSRunningApplication
  let birth: ProcessIdentity
  var believesActive = false
  var believesFocused = false
}

private final class RetainedSyntheticFocus: @unchecked Sendable {
  let focus: SyntheticFocus
  let session: String
  let windowID: CGWindowID
  private let lock = NSLock()
  private var live = true
  init(_ focus: SyntheticFocus, session: String, windowID: CGWindowID) { self.focus = focus; self.session = session; self.windowID = windowID }
  var isLive: Bool { lock.lock(); defer { lock.unlock() }; return live }
  @discardableResult func revoke() -> Bool { lock.lock(); defer { lock.unlock() }; let previous = live; live = false; return previous }
}

private struct InputRecipient {
  let root: FocusProcess
  let recipient: FocusProcess
  let windowID: CGWindowID
  let bounds: CGRect
}

@MainActor
private final class GlideService {
  private let allowed: [String: URL]
  private let authority: ConnectionAuthority
  private let inputMode: InputMode
  private var snapshots: [String: Snapshot] = [:]
  private var sessionIDs: Set<String> = []
  private var currentSession = "standalone"
  private var currentWindowID: CGWindowID?
  private var armedSession: String?
  private var menuGuard: GlideMenuGuard?
  private var menuRoot: AXUIElement?
  private var menuProcess: FocusProcess?
  private var menuOwner: FocusProcess?
  private var menuSession: String?
  private var menuGeneration: UInt64?
  private var nextIndex = 0
  private var revision = 0
  private let windowInvalidations = WindowInvalidations()
  private var deadline: UInt64 = 0
  private var heldKeys: [(NSRunningApplication, ProcessIdentity, FocusProcess, CGKeyCode)] = []
  private var heldMouse: HeldPointer?
  private var nextMouseNumber = 0
  private var focusGuard: BackgroundFocusGuard?
  private var syntheticFocus: SyntheticFocus?
  private var retainedFocus: RetainedSyntheticFocus?
  private var backgroundForeground: FocusProcess?
  private var backgroundDesktops = BackgroundDesktopPolicy()
  private var backgroundActivityGeneration: UInt64?
  private var clipboardRestore: (() -> Void)?
  private var actionTrace: GlideActionTrace?
  // One native connection owns this first backend until its process retires.
  // Parallel helper capture sessions can stall in ScreenCaptureKit on macOS;
  // reject competing ownership before activation, AX reads or capture startup.
  private var inputLease: (fd: Int32, path: String)?

  init(bundleIDs: [String], installations: [String: URL] = [:], authority: ConnectionAuthority, inputMode: InputMode) throws {
    self.authority = authority
    self.inputMode = inputMode
    guard !bundleIDs.isEmpty, bundleIDs.count <= 16 else { throw Failure("An explicit application allowlist is required.") }
    guard installations.keys.allSatisfy({ bundleIDs.contains($0) }) else { throw Failure("Pinned installations cannot expand the app allowlist.") }
    var result: [String: URL] = [:]
    for bundleID in bundleIDs {
      let running = Set(NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }.compactMap { $0.bundleURL?.resolvingSymlinksInPath() })
      guard installations[bundleID] != nil || running.count <= 1, let url = (installations[bundleID] ?? running.first ?? NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID)?.resolvingSymlinksInPath()), Bundle(url: url)?.bundleIdentifier == bundleID else { throw Failure("An allowed application could not be resolved uniquely.") }
      result[bundleID] = url
    }
    allowed = result
  }

  func cleanup(retainFocus: Bool = true) {
    for (app, birth, recipient, key) in heldKeys {
      if valid(app, birth: birth), processIdentity(recipient.pid) == recipient.birth, let release = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) { actionTrace?.eventsPosted += 1; release.postToPid(recipient.pid) }
    }
    heldKeys.removeAll()
    if let held = heldMouse, valid(held.app, birth: held.birth) {
      if inputMode == .background {
        if processIdentity(held.recipient.pid) == held.recipient.birth, windowOwner(held.windowID) == held.recipient.pid,
           let event = try? WindowEvents.mouse(type: held.button == .left ? .leftMouseUp : held.button == .right ? .rightMouseUp : .otherMouseUp, point: held.point, button: held.button, count: 1, number: held.number, flags: [], windowID: held.windowID, bounds: held.bounds) {
          actionTrace?.eventsPosted += 1; event.postToPid(held.recipient.pid)
        }
      } else {
        if let release = CGEvent(mouseEventSource: nil, mouseType: held.button == .left ? .leftMouseUp : held.button == .right ? .rightMouseUp : .otherMouseUp, mouseCursorPosition: held.point, mouseButton: held.button) { actionTrace?.eventsPosted += 1; release.post(tap: .cghidEventTap) }
      }
    }
    heldMouse = nil
    clipboardRestore?(); clipboardRestore = nil
    if let retained = retainedFocus {
      let root = FocusProcess(pid: retained.focus.app.processIdentifier, birth: retained.focus.birth)
      if !retainFocus || !authority.isLive || !retained.isLive || !valid(retained.focus.app, birth: retained.focus.birth) ||
        windowOwner(retained.windowID) != root.pid ||
        backgroundActivityGeneration.map({ focusGuard?.admits(root: root, generation: $0) == true }) != true {
        retireSyntheticFocus()
      }
    }
    if retainedFocus == nil, let focus = syntheticFocus { deactivate(focus) }
    syntheticFocus = nil
    // PID posting only enqueues. Protection remains armed for queued work until
    // outside input, a new target, reset or connection retirement disarms it.
    backgroundForeground = nil
    backgroundDesktops.disarm()
    backgroundActivityGeneration = nil
  }

  func closeConnection() { cleanup(retainFocus: false); retireMenuGuard(); windowInvalidations.close(); focusGuard?.stop(); focusGuard = nil }

  private func deactivate(_ focus: SyntheticFocus) {
    if valid(focus.app, birth: focus.birth), focus.believesActive,
      NSWorkspace.shared.frontmostApplication?.processIdentifier != focus.app.processIdentifier {
      if let event = processEvent(focus.app, type: .appKitDefined, subtype: .applicationDeactivated) { actionTrace?.eventsPosted += 1; event.postToPid(focus.app.processIdentifier) }
    }
  }
  private func retireSyntheticFocus(expected: RetainedSyntheticFocus? = nil) {
    guard let retained = retainedFocus, expected.map({ $0 === retained }) ?? true else { return }
    retained.revoke(); retainedFocus = nil
    if syntheticFocus?.app.processIdentifier == retained.focus.app.processIdentifier, syntheticFocus?.birth == retained.focus.birth { syntheticFocus = nil }
    deactivate(retained.focus)
  }
  private func refreshOutsideRevoke() {
    let retained = retainedFocus
    let menu = menuGuard
    focusGuard?.setOutsideRevoke { [weak self, weak menu] in
      menu?.revoke()
      if let retained, retained.revoke() {
        Task { @MainActor [weak self] in self?.retireSyntheticFocus(expected: retained) }
      }
    }
  }

  private func processEvent(_ app: NSRunningApplication, type: NSEvent.EventType, subtype: NSEvent.EventSubtype) -> CGEvent? {
    guard let native = NSEvent.otherEvent(with: type, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: 0, context: nil, subtype: subtype.rawValue, data1: 0, data2: 0) else { return nil }
    return native.cgEvent
  }

  private func prepareBackgroundInput(_ app: NSRunningApplication, synthetic: Bool) throws {
    try checkInputOwner(app)
    let state = try snapshot(app)
    try prepareBackgroundApplication(app, birth: state.birth, synthetic: synthetic) { try self.checkInputOwner(app) }
  }

  private func prepareBackgroundApplication(_ app: NSRunningApplication, birth: ProcessIdentity, synthetic: Bool, admit: () throws -> Void) throws {
    try checkInputProcessOwner(app, birth: birth)
    let windowID = try selectedNativeWindow(app).id
    if let retained = retainedFocus,
      !retained.isLive || retained.focus.app.processIdentifier != app.processIdentifier || retained.focus.birth != birth ||
        retained.session != currentSession || retained.windowID != windowID || windowOwner(windowID) != app.processIdentifier {
      retireSyntheticFocus()
    }
    if let menuOwner, let menuRoot {
      let root = FocusProcess(pid: app.processIdentifier, birth: birth)
      let current = menuOwner == root && menuSession == currentSession ? AXMenuContext.find(root: root, window: (try? snapshot(app))?.window, identity: processIdentity) : nil
      if current.map({ CFEqual($0.element, menuRoot) }) != true { retireMenuGuard() }
    }
    guard !app.isHidden else { throw Failure("Background control does not unhide applications.") }
    guard let front = NSWorkspace.shared.frontmostApplication,
          let frontBirth = processIdentity(front.processIdentifier) else { throw Failure("Foreground ownership is unavailable for background input.") }
    guard backgroundDesktops.arm(ActiveDesktops.current()) else { throw Failure("Active desktop identity is unavailable. Background control refused before input.") }
    backgroundForeground = FocusProcess(pid: front.processIdentifier, birth: frontBirth)
    if focusGuard == nil { focusGuard = try BackgroundFocusGuard(authority: authority) }
    backgroundActivityGeneration = try focusGuard!.register(app.processIdentifier, birth: birth, retainedForeground: backgroundForeground!, previousGeneration: backgroundActivityGeneration)
    armedSession = currentSession
    try prepareIncomingFocus(app, birth: birth)
    guard synthetic, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier else { return }
    // PID posting enqueues work. Keep one exact process/session/window belief
    // across requests so cleanup cannot deactivate a menu before queued input
    // creates it. Retention grants no new focus or input admission.
    if let retained = retainedFocus, retained.isLive,
      retained.focus.believesActive, retained.focus.believesFocused {
      try admit()
      syntheticFocus = retained.focus
      return
    }
    var focus = SyntheticFocus(app: app, birth: birth)
    guard let activation = processEvent(app, type: .appKitDefined, subtype: .applicationActivated),
          let notificationType = NSEvent.EventType(rawValue: 21),
          let returnedSubtype = NSEvent.EventSubtype(rawValue: Int16(bitPattern: 0x8000)),
          let returned = processEvent(app, type: notificationType, subtype: returnedSubtype) else { throw Failure("Background activation events could not be constructed. No foreground fallback was attempted.") }
    try admit()
    actionTrace?.post("focus-preparation"); activation.postToPid(app.processIdentifier); focus.believesActive = true
    syntheticFocus = focus
    try admit()
    actionTrace?.post("focus-preparation"); returned.postToPid(app.processIdentifier); focus.believesFocused = true
    syntheticFocus = focus
    retainedFocus = RetainedSyntheticFocus(focus, session: currentSession, windowID: windowID)
    refreshOutsideRevoke()
  }
  private func prepareIncomingFocus(_ app: NSRunningApplication, birth: ProcessIdentity, knownRecipient: FocusProcess? = nil) throws {
    guard inputMode == .background, let generation = backgroundActivityGeneration, let focus = focusGuard else { return }
    try checkInputProcessOwner(app, birth: birth)
    let root = FocusProcess(pid: app.processIdentifier, birth: birth)
    let proofs = BackgroundIncomingFocusResolver.prepare(root: root, generation: generation, knownRecipient: knownRecipient, identity: processIdentity)
    try checkInputProcessOwner(app, birth: birth)
    if let proof = proofs.first { try focus.registerAuxiliary(proof) }
  }

  private func checkDeadline() throws {
    guard authority.isLive else { throw Failure("Glide connection was revoked. An already-dispatched event may have taken effect.") }
    guard DispatchTime.now().uptimeNanoseconds < deadline else { throw Failure("Native operation expired. An already-dispatched event may have taken effect.") }
    if let lease = inputLease {
      var held = stat(), named = stat()
      guard fstat(lease.fd, &held) == 0, lstat(lease.path, &named) == 0,
            held.st_dev == named.st_dev, held.st_ino == named.st_ino,
            held.st_uid == getuid(), held.st_mode & S_IFMT == S_IFREG,
            held.st_mode & 0o077 == 0, held.st_nlink == 1 else { throw Failure("Glide input lock changed identity. Reset this connection.") }
    }
  }
  private func valid(_ application: NSRunningApplication, birth: ProcessIdentity? = nil) -> Bool {
    guard !application.isTerminated, let id = application.bundleIdentifier,
          let path = application.bundleURL?.resolvingSymlinksInPath(), allowed[id]?.path == path.path,
          let currentBirth = processIdentity(application.processIdentifier),
          let current = NSRunningApplication(processIdentifier: application.processIdentifier),
          current.bundleURL?.resolvingSymlinksInPath().path == path.path else { return false }
    return birth == nil || birth == currentBirth
  }

  private func applications() -> [NSRunningApplication] { NSWorkspace.shared.runningApplications.filter { valid($0) } }
  private func resolve(_ name: String) throws -> NSRunningApplication {
    var candidates = matchingApplications(name)
    if candidates.count > 1, let currentWindowID, let owner = windowOwner(currentWindowID) { candidates = candidates.filter { $0.processIdentifier == owner } }
    guard candidates.count == 1, let app = candidates.first else { throw Failure("Application is not allowed, not running, or ambiguous. Use listApps and its exact path.") }
    return app
  }
  private func matchingApplications(_ name: String) -> [NSRunningApplication] {
    applications().filter { $0.bundleIdentifier == name || $0.bundleURL?.resolvingSymlinksInPath().path == name || $0.localizedName?.caseInsensitiveCompare(name) == .orderedSame }
  }
  private func nativeWindows(_ app: NSRunningApplication, metadataOnly: Bool = false) throws -> [NativeWindow] {
    if metadataOnly { try checkDeadline() } else { try checkInputProcessOwner(app) }
    guard let birth = processIdentity(app.processIdentifier), valid(app, birth: birth) else { throw Failure("Window inventory application identity changed.") }
    guard let information = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]], information.count <= 4096 else { throw Failure("Native window inventory is unavailable or exceeds its bound.") }
    var result: [NativeWindow] = []
    for info in information {
      guard integer(info[kCGWindowOwnerPID as String]) == Int(app.processIdentifier), integer(info[kCGWindowLayer as String]) == 0,
        let id = integer(info[kCGWindowNumber as String]), id > 0, id <= UInt32.max,
        let raw = info[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary),
        bounds.minX.isFinite, bounds.minY.isFinite, bounds.width.isFinite, bounds.height.isFinite,
        abs(bounds.minX) <= 100_000, abs(bounds.minY) <= 100_000, bounds.width > 1, bounds.height > 1, bounds.width <= 100_000, bounds.height <= 100_000,
        (number(info[kCGWindowAlpha as String]) ?? 1) > 0 else { continue }
      result.append(NativeWindow(id: CGWindowID(id), bounds: bounds, title: String((info[kCGWindowName as String] as? String ?? "").prefix(1024)), onScreen: (info[kCGWindowIsOnscreen as String] as? Bool) ?? false))
      guard result.count <= 64 else { throw Failure("Application window inventory exceeds its bound.") }
    }
    guard valid(app, birth: birth) else { throw Failure("Window inventory application changed generation.") }
    return result
  }
  private func exactWindow(_ app: NSRunningApplication, id: CGWindowID) throws -> NativeWindow {
    let matches = try nativeWindows(app).filter { $0.id == id }
    guard matches.count == 1 else { throw Failure("The selected native window no longer belongs to the admitted application. Obtain fresh state.") }
    return matches[0]
  }
  private func matchingWindow(_ left: NativeWindow, _ right: NativeWindow) -> Bool {
    left.id == right.id && sameFrame(left.bounds, right.bounds) && left.title == right.title
  }
  private func accessibilityWindows(_ app: NSRunningApplication) -> [AXUIElement] {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 0.3)
    var candidates: [AXUIElement] = []
    for name in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
      if let window = elementAttribute(root, name) { candidates.append(window) }
    }
    if let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] { candidates.append(contentsOf: windows.prefix(64)) }
    var result: [AXUIElement] = []
    var cursor = 0
    while cursor < candidates.count && cursor < 128 {
      let candidate = candidates[cursor]; cursor += 1
      var pid: pid_t = 0
      AXUIElementSetMessagingTimeout(candidate, 0.2)
      let role = stringAttribute(candidate, kAXRoleAttribute)
      guard AXUIElementGetPid(candidate, &pid) == .success, pid == app.processIdentifier,
        role == kAXWindowRole || role == kAXSheetRole,
        !result.contains(where: { CFEqual($0, candidate) }) else { continue }
      result.append(candidate)
      // A native sheet has its own WindowServer ID and may be wider than its
      // parent. Expose its AX handle only through that exact parent relationship
      // so explicit window selection keeps its normal bounds/ownership fences.
      for child in children(candidate) where candidates.count < 128 {
        if stringAttribute(child, kAXRoleAttribute) == kAXSheetRole { candidates.append(child) }
      }
    }
    return result
  }
  private func accessibilityWindow(_ app: NSRunningApplication, server: NativeWindow) -> AXUIElement? {
    let matches = accessibilityWindows(app).filter { window in
      if let id = WindowReferences.id(window) { return id == server.id }
      return frame(window).map { sameFrame($0, server.bounds) } ?? false
    }
    return matches.count == 1 ? matches[0] : nil
  }
  private func selectedNativeWindow(_ app: NSRunningApplication) throws -> NativeWindow {
    let windows = try nativeWindows(app)
    if let id = currentWindowID {
      guard let window = windows.first(where: { $0.id == id }) else { throw Failure("Selected window is unavailable. Use listWindows to choose an exact current window ID.") }
      return window
    }
    guard windows.count == 1, let window = windows.first else { throw Failure("Application window selection is absent or ambiguous. Use listWindows and an explicit windowId.") }
    return window
  }
  private func currentWindow(_ app: NSRunningApplication) throws -> AXUIElement {
    let server = try selectedNativeWindow(app)
    guard let window = accessibilityWindow(app, server: server) else { throw Failure("Accessibility is unavailable for the selected window. Obtain an image observation and use window coordinates.") }
    return window
  }
  private func snapshotKey(_ app: NSRunningApplication, id: CGWindowID) throws -> String {
    guard let path = app.bundleURL?.resolvingSymlinksInPath().path else { throw Failure("Application path is unavailable.") }
    return currentSession + "\u{0}" + path + "\u{0}" + String(id)
  }
  private func pruneWindowInvalidations() {
    var scopes: [FocusProcess: Set<CGWindowID>] = [:]
    for state in snapshots.values { scopes[FocusProcess(pid: state.application.processIdentifier, birth: state.birth), default: []].insert(state.windowID) }
    windowInvalidations.retain(scopes)
  }
  private func validate(_ state: Snapshot, _ app: NSRunningApplication) throws {
    guard valid(app, birth: state.birth), matchingWindow(try exactWindow(app, id: state.windowID), state.serverWindow) else { throw Failure("Application or native window changed. Obtain fresh state before acting.") }
    if let expected = state.windowGeneration {
      guard windowInvalidations.generation(FocusProcess(pid: app.processIdentifier, birth: state.birth), id: state.windowID) == expected else { throw Failure("Selected window changed after observation. Obtain fresh state before acting.") }
    }
    if let window = state.window {
      var pid: pid_t = 0
      guard AXUIElementGetPid(window, &pid) == .success, pid == app.processIdentifier,
        WindowReferences.id(window).map({ $0 == state.windowID }) ?? true,
        let previous = state.axBounds, let current = frame(window), sameFrame(previous, current) else { throw Failure("Accessibility window changed. Obtain fresh state before acting.") }
    }
  }
  private func snapshot(_ app: NSRunningApplication) throws -> Snapshot {
    let server = try selectedNativeWindow(app)
    guard let state = snapshots[try snapshotKey(app, id: server.id)] else { throw Failure("This session has no observation of the selected window. Obtain fresh app state before acting.") }
    try validate(state, app)
    return state
  }
  private func retireMenuGuard() {
    menuGuard?.revoke(); menuGuard?.stop()
    menuGuard = nil; menuRoot = nil; menuProcess = nil; menuOwner = nil; menuSession = nil; menuGeneration = nil
    refreshOutsideRevoke()
  }
  private func menuWindow(_ element: AXUIElement, recipient: FocusProcess, axBounds: CGRect) throws -> (id: CGWindowID, bounds: CGRect) {
    try checkDeadline()
    guard processIdentity(recipient.pid) == recipient.birth,
      let information = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]], information.count <= 4096 else { throw Failure("Menu native window inventory is unavailable.") }
    // AppKit's AXMenu can report its parent document's window ID even while
    // tracking in a separate native menu window. Only an exact owned window
    // with the observed menu geometry can replace that inherited reference.
    let reference = AXRecipientResolver.windowReference(element: element)?.id
    var candidates: [MenuWindowPolicy.Candidate] = []
    for info in information {
      guard let owner = integer(info[kCGWindowOwnerPID as String]), owner > 0, owner <= Int32.max,
        let id = integer(info[kCGWindowNumber as String]), id > 0, id <= UInt32.max,
        let layer = integer(info[kCGWindowLayer as String]),
        let raw = info[kCGWindowBounds as String] as? [String: Any], let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
      candidates.append(.init(id: CGWindowID(id), owner: Int32(owner), layer: layer, bounds: bounds, alpha: number(info[kCGWindowAlpha as String]) ?? 1))
    }
    guard let match = MenuWindowPolicy.select(recipient: recipient.pid, reference: reference, bounds: axBounds, candidates: candidates), processIdentity(recipient.pid) == recipient.birth else { throw Failure("The active menu has no unique owned native window matching its observed bounds. Obtain fresh state.") }
    return (match.id, match.bounds)
  }
  private func refreshMenuGuard(_ app: NSRunningApplication, window: AXUIElement? = nil) throws {
    guard inputMode == .background, let birth = processIdentity(app.processIdentifier),
      let focus = focusGuard, let generation = backgroundActivityGeneration else { retireMenuGuard(); return }
    let root = FocusProcess(pid: app.processIdentifier, birth: birth)
    guard let context = AXMenuContext.find(root: root, window: window ?? (try? snapshot(app))?.window, identity: processIdentity) else { retireMenuGuard(); return }
    if let recipient = context.menuProcess {
      try focus.registerRecipient(root: root, recipient: recipient)
      try prepareIncomingFocus(app, birth: birth, knownRecipient: recipient)
    }
    if let menuGuard, let menuRoot, menuOwner == root, menuSession == currentSession, menuGeneration == generation, menuProcess == context.menuProcess, CFEqual(menuRoot, context.element) {
      try menuGuard.validate()
      return
    }
    retireMenuGuard()
    let authority = self.authority
    let guard_ = try GlideMenuGuard(root: root, menu: context.menuProcess, identity: { pid in
      guard authority.isLive, focus.admits(root: root, generation: generation) else { return nil }
      return processIdentity(pid)
    })
    do { try checkInputProcessOwner(app, birth: birth); try guard_.validate() }
    catch { guard_.revoke(); guard_.stop(); throw error }
    menuGuard = guard_; menuRoot = context.element; menuProcess = context.menuProcess; menuOwner = root; menuSession = currentSession; menuGeneration = generation
    refreshOutsideRevoke()
  }
  private func inputRecipient(_ app: NSRunningApplication, point: CGPoint? = nil, observedElement: AXUIElement? = nil) throws -> InputRecipient {
    let state = try snapshot(app)
    let root = FocusProcess(pid: app.processIdentifier, birth: state.birth)
    let observedMenu: ObservedMenu?
    if let point, let menu = state.menu, menu.bounds.contains(point), menu.axBounds.contains(point) {
      guard menuSession == currentSession, menuOwner == root, menuRoot.map({ CFEqual($0, menu.element) }) == true,
        processIdentity(menu.recipient.pid) == menu.recipient.birth,
        let bounds = windowBounds(menu.windowID, owner: menu.recipient.pid), sameFrame(bounds, menu.bounds),
        let axBounds = frame(menu.element), sameFrame(axBounds, menu.axBounds) else { throw Failure("Observed menu window changed. Obtain fresh state.") }
      observedMenu = menu
    } else { observedMenu = nil }
    var element: AXUIElement? = observedElement
    if let point, state.window != nil {
      if inputMode == .background && element == nil {
        let candidates = state.nodes.filter { $0.value.bounds?.contains(point) == true }
        if let deepest = candidates.map({ $0.value.depth }).max() {
          let leaves = candidates.filter { $0.value.depth == deepest }.sorted { $0.key < $1.key }
          // The same AX object can appear through duplicate tree paths. Only
          // CFEqual proves equivalence; sharing geometry/role alone does not.
          var unique: [(key: Int, value: NodeRecord)] = []
          for leaf in leaves where !unique.contains(where: { CFEqual($0.value.element, leaf.value.element) }) { unique.append(leaf) }
          guard unique.count == 1, let leaf = unique.first else {
            let details: [[String: Any]] = unique.prefix(8).compactMap { leaf in
              guard let bounds = leaf.value.bounds else { return nil }
              return ["index": leaf.key, "role": String(leaf.value.role.prefix(128)), "bounds": ["x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height]]
            }
            throw Failure("Observed coordinate target has \(unique.count) distinct deepest candidates. Use a listed element index or a different point after refreshing state.", candidates: details)
          }
          element = try node(["element_index": leaf.key], app).element
        }
      }
      var hit: AXUIElement?
      if element == nil, AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(app.processIdentifier), Float(point.x), Float(point.y), &hit) == .success,
        let hit, let rectangle = frame(hit), rectangle.contains(point) { element = hit }
      if element == nil, let observedMenu { element = observedMenu.element }
    } else if state.window != nil && element == nil {
      element = elementAttribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute)
    }
    if let target = element {
      var pid: pid_t = 0
      guard AXUIElementGetPid(target, &pid) == .success,
        pid == root.pid || (menuOwner == root && menuSession == currentSession && menuProcess?.pid == pid && processIdentity(pid) == menuProcess?.birth) else { throw Failure("Input target escaped the approved accessibility application/menu relationship.") }
      var ancestor: AXUIElement? = target, visited: [AXUIElement] = []
      var belongs = false
      while let value = ancestor, visited.count < 64, !visited.contains(where: { CFEqual($0, value) }) {
        visited.append(value)
        if state.window.map({ CFEqual(value, $0) }) == true || WindowReferences.id(value) == state.windowID { belongs = true; break }
        ancestor = elementAttribute(value, kAXParentAttribute)
      }
      if !belongs, let menuRoot, menuSession == currentSession { belongs = visited.contains(where: { CFEqual($0, menuRoot) }) }
      guard belongs else { throw Failure("Focused input element is outside the observed window/menu. Obtain fresh state.") }
    }
    let route = try AXRecipientResolver.resolve(root: root, element: element, needsWindow: point != nil, identity: processIdentity)
    try checkInputProcessOwner(app, birth: state.birth)
    guard processIdentity(route.recipient.pid) == route.recipient.birth else { throw Failure("Input recipient changed process generation.") }
    if let menu = observedMenu {
      guard route.recipient == menu.recipient else { throw Failure("Observed menu recipient changed. Obtain fresh state.") }
      if route.isHosted && inputMode == .background {
        try focusGuard?.registerRecipient(root: root, recipient: route.recipient)
        try prepareIncomingFocus(app, birth: state.birth, knownRecipient: route.recipient)
      }
      return InputRecipient(root: root, recipient: menu.recipient, windowID: menu.windowID, bounds: menu.bounds)
    }
    if route.isHosted {
      if inputMode == .background {
        try focusGuard?.registerRecipient(root: root, recipient: route.recipient)
        try prepareIncomingFocus(app, birth: state.birth, knownRecipient: route.recipient)
      }
      if let point {
        guard let id = route.hostedWindowID, let window = route.hostedWindow, let hitBounds = frame(window), hitBounds.contains(point),
          let bounds = windowBounds(id, owner: route.recipient.pid), bounds.contains(point), state.bounds.contains(point) else { throw Failure("Hosted input window ownership or coordinates are unconfirmed.") }
        return InputRecipient(root: root, recipient: route.recipient, windowID: id, bounds: bounds)
      }
    }
    return InputRecipient(root: root, recipient: route.recipient, windowID: state.windowID, bounds: state.bounds)
  }
  private func validateRecipient(_ route: InputRecipient, _ app: NSRunningApplication) throws {
    try checkInputProcessOwner(app, birth: route.root.birth)
    let observedWindowID = try snapshot(app).windowID
    guard processIdentity(route.recipient.pid) == route.recipient.birth,
      windowOwner(route.windowID) == route.recipient.pid || route.windowID == observedWindowID else { throw Failure("Input recipient or native window ownership changed.") }
    if route.windowID != observedWindowID {
      guard let bounds = windowBounds(route.windowID, owner: route.recipient.pid), sameFrame(bounds, route.bounds) else { throw Failure("Hosted native window moved after routing. Obtain fresh state.") }
    }
    try menuGuard?.validate()
  }
  private func node(_ input: [String: Any], _ app: NSRunningApplication) throws -> NodeRecord {
    let state = try snapshot(app)
    guard state.window != nil else { throw Failure("Accessibility is unavailable for this window. Use image coordinates; no accessibility element indices were issued.") }
    guard let index = integer(input["element_index"]), let node = state.nodes[index], stringAttribute(node.element, kAXRoleAttribute) == node.role, stringAttribute(node.element, kAXIdentifierAttribute) == node.identifier, stringAttribute(node.element, kAXTitleAttribute) == node.title else { throw Failure("Element reference is stale. Obtain fresh app state.") }
    var pid: pid_t = 0
    guard AXUIElementGetPid(node.element, &pid) == .success else { throw Failure("Element process is unavailable.") }
    if pid != app.processIdentifier {
      let root = FocusProcess(pid: app.processIdentifier, birth: state.birth)
      guard menuOwner == root, menuSession == currentSession, let menuProcess, menuProcess.pid == pid,
        processIdentity(pid) == menuProcess.birth, let menuRoot else { throw Failure("Element no longer belongs to the admitted application/menu relationship.") }
      var value: AXUIElement? = node.element, visited: [AXUIElement] = []
      while let current = value, visited.count < 300, !visited.contains(where: { CFEqual($0, current) }) {
        visited.append(current)
        if CFEqual(current, menuRoot) { break }
        value = elementAttribute(current, kAXParentAttribute)
      }
      guard visited.contains(where: { CFEqual($0, menuRoot) }) else { throw Failure("Element escaped the exact admitted menu subtree.") }
    }
    if let old = node.bounds { guard let current = frame(node.element), sameFrame(old, current) else { throw Failure("Element moved. Obtain fresh app state.") } }
    return node
  }
  private func point(_ input: [String: Any], _ app: NSRunningApplication) throws -> CGPoint {
    if input["element_index"] != nil {
      guard input["x"] == nil, input["y"] == nil, let bounds = try node(input, app).bounds, !bounds.isEmpty else { throw Failure("Choose one element index or one coordinate pair.") }
      return CGPoint(x: bounds.midX, y: bounds.midY)
    }
    guard let x = number(input["x"]), let y = number(input["y"]), abs(x) <= 100_000, abs(y) <= 100_000 else { throw Failure("An observed element or finite coordinate pair is required.") }
    let result = CGPoint(x: x, y: y)
    let state = try snapshot(app)
    guard state.bounds.contains(result) || state.menu.map({ $0.bounds.contains(result) && $0.axBounds.contains(result) }) == true else { throw Failure("Coordinates are outside the observed application window/menu.") }
    return result
  }
  private func focus(_ app: NSRunningApplication) async throws {
    try checkDeadline()
    guard let birth = processIdentity(app.processIdentifier), valid(app, birth: birth) else { throw Failure("Application identity changed before activation.") }
    actionTrace?.stage = "foreground-activation"
    actionTrace?.lifecycleDispatched = true
    if app.isHidden {
      try checkDeadline()
      try setAttribute(AXUIElementCreateApplication(app.processIdentifier), kAXHiddenAttribute, kCFBooleanFalse, trace: actionTrace) {
        try checkDeadline()
        guard valid(app, birth: birth) else { throw Failure("Application identity changed before unhide.") }
      }
    }
    try checkDeadline()
    guard app.activate(options: []) else { throw Failure("Could not activate the admitted application.") }
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
      try checkDeadline()
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    guard valid(app, birth: birth) else { throw Failure("Application identity changed during activation.") }
    let window = try currentWindow(app)
    if actionNames(window).contains(kAXRaiseAction) {
      try perform(window, kAXRaiseAction, trace: actionTrace) { try checkInputProcessOwner(app, birth: birth) }
    }
  }
  private func checkInputProcessOwner(_ app: NSRunningApplication, birth: ProcessIdentity? = nil) throws {
    try checkDeadline()
    if inputMode == .background {
      try focusGuard?.check(backgroundActivityGeneration)
      if let expected = backgroundForeground {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == expected.pid,
              processIdentity(expected.pid) == expected.birth else { throw Failure("Desktop focus changed during background input. Further input stopped; inspect fresh state.") }
      }
      if backgroundDesktops.isArmed {
        guard backgroundDesktops.admits(ActiveDesktops.current()) else { throw Failure("Active desktop changed during background control. Further input stopped; inspect fresh state.") }
      }
    }
    guard valid(app, birth: birth) else {
      let cause = app.isTerminated ? "application terminated" : processIdentity(app.processIdentifier) == nil ? "process unavailable" : "application identity changed"
      throw Failure("Input ownership changed (\(cause)). Inspect app state before continuing.")
    }
    guard inputMode == .background || NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier else { throw Failure("Input ownership changed. Inspect app state before continuing.") }
  }
  private func checkInputOwner(_ app: NSRunningApplication) throws {
    try checkInputProcessOwner(app)
    let state = try snapshot(app)
    if inputMode == .background {
      guard !app.isHidden, state.window.map({ (attribute($0, kAXMinimizedAttribute) as? Bool) != true }) ?? true else { throw Failure("Background target window is hidden or minimized. Obtain fresh app state.") }
    }
    try checkInputProcessOwner(app, birth: state.birth)
  }
  private func checkHit(_ point: CGPoint, _ app: NSRunningApplication) throws {
    try checkInputOwner(app)
    if inputMode == .background {
      let state = try snapshot(app)
      guard state.bounds.contains(point) || state.menu.map({ $0.bounds.contains(point) && $0.axBounds.contains(point) }) == true else { throw Failure("Background point is outside the observed window/menu.") }
      return
    }
    var hit: AXUIElement?
    var pid: pid_t = 0
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &hit) == .success, let hit, AXUIElementGetPid(hit, &pid) == .success, pid == app.processIdentifier else { throw Failure("The target point is obscured or belongs to another application.") }
    let state = try snapshot(app)
    guard let hitWindow = elementAttribute(hit, kAXWindowAttribute), state.window.map({ CFEqual(hitWindow, $0) }) ?? (WindowReferences.id(hitWindow) == state.windowID) else { throw Failure("The target point belongs to a different or unknown window.") }
  }
  private func keyEvents(_ app: NSRunningApplication, key: CGKeyCode, flags: CGEventFlags, duration: Double = 0) async throws {
    try checkInputOwner(app)
    let route = try inputRecipient(app)
    guard duration >= 0, duration <= 5, let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) else { throw Failure("Invalid key event.") }
    down.flags = flags; up.flags = flags
    let birth = route.root.birth
    try validateRecipient(route, app)
    if route.recipient != route.root { diagnostic("hosted.keyboard") }
    heldKeys.append((app, birth, route.recipient, key))
    actionTrace?.post("key-down"); down.postToPid(route.recipient.pid)
    try? FileHandle.standardError.write(contentsOf: Data("glide.phase=key.down\n".utf8))
    defer { if valid(app, birth: birth), processIdentity(route.recipient.pid) == route.recipient.birth { actionTrace?.eventsPosted += 1; up.postToPid(route.recipient.pid) }; heldKeys.removeAll { $0.0 === app && $0.2 == route.recipient && $0.3 == key } }
    if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000)); try checkDeadline() }
  }
  private func parseKey(_ text: String) throws -> (CGKeyCode, CGEventFlags) {
    let pieces = text.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let key = pieces.last else { throw Failure("A key is required.") }
    var flags: CGEventFlags = []
    for modifier in pieces.dropLast() {
      switch modifier {
      case "super", "cmd", "command", "meta": flags.insert(.maskCommand)
      case "ctrl", "control": flags.insert(.maskControl)
      case "alt", "option": flags.insert(.maskAlternate)
      case "shift": flags.insert(.maskShift)
      default: throw Failure("Unknown key modifier.")
      }
    }
    let keys: [String: Int] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"return":36,"enter":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,"tab":48,"space":49,"`":50,"backspace":51,"escape":53,"esc":53,"delete":117,"home":115,"end":119,"pageup":116,"pagedown":121,"left":123,"arrowleft":123,"right":124,"arrowright":124,"down":125,"arrowdown":125,"up":126,"arrowup":126,"f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111]
    guard let value = keys[key] else { throw Failure("Unsupported key name. Use typeText for Unicode text.") }
    return (CGKeyCode(value), flags)
  }
  private func mouse(_ app: NSRunningApplication, point: CGPoint, button: CGMouseButton, down: Bool, flags: CGEventFlags = [], count: Int = 1, dragged: Bool = false, observedElement: AXUIElement? = nil) async throws {
    try checkInputOwner(app)
    let state = try snapshot(app)
    let route: InputRecipient
    if let held = heldMouse {
      route = InputRecipient(root: FocusProcess(pid: app.processIdentifier, birth: held.birth), recipient: held.recipient, windowID: held.windowID, bounds: held.bounds)
      guard held.app === app, route.bounds.contains(point) else { throw Failure("Held pointer target changed. Obtain fresh state.") }
    } else { route = try inputRecipient(app, point: point, observedElement: observedElement) }
    let type: CGEventType = dragged ? (button == .left ? .leftMouseDragged : button == .right ? .rightMouseDragged : .otherMouseDragged) : down ? (button == .left ? .leftMouseDown : button == .right ? .rightMouseDown : .otherMouseDown) : (button == .left ? .leftMouseUp : button == .right ? .rightMouseUp : .otherMouseUp)
    if down && !dragged { nextMouseNumber = nextMouseNumber >= Int(Int32.max) ? 1 : nextMouseNumber + 1 }
    let number = heldMouse?.number ?? nextMouseNumber
    let event: CGEvent
    if inputMode == .background {
      guard let nativeType = NSEvent.EventType(rawValue: UInt(type.rawValue)) else { throw Failure("Unsupported background pointer event.") }
      if down && !dragged, let menu = state.menu, menu.windowID == route.windowID {
        // Native menu tracking updates its highlighted item on pointer motion;
        // a down/up pair alone can activate the previously highlighted item.
        // Address this motion to the exact admitted menu without moving the
        // human pointer or posting to the desktop's global event stream.
        let moved = try WindowEvents.mouse(type: .mouseMoved, point: point, button: button, count: 0, number: number, flags: flags, windowID: route.windowID, bounds: route.bounds)
        try validateRecipient(route, app)
        actionTrace?.post("menu-motion"); moved.postToPid(route.recipient.pid)
        // PID delivery is queued and native menu tracking coalesces motion.
        // Pace distinct event types as the inspected driver does; every wait
        // remains inside this request's original deadline and activity fence.
        try await Task.sleep(nanoseconds: 10_000_000)
        try validateRecipient(route, app)
      }
      event = try WindowEvents.mouse(type: nativeType, point: point, button: button, count: count, number: number, flags: flags, windowID: route.windowID, bounds: route.bounds)
    } else {
      guard let created = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw Failure("Could not create pointer event.") }
      event = created; event.flags = flags
      event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
    }
    try validateRecipient(route, app)
    if down && !dragged && route.recipient != route.root { diagnostic("hosted.pointer") }
    if down { heldMouse = HeldPointer(app: app, birth: state.birth, recipient: route.recipient, windowID: route.windowID, bounds: route.bounds, point: point, button: button, number: number) }
    actionTrace?.post(dragged ? "pointer-drag" : down ? "pointer-down" : "pointer-up")
    if inputMode == .background { event.postToPid(route.recipient.pid) }
    else { event.post(tap: .cghidEventTap) }
    if !down && !dragged { heldMouse = nil }
  }

  private func shareableWindow(_ app: NSRunningApplication, id: CGWindowID) async throws -> SCWindow {
    diagnostic("capture.inventory")
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    try checkInputProcessOwner(app)
    let matches = content.windows.filter { $0.windowID == id && $0.owningApplication?.processID == app.processIdentifier }
    guard matches.count == 1 else { throw Failure("Selected native window is absent from the exact owned ScreenCaptureKit inventory. Obtain fresh state.") }
    return matches[0]
  }

  private struct CaptureWindowProof {
    let element: AXUIElement
    let parent: AXUIElement?
    let native: NativeWindow
    let generation: UInt64?
  }
  private func captureFamily(_ app: NSRunningApplication, window: AXUIElement?, server: NativeWindow, before stop: UInt64) throws -> ([CaptureWindowProof], CGRect) {
    guard let window, let birth = processIdentity(app.processIdentifier) else { return ([], server.bounds) }
    let root = FocusProcess(pid: app.processIdentifier, birth: birth)
    var base = window, current: AXUIElement? = window, ancestors: [AXUIElement] = []
    while let element = current {
      guard DispatchTime.now().uptimeNanoseconds < stop else { throw ObservationChanged() }
      guard ancestors.count < 64, !ancestors.contains(where: { CFEqual($0, element) }) else { throw Failure("Capture window ancestry is unavailable or ambiguous.") }
      ancestors.append(element)
      var pid: Int32 = 0
      guard AXUIElementGetPid(element, &pid) == .success, pid == root.pid else { throw Failure("Capture ancestry escaped the approved application.") }
      let role = stringAttribute(element, kAXRoleAttribute)
      if role == kAXApplicationRole { break }
      if role == kAXWindowRole || role == kAXSheetRole { base = element }
      current = elementAttribute(element, kAXParentAttribute)
    }
    var stack = [base], visited: [AXUIElement] = [], proofs: [CaptureWindowProof] = [], bounds = server.bounds
    while let element = stack.popLast() {
      guard DispatchTime.now().uptimeNanoseconds < stop else { throw ObservationChanged() }
      if visited.contains(where: { CFEqual($0, element) }) { continue }
      guard visited.count < 64 else { throw Failure("Capture window family exceeds its bound.") }
      visited.append(element)
      var pid: Int32 = 0
      guard AXUIElementGetPid(element, &pid) == .success, pid == root.pid, let id = WindowReferences.id(element), let rectangle = frame(element) else { throw ObservationChanged() }
      let native = try exactWindow(app, id: id)
      guard sameFrame(rectangle, native.bounds) else { throw ObservationChanged() }
      let generation = try windowInvalidations.watch(root, window: element, id: id)
      proofs.append(CaptureWindowProof(element: element, parent: elementAttribute(element, kAXParentAttribute), native: native, generation: generation))
      bounds = bounds.union(native.bounds)
      for child in children(element) where stringAttribute(child, kAXRoleAttribute) == kAXSheetRole { stack.append(child) }
      guard stack.count <= 64 else { throw Failure("Capture window family exceeds its bound.") }
    }
    guard proofs.contains(where: { $0.native.id == server.id }), bounds.width <= 100_000, bounds.height <= 100_000 else { throw ObservationChanged() }
    return (proofs, bounds)
  }
  private func capture(_ app: NSRunningApplication, window axWindow: AXUIElement?, server: NativeWindow, bounds: CGRect, captureWindow: SCWindow?, before stop: UInt64) async throws -> (String?, Int, Int) {
    let defaultWidth = max(1, Int(bounds.width)), defaultHeight = max(1, Int(bounds.height))
    guard CGPreflightScreenCaptureAccess() else { return (nil, defaultWidth, defaultHeight) }
    let window: SCWindow
    if let captureWindow { window = captureWindow }
    else { window = try await shareableWindow(app, id: server.id) }
    guard window.windowID == server.id, window.owningApplication?.processID == app.processIdentifier, sameFrame(window.frame, bounds),
      matchingWindow(try exactWindow(app, id: server.id), server) else { throw Failure("Capture window identity or geometry changed. Obtain fresh state.") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let (family, familyBounds) = try captureFamily(app, window: axWindow, server: server, before: stop)
    let scale = min(Double(filter.pointPixelScale), 2048 / max(familyBounds.width, familyBounds.height))
    let width = min(2048, max(1, Int(ceil(familyBounds.width * scale)))), height = min(2048, max(1, Int(ceil(familyBounds.height * scale))))
    let config = SCStreamConfiguration()
    config.width = width; config.height = height; config.showsCursor = false
    config.ignoreShadowsSingleWindow = true
    config.ignoreGlobalClipSingleWindow = true
    config.scalesToFit = true
    var image: CGImage
    diagnostic("capture.image")
    do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
    catch { throw Failure("Window screenshot failed (OS status \((error as NSError).code)). Inspect screen-recording access before another observation.") }
    try checkInputProcessOwner(app)
    let (currentFamily, currentFamilyBounds) = try captureFamily(app, window: axWindow, server: server, before: stop)
    guard sameFrame(currentFamilyBounds, familyBounds), currentFamily.count == family.count,
      family.allSatisfy({ previous in currentFamily.contains(where: { $0.native.id == previous.native.id && CFEqual($0.element, previous.element) }) }) else { throw ObservationChanged() }
    guard let birth = processIdentity(app.processIdentifier) else { throw ObservationChanged() }
    let root = FocusProcess(pid: app.processIdentifier, birth: birth)
    for proof in family {
      guard matchingWindow(try exactWindow(app, id: proof.native.id), proof.native),
        WindowReferences.id(proof.element) == proof.native.id, let rectangle = frame(proof.element), sameFrame(rectangle, proof.native.bounds) else { throw ObservationChanged() }
      let parent = elementAttribute(proof.element, kAXParentAttribute)
      switch (proof.parent, parent) {
      case (nil, nil): break
      case (let previous?, let current?) where CFEqual(previous, current): break
      default: throw ObservationChanged()
      }
      if let expected = proof.generation, windowInvalidations.generation(root, id: proof.native.id) != expected { throw ObservationChanged() }
    }
    if !sameFrame(familyBounds, bounds) {
      guard let crop = WindowCaptureGeometry.crop(window: bounds, family: familyBounds, width: image.width, height: image.height),
        let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let context = CGContext(data: nil, width: crop.width, height: crop.height, bitsPerComponent: 8, bytesPerRow: crop.width * 4, space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw Failure("Captured window geometry could not be normalized within its resource bounds.") }
      context.scaleBy(x: Double(crop.width) / crop.pixels.width, y: Double(crop.height) / crop.pixels.height)
      context.translateBy(x: -crop.pixels.minX, y: -(Double(image.height) - crop.pixels.maxY))
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      guard let normalized = context.makeImage() else { throw Failure("Selected window image could not be normalized.") }
      image = normalized
    }
    guard matchingWindow(try exactWindow(app, id: server.id), server),
      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 8 * 1024 * 1024 else { throw Failure("Screenshot changed ownership or exceeded its byte limit.") }
    return ("data:image/png;base64," + png.base64EncodedString(), image.width, image.height)
  }

  private func observationWindow(_ app: NSRunningApplication, includeScreenshot: Bool, stop: UInt64) async throws -> (AXUIElement?, NativeWindow, CGRect, SCWindow?) {
    guard let birth = processIdentity(app.processIdentifier) else { throw Failure("Application identity is unavailable.") }
    var lastError: Error = Failure("Application window did not settle.")
    while true {
      try checkInputProcessOwner(app, birth: birth)
      do {
        let server = try selectedNativeWindow(app)
        let window = accessibilityWindow(app, server: server)
        if (includeScreenshot || window == nil), CGPreflightScreenCaptureAccess() {
          let captureWindow = try await shareableWindow(app, id: server.id)
          let bounds = captureWindow.frame
          guard bounds.width > 0, bounds.height > 0, bounds.width <= 100_000, bounds.height <= 100_000,
            matchingWindow(try exactWindow(app, id: server.id), server) else { throw Failure("Native capture window changed while observing it.") }
          return (window, server, bounds, captureWindow)
        }
        guard let window, let bounds = frame(window), bounds.width > 0, bounds.height > 0,
          bounds.width <= 100_000, bounds.height <= 100_000 else { throw Failure("This native window has no accessibility tree. Screen Recording permission is required for its image/coordinate observation.") }
        guard sameFrame(bounds, server.bounds), matchingWindow(try exactWindow(app, id: server.id), server) else { throw Failure("Accessibility/native window geometry is still settling.") }
        return (window, server, bounds, nil)
      } catch { lastError = error }
      guard DispatchTime.now().uptimeNanoseconds < stop else { throw lastError }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  private func observe(_ app: NSRunningApplication, full: Bool, includeScreenshot: Bool) async throws -> [String: Any] {
    let stop = min(deadline, DispatchTime.now().uptimeNanoseconds + 2_000_000_000)
    defer { pruneWindowInvalidations() }
    while true {
      do { return try await collectObservation(app, full: full, includeScreenshot: includeScreenshot, stop: stop) }
      catch is ObservationChanged {
        try checkInputProcessOwner(app)
        guard DispatchTime.now().uptimeNanoseconds < stop else { throw Failure("Selected window did not settle within the bounded observation allowance.") }
        // Let already queued accessibility/window notifications run; all
        // attempts share the original two-second allowance and request fence.
        await Task.yield()
      }
    }
  }
  private func collectObservation(_ app: NSRunningApplication, full: Bool, includeScreenshot: Bool, stop: UInt64) async throws -> [String: Any] {
    diagnostic("state.window")
    let (window, server, bounds, captureWindow) = try await observationWindow(app, includeScreenshot: includeScreenshot, stop: stop)
    let id = server.id
    guard let birth = processIdentity(app.processIdentifier), let path = app.bundleURL?.resolvingSymlinksInPath().path else { throw Failure("Application window has invalid identity.") }
    diagnostic("state.ax")
    try refreshMenuGuard(app, window: window)
    let key = try snapshotKey(app, id: id)
    guard snapshots[key] != nil || (snapshots.count < 64 && snapshots.keys.filter({ $0.hasPrefix(currentSession + "\u{0}") }).count < 16) else { throw Failure("Native observation capacity reached. Retire an unused session before observing another window.") }
    let old = snapshots[key]
    let hidden = app.isHidden
    let minimized = window.map { (attribute($0, kAXMinimizedAttribute) as? Bool) == true } ?? false
    let windowGeneration = try window.map { try windowInvalidations.watch(FocusProcess(pid: app.processIdentifier, birth: birth), window: $0, id: id) } ?? nil
    var oldByHash: [CFHashCode: [(Int, NodeRecord)]] = [:]
    if let old, old.birth == birth, let previousWindow = old.window, let window, CFEqual(previousWindow, window) {
      for (index, record) in old.nodes { oldByHash[CFHash(record.element), default: []].append((index, record)) }
    }
    var records: [Int: NodeRecord] = [:], lines: [String] = [], visited: [CFHashCode: [AXUIElement]] = [:], textBytes = 0
    var stack: [(AXUIElement, Int)] = window.map { [($0, 0)] } ?? []
    if let menuRoot, menuSession == currentSession { stack.append((menuRoot, 0)) }
    let observedMenu: ObservedMenu?
    if let menuRoot, menuOwner == FocusProcess(pid: app.processIdentifier, birth: birth), menuSession == currentSession {
      guard let axBounds = frame(menuRoot) else { throw Failure("The active menu has no confirmed native bounds. Obtain fresh state before input.") }
      let recipient = menuProcess ?? FocusProcess(pid: app.processIdentifier, birth: birth)
      let native = try menuWindow(menuRoot, recipient: recipient, axBounds: axBounds)
      observedMenu = ObservedMenu(element: menuRoot, recipient: recipient, windowID: native.id, bounds: native.bounds, axBounds: axBounds)
    } else { observedMenu = nil }
    while let (element, depth) = stack.popLast(), records.count < maxNodes {
      try checkDeadline()
      let hash = CFHash(element)
      if (visited[hash] ?? []).contains(where: { CFEqual($0, element) }) { continue }
      visited[hash, default: []].append(element)
      AXUIElementSetMessagingTimeout(element, 0.2)
      let role = stringAttribute(element, kAXRoleAttribute), identifier = stringAttribute(element, kAXIdentifierAttribute), title = stringAttribute(element, kAXTitleAttribute)
      var index: Int?
      if let candidates = oldByHash[hash] { index = candidates.first { CFEqual($0.1.element, element) && $0.1.role == role && $0.1.identifier == identifier }?.0 }
      if index == nil { nextIndex += 1; index = nextIndex }
      guard let index, nextIndex < 1_000_000_000 else { throw Failure("Element identity limit reached. Reset the kernel.") }
      let rectangle = frame(element)
      records[index] = NodeRecord(element: element, role: role, identifier: identifier, title: title, bounds: rectangle, depth: depth)
      let secure = stringAttribute(element, kAXSubroleAttribute) == "AXSecureTextField"
      var details = ["\(index): \(role)"]
      for (label, value) in [("title", title), ("description", stringAttribute(element, kAXDescriptionAttribute)), ("value", secure ? "<secure>" : stringAttribute(element, kAXValueAttribute))] {
        if !value.isEmpty { let escaped = String(data: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), encoding: .utf8) ?? "\"\""; details.append("\(label)=\(escaped)") }
      }
      let actions = actionNames(element)
      for (name, label) in [(kAXEnabledAttribute, "enabled"), (kAXSelectedAttribute, "selected"), (kAXFocusedAttribute, "focused")] {
        if let value = attribute(element, name), CFGetTypeID(value) == CFBooleanGetTypeID() { details.append("\(label)=\((value as? Bool) == true)") }
      }
      let blockedReason = inputMode == .background && (hidden || minimized) ? "restore-window-first" : nil
      let available = actions.filter { blockedReason == nil && !(inputMode == .background && $0 == kAXRaiseAction) }
      let blocked = actions.filter { !available.contains($0) }.map { $0 + ":" + (blockedReason ?? "requires-foreground") }
      if !available.isEmpty { details.append("actions=\(available.joined(separator: ","))") }
      if !blocked.isEmpty { details.append("blockedActions=\(blocked.joined(separator: ","))") }
      if let rectangle { details.append("bounds=[\(rectangle.minX),\(rectangle.minY),\(rectangle.width),\(rectangle.height)]") }
      let line = String(repeating: "  ", count: depth) + details.joined(separator: " ")
      textBytes += line.utf8.count
      if textBytes > maxTextBytes { lines.append("[Accessibility text truncated]"); break }
      lines.append(line)
      if depth < 32 { for child in children(element).reversed() { stack.append((child, depth + 1)) } }
    }
    if !stack.isEmpty { lines.append("[Accessibility tree truncated]") }
    let screenshot: String?, width: Int, height: Int
    if includeScreenshot {
      diagnostic("state.capture")
      (screenshot, width, height) = try await capture(app, window: window, server: server, bounds: bounds, captureWindow: captureWindow, before: stop)
    } else { (screenshot, width, height) = (nil, max(1, Int(bounds.width)), max(1, Int(bounds.height))) }
    diagnostic("state.commit")
    guard valid(app, birth: birth) else { throw Failure("Application changed during observation. Request fresh state.") }
    guard matchingWindow(try exactWindow(app, id: id), server) else { throw ObservationChanged() }
    let axBounds = window.flatMap { frame($0) }
    if window != nil && axBounds == nil { throw Failure("Accessibility window changed during observation. Request fresh state.") }
    if let windowGeneration, windowInvalidations.generation(FocusProcess(pid: app.processIdentifier, birth: birth), id: id) != windowGeneration { throw ObservationChanged() }
    // AX traversal and capture are not atomic. Never publish menu items from
    // one state with a missing or different native menu binding from another.
    // Retry observations only, under the original absolute settling allowance.
    guard DispatchTime.now().uptimeNanoseconds < stop else { throw ObservationChanged() }
    let currentMenu = AXMenuContext.find(root: FocusProcess(pid: app.processIdentifier, birth: birth), window: window, before: stop, identity: processIdentity)
    switch (observedMenu, currentMenu) {
    case (nil, nil): break
    case (let captured?, let current?):
      let recipient = current.menuProcess ?? FocusProcess(pid: app.processIdentifier, birth: birth)
      guard CFEqual(captured.element, current.element), captured.recipient == recipient,
        let rectangle = frame(current.element), sameFrame(rectangle, captured.axBounds),
        let native = try? menuWindow(current.element, recipient: recipient, axBounds: rectangle), native.id == captured.windowID else { throw ObservationChanged() }
    default: throw ObservationChanged()
    }
    guard DispatchTime.now().uptimeNanoseconds < stop else { throw ObservationChanged() }
    guard app.isHidden == hidden, (window.map { (attribute($0, kAXMinimizedAttribute) as? Bool) == true } ?? false) == minimized else { throw ObservationChanged() }
    revision += 1
    if let menu = observedMenu {
      guard let current = windowBounds(menu.windowID, owner: menu.recipient.pid), sameFrame(current, menu.bounds),
        processIdentity(menu.recipient.pid) == menu.recipient.birth else { throw Failure("Menu window changed during observation. Obtain fresh state.") }
    }
    snapshots[key] = Snapshot(application: app, birth: birth, window: window, axBounds: axBounds, serverWindow: server, windowID: id, bounds: bounds, nodes: records, lines: lines, windowGeneration: windowGeneration, menu: observedMenu)
    var rendered = lines.joined(separator: "\n")
    if !full, let old, old.birth == birth, let previousWindow = old.window, let window, CFEqual(previousWindow, window) {
      let before = Set(old.lines), after = Set(lines)
      let diff = old.lines.filter { !after.contains($0) }.map { "- " + $0 } + lines.filter { !before.contains($0) }.map { "+ " + $0 }
      let change = diff.isEmpty ? "[No accessibility changes]" : "[Accessibility diff]\n" + diff.joined(separator: "\n")
      if change.utf8.count < rendered.utf8.count { rendered = change }
    }
    let imageDescription = includeScreenshot ? "\(width)x\(height)" : "omitted (AX-only)"
    var header = "App: \(app.localizedName ?? "Application") pid=\(app.processIdentifier) window=\(id) revision=\(revision) input=\(inputMode.rawValue)\nCoordinates: absolute screen points; bounds=[\(bounds.minX),\(bounds.minY),\(bounds.width),\(bounds.height)]; screenshot=\(imageDescription)."
    header += "\nWindow state: hidden=\(hidden) minimized=\(minimized)." + (inputMode == .background && (hidden || minimized) ? " Background input is blocked; use app.restoreWindow(), then obtain fresh state." : "")
    if let menu = observedMenu { header += "\nActive menu: pid=\(menu.recipient.pid) window=\(menu.windowID) bounds=[\(menu.bounds.minX),\(menu.bounds.minY),\(menu.bounds.width),\(menu.bounds.height)]; AX bounds=[\(menu.axBounds.minX),\(menu.axBounds.minY),\(menu.axBounds.width),\(menu.axBounds.height)]." }
    if includeScreenshot && screenshot == nil { rendered = "[Screenshot unavailable: grant Screen Recording permission to the launching host.]\n" + rendered }
    if window == nil { rendered = "[Accessibility unavailable for this exact native window. No element indices were issued. Use getScreenshot and observed window coordinates; AX-only actions are unavailable.]\n" + rendered }
    return ["app": path, "text": header + "\n" + rendered, "accessibilityAvailable": window != nil, "screenshot": screenshot.map { ["url": $0] } as Any? ?? NSNull(), "revision": revision, "pid": Int(app.processIdentifier), "windowId": Int(id), "bounds": ["x":bounds.minX,"y":bounds.minY,"width":bounds.width,"height":bounds.height], "screenshotWidth":width,"screenshotHeight":height,"capturedAt":ISO8601DateFormatter().string(from: Date())]
  }

  private func paste(_ input: [String: Any], _ app: NSRunningApplication) async throws {
    func trace(_ phase: String) { try? FileHandle.standardError.write(contentsOf: Data(("glide.phase=paste." + phase + "\n").utf8)) }
    trace("read-clipboard")
    let birth = try snapshot(app).birth
    guard let text = input["text"] as? String, let format = input["format"] as? String, ["text", "md", "html"].contains(format) else { throw Failure("Unsupported paste format.") }
    let board = NSPasteboard.general, priorChange = NSPasteboard.general.changeCount
    let originalItems = board.pasteboardItems ?? []
    guard originalItems.count <= 64 else { throw Failure("Clipboard has too many items to preserve safely.") }
    var bytes = 0
    let original: [[NSPasteboard.PasteboardType: Data]] = try originalItems.map { item in
      var data: [NSPasteboard.PasteboardType: Data] = [:]
      guard item.types.count <= 64 else { throw Failure("Clipboard has too many representations to preserve safely.") }
      for type in item.types {
        guard let value = item.data(forType: type) else { throw Failure("Clipboard representation cannot be preserved.") }
        bytes += value.count
        guard bytes <= 8 * 1024 * 1024 else { throw Failure("Clipboard is too large to preserve safely.") }
        data[type] = value
      }
      return data
    }
    trace("prepare-rich")
    let item = NSPasteboardItem()
    if format == "text" { item.setString(text, forType: .string) }
    else {
      let rich: NSAttributedString
      if format == "md" { rich = NSAttributedString(try AttributedString(markdown: text)) }
      else { rich = try SafeRichHTML.parse(text) }
      item.setString(rich.string, forType: .string)
      item.setData(try rich.data(from: NSRange(location: 0, length: rich.length), documentAttributes: [.documentType:NSAttributedString.DocumentType.rtf]), forType: .rtf)
      if format == "html" { item.setString(text, forType: .html) }
    }
    try checkInputOwner(app)
    guard board.changeCount == priorChange else { throw Failure("Clipboard changed during preparation; nothing was pasted.") }
    let provider = PasteProvider(item: item), provided = NSPasteboardItem()
    provided.setDataProvider(provider, forTypes: item.types)
    trace("publish")
    board.clearContents()
    let published = board.writeObjects([provided])
    let ownedChange = board.changeCount
    let restore = {
      guard board.changeCount == ownedChange else { return }
      board.clearContents()
      let items = original.map { data -> NSPasteboardItem in let item = NSPasteboardItem(); for (type, value) in data { item.setData(value, forType: type) }; return item }
      if !items.isEmpty { board.writeObjects(items) }
    }
    clipboardRestore = restore
    defer { trace("restore"); restore(); clipboardRestore = nil }
    guard published else { throw Failure("Clipboard publication failed.") }
    trace("send-key")
    try await keyEvents(app, key: 9, flags: .maskCommand)
    trace("await-read")
    // Reading the provider and a bounded quiet period are delivery heuristics;
    // another clipboard reader can also trigger them. The agent must observe the
    // target value afterwards. A heuristic never becomes a verified UI receipt.
    while true {
      let readAt = provider.lastRead, now = DispatchTime.now().uptimeNanoseconds
      if readAt > 0, now >= readAt, now - readAt >= 100_000_000 { break }
      // The target may synchronously wait for our pasteboard provider. Asking
      // that same app for AX state here would block the helper's main run loop
      // and prevent it from serving the provider: a cross-process deadlock.
      // Recheck OS process/input ownership without AX while servicing the paste.
      // No further input is dispatched in this phase; validate the window again
      // once the provider has drained and the app can answer accessibility.
      try checkInputProcessOwner(app, birth: birth)
      guard board.changeCount == ownedChange else { throw Failure("Clipboard ownership changed; inspect the target before repeating paste.") }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    _ = try snapshot(app)
  }

  // Reserve this backend for the connection lifetime. The OS releases flock
  // when the exact helper exits, including after timeout or parent-pipe EOF.
  private func acquireInputLease() throws -> (fd: Int32, path: String) {
    // Providers may give each MCP process a different TMPDIR. Resolve Darwin's
    // actual per-user temporary namespace so they still share one input lease.
    // Keep this ownership namespace stable across the Glide rename so an older
    // helper and Glide cannot independently acquire control of the same desktop.
    let path = URL(fileURLWithPath: try nativeUserTemporaryDirectory()).appendingPathComponent("cafe-computer-use-\(getuid()).lock").path
    let fd = open(path, O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, S_IRUSR | S_IWUSR)
    guard fd >= 0 else { throw Failure("Glide input ownership is unavailable.") }
    var metadata = stat(), named = stat()
    guard fstat(fd, &metadata) == 0, lstat(path, &named) == 0, metadata.st_uid == getuid(), metadata.st_mode & S_IFMT == S_IFREG, metadata.st_mode & 0o077 == 0, metadata.st_nlink == 1, metadata.st_dev == named.st_dev, metadata.st_ino == named.st_ino, flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw Failure("Another session owns Glide input or its lock identity is uncertain. Close or reset the owning Glide connection before trying again.") }
    guard lstat(path, &named) == 0, metadata.st_dev == named.st_dev, metadata.st_ino == named.st_ino else { close(fd); throw Failure("Glide input lock changed identity.") }
    return (fd, path)
  }

  // Settling observes only the original target and shares the request's absolute
  // deadline. It never retries an input or transfers ownership to a new process.
  private func writeForObservation(_ element: AXUIElement, _ name: String, _ value: CFTypeRef, admit: () throws -> Void) throws -> Failure? {
    let attempted = actionTrace?.axAttempted
    do { try setAttribute(element, name, value, trace: actionTrace, admit: admit); return nil }
    catch let failure as Failure {
      // Only a returned OS error from this exact dispatched write permits a
      // readback. Admission/ownership/writability refusals still throw directly.
      guard let attempted, let trace = actionTrace, trace.axAttempted == attempted + 1, let status = trace.osStatus, status != 0 else { throw failure }
      return failure
    }
  }
  private func settle(_ app: NSRunningApplication, _ predicate: () throws -> Bool) async throws -> Bool {
    let birth = processIdentity(app.processIdentifier)
    let stop = min(deadline, DispatchTime.now().uptimeNanoseconds + 600_000_000)
    while true {
      try checkInputProcessOwner(app, birth: birth)
      if try predicate() { return true }
      if DispatchTime.now().uptimeNanoseconds >= stop { return false }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }
  private func receiptValue(_ value: CFTypeRef?) -> Any? {
    guard let value else { return nil }
    if CFGetTypeID(value) == CFBooleanGetTypeID() { return value as? Bool }
    if CFGetTypeID(value) == CFNumberGetTypeID(), let number = value as? NSNumber, number.doubleValue.isFinite { return number.doubleValue }
    if let text = value as? String { return String(decoding: text.utf16.prefix(1024), as: UTF16.self) }
    return nil
  }
  private func valuesMatch(_ expected: CFTypeRef, _ observed: CFTypeRef?) -> Bool {
    guard let observed else { return false }
    guard CFGetTypeID(expected) == CFGetTypeID(observed) else { return false }
    if CFGetTypeID(expected) == CFNumberGetTypeID(), let left = expected as? NSNumber, let right = observed as? NSNumber {
      return GlideValueComparison.numbersMatch(left.doubleValue, right.doubleValue)
    }
    return CFEqual(expected, observed)
  }
  private func focusedWithin(_ target: AXUIElement, app: NSRunningApplication) -> Bool {
    guard var cursor = elementAttribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute) else { return false }
    var visited: [AXUIElement] = []
    while visited.count < 64, !visited.contains(where: { CFEqual($0, cursor) }) {
      if CFEqual(cursor, target) { return true }
      visited.append(cursor)
      guard let parent = elementAttribute(cursor, kAXParentAttribute) else { break }
      cursor = parent
    }
    return false
  }
  private func focusElement(_ record: NodeRecord, app: NSRunningApplication) async throws -> Bool {
    try checkInputOwner(app)
    var writeFailure: Failure?
    if !focusedWithin(record.element, app: app) {
      writeFailure = try writeForObservation(record.element, kAXFocusedAttribute, kCFBooleanTrue) { try checkInputOwner(app) }
    }
    let matched = try await settle(app) { self.focusedWithin(record.element, app: app) }
    if matched { _ = try inputRecipient(app) }
    actionTrace?.verify("focus", matched: matched)
    if !matched {
      let message = "The requested field did not acquire observed keyboard focus. No text was sent. Inspect state; use an explicit click or the application's focus shortcut if AX focus is unsupported."
      if writeFailure != nil { actionTrace?.fail(message) } else { actionTrace?.message = message }
    } else if writeFailure != nil { actionTrace?.message = "The OS did not acknowledge the focus write, but focus in the exact requested target was observed." }
    return matched
  }
  private func selectedRange(_ element: AXUIElement) -> CFRange? {
    guard let raw = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    return AXValueGetValue(unsafeBitCast(raw, to: AXValue.self), .cfRange, &range) ? range : nil
  }
  private func typeText(_ text: String, app: NSRunningApplication, target: AXUIElement? = nil) async throws {
    var route = try inputRecipient(app)
    for scalar in text.unicodeScalars {
      try checkInputOwner(app)
      if let target, !focusedWithin(target, app: app) { throw Failure("The requested field lost focus during text entry. Further characters stopped; inspect the receipt and current text before continuing.") }
      if scalar == "\n" || scalar == "\t" {
        try await keyEvents(app, key: scalar == "\n" ? 36 : 48, flags: [])
        actionTrace?.textScalarsPosted += 1
        route = try inputRecipient(app)
        continue
      }
      let units = Array(String(scalar).utf16)
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { throw Failure("Could not create Unicode input.") }
      down.flags = []; up.flags = []
      units.withUnsafeBufferPointer { buffer in down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress); up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress) }
      try validateRecipient(route, app)
      actionTrace?.post("text-input"); down.postToPid(route.recipient.pid)
      actionTrace?.eventsPosted += 1; up.postToPid(route.recipient.pid)
      actionTrace?.textScalarsPosted += 1
    }
  }
  private func typeInto(_ record: NodeRecord, text: String, replace: Bool, app: NSRunningApplication) async throws {
    guard [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(record.role) else { throw Failure("Targeted text entry requires an observed text field, text area or combo box.") }
    guard try await focusElement(record, app: app) else { return }
    let secure = stringAttribute(record.element, kAXSubroleAttribute) == "AXSecureTextField"
    let before = secure ? nil : attribute(record.element, kAXValueAttribute) as? String
    // AX supplies complete values. Bound the retained text before constructing
    // a replacement expectation; ordinary incremental typeText stays available.
    if let before, !GlideValueComparison.supportsTextVerification(before) { throw Failure("Verified text entry is limited to fields of 65536 UTF-16 units. No text was sent; inspect the selection and use incremental typing for larger documents.") }
    var range = secure ? nil : selectedRange(record.element)
    if replace {
      guard let before else { throw Failure("Replacing text requires a readable non-secure field so selection can be verified. No text was sent.") }
      var all = CFRange(location: 0, length: (before as NSString).length)
      guard let axRange = AXValueCreate(.cfRange, &all) else { throw Failure("Could not create replacement selection.") }
      let selectionFailure = try writeForObservation(record.element, kAXSelectedTextRangeAttribute, axRange) { try checkInputOwner(app) }
      guard try await settle(app, { self.selectedRange(record.element).map { $0.location == all.location && $0.length == all.length } ?? false }) else {
        actionTrace?.verify("selection", matched: false)
        if selectionFailure != nil { actionTrace?.fail("Replacement selection was not confirmed or observed. No text was sent.") }
        else { actionTrace?.message = "Replacement selection was not observed. No text was sent." }
        return
      }
      range = all
    }
    var expected: String?
    if let before, let range, range.location >= 0, range.length >= 0, range.location <= (before as NSString).length, range.length <= (before as NSString).length - range.location {
      expected = text.isEmpty && !replace ? before : (before as NSString).replacingCharacters(in: NSRange(location: range.location, length: range.length), with: text)
    }
    // Focus verification alone must not survive as verification of text input.
    actionTrace?.verify("text", matched: nil)
    if replace && text.isEmpty && before?.isEmpty == false {
      guard focusedWithin(record.element, app: app) else { throw Failure("Replacement target lost focus before deletion. No deletion was sent.") }
      try await keyEvents(app, key: 51, flags: [])
    } else { try await typeText(text, app: app, target: record.element) }
    if let expected {
      var observed: String?
      let matched = try await settle(app) { observed = attribute(record.element, kAXValueAttribute) as? String; return observed == expected }
      actionTrace?.verify("text", matched: observed == nil ? nil : matched, before: before.map { String(decoding: $0.utf16.prefix(1024), as: UTF16.self) }, after: observed.map { String(decoding: $0.utf16.prefix(1024), as: UTF16.self) })
      if observed == nil { actionTrace?.fail("Text events were posted but the field became unreadable. The result is uncertain; inspect before repeating text entry.") }
      else if !matched { actionTrace?.message = "Text events were posted but the expected field value was not observed. Inspect the field before repeating text entry." }
    }
  }

  private func armLifecycle(_ app: NSRunningApplication? = nil) throws {
    guard inputMode == .background else { return }
    retireMenuGuard()
    retireSyntheticFocus()
    guard let front = NSWorkspace.shared.frontmostApplication, let birth = processIdentity(front.processIdentifier), backgroundDesktops.arm(ActiveDesktops.current()) else { throw Failure("Desktop identity is unavailable. No lifecycle action was dispatched.") }
    backgroundForeground = FocusProcess(pid: front.processIdentifier, birth: birth)
    if focusGuard == nil { focusGuard = try BackgroundFocusGuard(authority: authority) }
    if let app, let birth = processIdentity(app.processIdentifier) {
      backgroundActivityGeneration = try focusGuard!.register(app.processIdentifier, birth: birth, retainedForeground: backgroundForeground!, previousGeneration: backgroundActivityGeneration)
    } else { backgroundActivityGeneration = try focusGuard!.activityGeneration() }
    armedSession = currentSession
    try checkLifecycleDesktop()
  }
  private func checkLifecycleDesktop() throws {
    try checkDeadline()
    guard inputMode == .background else { return }
    try focusGuard?.check(backgroundActivityGeneration)
    guard let expected = backgroundForeground,
      NSWorkspace.shared.frontmostApplication?.processIdentifier == expected.pid, processIdentity(expected.pid) == expected.birth,
      backgroundDesktops.admits(ActiveDesktops.current()) else { throw Failure("Foreground application or Space changed during the lifecycle action. No further action was sent; inspect the result before continuing.") }
  }
  private func openExactApplication(_ url: URL) async throws -> NSRunningApplication {
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = inputMode == .foreground
    configuration.hides = false
    configuration.hidesOthers = false
    configuration.createsNewApplicationInstance = false
    configuration.promptsUserIfNeeded = false
    configuration.addsToRecentItems = false
    configuration.allowsRunningApplicationSubstitution = false
    try checkLifecycleDesktop()
    actionTrace?.lifecycleDispatched = true
    return try await withCheckedThrowingContinuation { continuation in
      NSWorkspace.shared.openApplication(at: url, configuration: configuration) { app, error in
        if let app, error == nil { continuation.resume(returning: app) }
        else { continuation.resume(throwing: Failure("Application open/reopen was not confirmed. It may have taken effect; inspect running applications and windows before repeating it.")) }
      }
    }
  }
  private func launchApplication(_ name: String) async throws {
    let installed = try installedApplication(name)
    guard allowed[installed.id]?.path == installed.url.path else { throw Failure("Installed application is outside the exact app grant.") }
    let running = matchingApplications(installed.url.path)
    guard running.count <= 1 else { throw Failure("Multiple running app instances require explicit window selection; launch was not attempted.") }
    try armLifecycle(running.first)
    if let app = running.first {
      try checkLifecycleDesktop()
      guard valid(app) else { throw Failure("The running application identity changed before process observation.") }
      actionTrace?.verify("application", matched: true)
      actionTrace?.message = "The exact application is already running. Launch was not repeated; list its windows and restore a hidden/minimized window explicitly."
      return
    }
    actionTrace?.stage = "application-launch"
    let launched = try await openExactApplication(installed.url)
    try checkLifecycleDesktop()
    guard let birth = processIdentity(launched.processIdentifier) else { throw Failure("Launch returned without a live process birth identity. The application may have exited during startup; inspect inventory before another launch.") }
    let stop = min(deadline, DispatchTime.now().uptimeNanoseconds + 1_000_000_000)
    while true {
      try checkLifecycleDesktop()
      guard processIdentity(launched.processIdentifier) == birth else { throw Failure("Launched process exited or changed generation during startup. Inspect inventory; launch was not repeated.") }
      if let current = NSRunningApplication(processIdentifier: launched.processIdentifier), valid(current, birth: birth), current.bundleURL?.resolvingSymlinksInPath().path == installed.url.path { break }
      guard DispatchTime.now().uptimeNanoseconds < stop else { throw Failure("Launch process metadata did not settle to the exact admitted installation. Inspect inventory before continuing.") }
      try await Task.sleep(nanoseconds: 10_000_000)
    }
    if inputMode == .background {
      backgroundActivityGeneration = try focusGuard!.register(launched.processIdentifier, birth: birth, retainedForeground: backgroundForeground!, previousGeneration: backgroundActivityGeneration)
    }
    try checkLifecycleDesktop()
    actionTrace?.verify("application", matched: true)
    actionTrace?.message = "Exact application process observed. Window readiness and UI task completion are not established; list windows and get a fresh app handle."
  }
  private func restoreWindow(_ app: NSRunningApplication) async throws {
    let state = try snapshot(app)
    guard let window = state.window else { throw Failure("Window restoration requires its exact observed accessibility window.") }
    try armLifecycle(app)
    try checkInputProcessOwner(app, birth: state.birth)
    if app.isHidden {
      // AXHidden is the application's writable visibility attribute. Unlike
      // activation or reopening, it targets visibility without asking the app
      // to create another window or move to the foreground. A rejected/uncertain
      // write is inspected, never retried through another mechanism.
      actionTrace?.stage = "application-unhide"
      let unhideFailure = try writeForObservation(AXUIElementCreateApplication(app.processIdentifier), kAXHiddenAttribute, kCFBooleanFalse) { try checkInputProcessOwner(app, birth: state.birth) }
      let visible = try await settle(app) { !app.isHidden }
      try checkLifecycleDesktop()
      if !visible {
        actionTrace?.verify("window", matched: false)
        if unhideFailure != nil { actionTrace?.fail("Unhide was not acknowledged and visible application state was not observed. No further restoration was sent.") }
        else { actionTrace?.message = "Visible application state was not observed after unhide. No further restoration was sent." }
        return
      }
    }
    try checkLifecycleDesktop()
    try checkInputProcessOwner(app, birth: state.birth)
    var minimizeFailure: Failure?
    if attribute(window, kAXMinimizedAttribute) as? Bool == true {
      minimizeFailure = try writeForObservation(window, kAXMinimizedAttribute, kCFBooleanFalse) { try checkInputProcessOwner(app, birth: state.birth) }
    }
    let matched = try await settle(app) {
      !app.isHidden && (attribute(window, kAXMinimizedAttribute) as? Bool) == false && windowOwner(state.windowID) == app.processIdentifier
    }
    try checkLifecycleDesktop()
    // Restoration can change geometry and AX identity. Old snapshots cannot be
    // retained as input authority even when the WindowServer ID stays the same.
    snapshots = snapshots.filter { !($0.value.application.processIdentifier == app.processIdentifier && $0.key.hasPrefix(currentSession + "\u{0}")) }
    pruneWindowInvalidations()
    actionTrace?.verify("window", matched: matched)
    actionTrace?.message = matched ? "Window is no longer hidden or minimized. Obtain fresh app state before input; no activation, raise or application reopen was requested." : "The requested visible window state was not observed. Inspect current state before another restoration."
    if !matched && minimizeFailure != nil { actionTrace?.fail("Unminimize was not acknowledged and the requested window state was not observed. Inspect state before another restoration.") }
  }

  private func stableObservation(_ name: String, full: Bool, includeScreenshot: Bool) async throws -> [String: Any] {
    let stop = min(deadline, DispatchTime.now().uptimeNanoseconds + 1_000_000_000)
    var lastError: Error = Failure("Application identity is still settling.")
    while true {
      try checkDeadline()
      var attempted: NSRunningApplication?
      var birth: ProcessIdentity?
      do {
        let app = try resolve(name); attempted = app; birth = processIdentity(app.processIdentifier)
        if inputMode == .foreground { try await focus(app) }
        else if !app.isHidden {
          guard let birth else { throw Failure("Application identity is unavailable.") }
          try prepareBackgroundApplication(app, birth: birth, synthetic: true) { try self.checkInputProcessOwner(app, birth: birth) }
        }
        return try await observe(app, full: full, includeScreenshot: includeScreenshot)
      } catch {
        lastError = error
        // Only an observation can re-resolve ownership. A stable owner's focus,
        // permission, ambiguity or capture error is not an identity retry.
        if let attempted, valid(attempted, birth: birth) { throw error }
      }
      guard DispatchTime.now().uptimeNanoseconds < stop else { throw lastError }
      cleanup(retainFocus: false)
      try await Task.sleep(nanoseconds: 10_000_000)
    }
  }

  func dispatch(_ request: [String: Any]) async throws -> Any {
    let method = request["method"] as? String ?? ""
    let actions: Set<String> = ["click", "drag", "scroll", "set_value", "select_text", "type_text", "press_key", "paste", "perform_secondary_action", "focus_element", "type_into", "launch_app", "restore_window"]
    guard actions.contains(method) else { return try await execute(request) }
    let trace = GlideActionTrace(method: method)
    actionTrace = trace
    defer { actionTrace = nil }
    do { _ = try await execute(request) }
    catch let failure as Failure {
      trace.fail(failure.message)
      trace.interruption = failure.interruption?.result
      trace.candidates = failure.candidates
    } catch { trace.fail("Native action outcome is uncertain. Inspect fresh app state before repeating it.") }
    if trace.status == "uncertain" || trace.status == "not-observed" {
      snapshots = snapshots.filter { !$0.key.hasPrefix(currentSession + "\u{0}") }
      pruneWindowInvalidations()
    }
    // A source helper may be rebuilt while Cafe's previous broker/worker is
    // still running. Old consumers discard successful action return values;
    // keep failures on their error channel until a new broker opts into receipts.
    if integer(request["receiptVersion"]) != 1 {
      if ["uncertain", "not-observed", "refused"].contains(trace.status) { throw Failure(trace.message ?? "Action result was not verified. Inspect fresh state before continuing.") }
      return NSNull()
    }
    return trace.result
  }

  private func execute(_ request: [String: Any]) async throws -> Any {
    diagnostic("native.dispatch")
    guard Set(request.keys).isSubset(of: ["id", "method", "input", "timeout_ms", "sessionId", "receiptVersion"]), request["receiptVersion"] == nil || integer(request["receiptVersion"]) == 1, let method = request["method"] as? String, let input = request["input"] as? [String: Any], let timeout = integer(request["timeout_ms"]), timeout > 0, timeout <= 60_000 else { throw Failure("Invalid native request.") }
    if let rawSession = request["sessionId"] {
      guard let value = rawSession as? String, value.count == 36, let uuid = UUID(uuidString: value) else { throw Failure("Invalid native session identity.") }
      currentSession = uuid.uuidString
    } else { currentSession = "standalone" }
    deadline = DispatchTime.now().uptimeNanoseconds + UInt64(timeout) * 1_000_000
    if method == "retire_session" {
      guard input.isEmpty else { throw Failure("Session retirement accepts no model arguments.") }
      snapshots = snapshots.filter { !$0.key.hasPrefix(currentSession + "\u{0}") }
      pruneWindowInvalidations()
      sessionIDs.remove(currentSession)
      if armedSession == currentSession { cleanup(retainFocus: false); focusGuard?.disarm(); armedSession = nil }
      if retainedFocus?.session == currentSession { retireSyntheticFocus() }
      if menuSession == currentSession { retireMenuGuard() }
      return NSNull()
    }
    guard sessionIDs.contains(currentSession) || sessionIDs.count < 32 else { throw Failure("Native session capacity reached.") }
    sessionIDs.insert(currentSession)
    currentWindowID = nil
    if let value = input["windowId"] {
      guard let id = integer(value), id > 0, id <= UInt32.max else { throw Failure("An exact positive native window ID is required.") }
      currentWindowID = CGWindowID(id)
    }
    let fields: [String: Set<String>] = [
      "list_apps":[], "list_windows":["app"], "resolve_app":["app"], "launch_app":["app"], "restore_window":["app"], "focus_element":["app","element_index"], "type_into":["app","element_index","text","replace"], "get_app_state":["app","disableDiff","includeScreenshot"], "click":["app","element_index","x","y","mouse_button","click_count","key","duration"],
      "drag":["app","from_x","from_y","to_x","to_y"], "scroll":["app","element_index","x","y","direction","pages"], "set_value":["app","element_index","value"],
      "select_text":["app","element_index","text","prefix","suffix","selection_type"], "type_text":["app","text"], "press_key":["app","key","duration"], "paste":["app","text","format"], "perform_secondary_action":["app","element_index","action"]]
    guard let keys = fields[method], Set(input.keys).isSubset(of: method == "list_apps" || method == "list_windows" ? keys : keys.union(["windowId"])), input.values.allSatisfy({ !($0 is String) || ($0 as! String).utf8.count <= 64 * 1024 }) else { throw Failure("Invalid Glide method or arguments.") }
    if method == "click" || method == "scroll" {
      let indexed = input["element_index"] != nil
      guard indexed ? (input["x"] == nil && input["y"] == nil) : (input["x"] != nil && input["y"] != nil) else { throw Failure("Choose one element index or one coordinate pair.") }
    }
    if method == "list_apps" {
      return applications().map { app in ["name":app.localizedName ?? "Application", "bundleId":app.bundleIdentifier ?? "", "path":app.bundleURL!.resolvingSymlinksInPath().path, "pid":Int(app.processIdentifier)] as [String: Any] }
    }
    guard let name = input["app"] as? String, !name.isEmpty, name.utf8.count <= 1024 else { throw Failure("An allowed application is required.") }
    if method == "resolve_app" {
      let installed = try installedApplication(name)
      guard allowed[installed.id]?.path == installed.url.path else { throw Failure("Installed application is outside the exact app grant.") }
      return ["name": installed.name, "bundleId": installed.id, "path": installed.url.path]
    }
    if method == "list_windows" {
      let candidates = matchingApplications(name)
      let identities = Set(candidates.compactMap { app -> String? in
        guard let bundleID = app.bundleIdentifier, let path = app.bundleURL?.resolvingSymlinksInPath().path else { return nil }
        return bundleID + "\u{0}" + path
      })
      guard !candidates.isEmpty, candidates.count <= 64, identities.count == 1 else { throw Failure("Window inventory application identity is absent or ambiguous.") }
      var windows: [NativeWindow] = []
      for app in candidates {
        windows.append(contentsOf: try nativeWindows(app, metadataOnly: true))
        guard windows.count <= 64 else { throw Failure("Application window inventory exceeds its bound across running instances.") }
      }
      return windows.map { window in ["id": Int(window.id), "title": window.title, "bounds": ["x": window.bounds.minX, "y": window.bounds.minY, "width": window.bounds.width, "height": window.bounds.height], "onScreen": window.onScreen] as [String: Any] }
    }
    guard AXIsProcessTrusted() else { throw Failure("Accessibility permission is required for the launching host (Device Control and Data Access in macOS 27 Settings). No action was dispatched.") }
    if inputLease == nil { inputLease = try acquireInputLease() }
    diagnostic("native.lease")
    defer { cleanup() }
    if method == "launch_app" { try await launchApplication(name); return NSNull() }
    if method == "get_app_state" {
      return try await stableObservation(name, full: input["disableDiff"] as? Bool ?? false, includeScreenshot: input["includeScreenshot"] as? Bool ?? true)
    }
    let app = try resolve(name)
    if method == "restore_window" { try await restoreWindow(app); return NSNull() }
    _ = try snapshot(app)
    if inputMode == .foreground { try await focus(app) }
    _ = try snapshot(app)
    if inputMode == .background {
      // An advertised AXPress needs no synthetic AppKit activation. Keep the
      // approved focus guard armed, then prepare activation only if this click
      // actually requires PID-addressed pointer events below.
      try prepareBackgroundInput(app, synthetic: ["drag", "scroll", "press_key", "type_text", "paste", "focus_element", "type_into"].contains(method))
      try refreshMenuGuard(app)
    }
    switch method {
    case "focus_element":
      _ = try await focusElement(try node(input, app), app: app)
    case "type_into":
      guard let text = input["text"] as? String, input["replace"] == nil || input["replace"] is Bool else { throw Failure("Invalid targeted text entry.") }
      try await typeInto(try node(input, app), text: text, replace: input["replace"] as? Bool ?? false, app: app)
    case "set_value":
      let record = try node(input, app)
      guard let value = input["value"] as? String else { throw Failure("Invalid accessibility value.") }
      var typedValue: CFTypeRef = value as CFString
      if let current = attribute(record.element, kAXValueAttribute), CFGetTypeID(current) == CFBooleanGetTypeID() {
        guard ["true", "false", "1", "0"].contains(value.lowercased()) else { throw Failure("A boolean accessibility value is required.") }
        typedValue = (value.lowercased() == "true" || value == "1") ? kCFBooleanTrue : kCFBooleanFalse
      } else if let current = attribute(record.element, kAXValueAttribute), CFGetTypeID(current) == CFNumberGetTypeID() {
        guard let numeric = Double(value), numeric.isFinite else { throw Failure("A finite numeric accessibility value is required.") }
        typedValue = NSNumber(value: numeric)
      }
      let secure = stringAttribute(record.element, kAXSubroleAttribute) == "AXSecureTextField"
      let before = secure ? nil : receiptValue(attribute(record.element, kAXValueAttribute))
      let writeFailure = try writeForObservation(record.element, kAXValueAttribute, typedValue) { try checkInputOwner(app) }
      if !secure {
        var observed: CFTypeRef?
        let matched = try await settle(app) { observed = attribute(record.element, kAXValueAttribute); return self.valuesMatch(typedValue, observed) }
        actionTrace?.verify("value", matched: observed == nil ? nil : matched, before: before, after: receiptValue(observed))
        if observed == nil { actionTrace?.fail("The AX write was dispatched but readback became unavailable. Inspect fresh state before repeating the write.") }
        else if !matched && writeFailure != nil { actionTrace?.fail("The AX write was not acknowledged and the requested value was not observed. Inspect fresh state before another write.") }
        else if !matched { actionTrace?.message = "The OS accepted the AX write but the requested value was not observed. Inspect fresh state; do not assume the edit was applied." }
        else if writeFailure != nil { actionTrace?.message = "The OS did not acknowledge the AX write, but the requested value was observed. This verifies only the AX value, not the application task." }
      } else if let writeFailure { throw writeFailure }
    case "perform_secondary_action":
      let record = try node(input, app)
      guard let action = input["action"] as? String, actionNames(record.element).contains(action) else { throw Failure("Action was not advertised by this element.") }
      guard inputMode != .background || action != kAXRaiseAction else { throw Failure("Raising a window requires explicit foreground mode.") }
      try perform(record.element, action, trace: actionTrace) { try checkInputOwner(app) }
    case "click":
      let buttonName = input["mouse_button"] as? String ?? "left", count = integer(input["click_count"]) ?? 1, duration = number(input["duration"]) ?? 0
      guard ["left","right","middle"].contains(buttonName), (1...3).contains(count), duration >= 0, duration <= 5 else { throw Failure("Invalid click options.") }
      if input["element_index"] != nil, buttonName == "left", count == 1, input["key"] == nil, duration == 0 {
        let record = try node(input, app)
        if actionNames(record.element).contains(kAXPressAction) { try perform(record.element, kAXPressAction, trace: actionTrace) { try checkInputOwner(app) }; break }
      }
      let location = try point(input, app), button: CGMouseButton = buttonName == "left" ? .left : buttonName == "right" ? .right : .center
      try checkHit(location, app)
      var flags: CGEventFlags = []
      if let modifier = input["key"] as? String { flags = try parseKey(modifier + "+a").1 }
      if inputMode == .background { try prepareBackgroundInput(app, synthetic: true); try refreshMenuGuard(app) }
      let observedElement = input["element_index"] == nil ? nil : try node(input, app).element
      for click in 1...count {
        try await mouse(app, point: location, button: button, down: true, flags: flags, count: click, observedElement: observedElement)
        if inputMode == .background, button == .left, count == 1, duration == 0, input["key"] == nil,
          (try snapshot(app)).menu != nil {
          try await mouse(app, point: location, button: button, down: true, flags: flags, count: click, dragged: true, observedElement: observedElement)
        }
        if duration > 0 { try await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000)) }
        try await mouse(app, point: location, button: button, down: false, flags: flags, count: click, observedElement: observedElement)
      }
    case "drag":
      guard let x1 = number(input["from_x"]), let y1 = number(input["from_y"]), let x2 = number(input["to_x"]), let y2 = number(input["to_y"]) else { throw Failure("Invalid drag coordinates.") }
      let from = try point(["x":x1,"y":y1], app), to = try point(["x":x2,"y":y2], app)
      try checkHit(from, app); try checkHit(to, app)
      try await mouse(app, point: from, button: .left, down: true)
      for step in 1...12 {
        let t = Double(step) / 12
        try await mouse(app, point: CGPoint(x: from.x + (to.x-from.x)*t, y: from.y + (to.y-from.y)*t), button: .left, down: true, dragged: true)
        try await Task.sleep(nanoseconds: 8_000_000)
      }
      try await mouse(app, point: to, button: .left, down: false)
    case "scroll":
      let location = try point(input, app), pages = number(input["pages"]) ?? 1
      guard pages > 0, pages <= 20, let direction = input["direction"] as? String, ["up","down","left","right"].contains(direction) else { throw Failure("Invalid scroll options.") }
      try checkHit(location, app)
      let state = try snapshot(app), vertical = direction == "up" || direction == "down"
      let route = try inputRecipient(app, point: location, observedElement: input["element_index"] == nil ? nil : try node(input, app).element)
      let amount = Int32((vertical ? state.bounds.height : state.bounds.width) * pages * (direction == "up" || direction == "left" ? 1 : -1))
      guard let event = CGEvent(scrollWheelEvent2Source: CGEventSource(stateID: .hidSystemState), units: .pixel, wheelCount: 2, wheel1: vertical ? amount : 0, wheel2: vertical ? 0 : amount, wheel3: 0) else { throw Failure("Could not create scroll event.") }
      try checkInputProcessOwner(app, birth: state.birth)
      event.flags = []
      if inputMode == .background {
        try WindowEvents.address(event, point: location, windowID: route.windowID, bounds: route.bounds)
        try validateRecipient(route, app)
        actionTrace?.post("scroll")
        event.postToPid(route.recipient.pid)
      } else { event.location = location; actionTrace?.post("scroll"); event.post(tap: .cghidEventTap) }
    case "press_key":
      guard let key = input["key"] as? String else { throw Failure("A key is required.") }
      let (code, flags) = try parseKey(key)
      try await keyEvents(app, key: code, flags: flags, duration: number(input["duration"]) ?? 0)
    case "type_text":
      guard let text = input["text"] as? String else { throw Failure("Text is required.") }
      try await typeText(text, app: app)
    case "select_text":
      let record = try node(input, app)
      guard stringAttribute(record.element, kAXSubroleAttribute) != "AXSecureTextField", let source = attribute(record.element, kAXValueAttribute) as? String, let text = input["text"] as? String else { throw Failure("A readable text element is required.") }
      let value = source as NSString, prefix = input["prefix"] as? String ?? "", suffix = input["suffix"] as? String ?? ""
      let search = prefix + text + suffix
      guard !search.isEmpty else { throw Failure("Empty selection requires a nonempty prefix or suffix.") }
      var matches: [NSRange] = [], start = 0
      while start <= value.length, matches.count < 2 {
        let found = value.range(of: search, options: [], range: NSRange(location: start, length: value.length-start))
        if found.location == NSNotFound { break }
        matches.append(found); start = found.location + max(1, found.length)
      }
      guard matches.count == 1 else { throw Failure("Text selection is absent or ambiguous; provide unique prefix/suffix context.") }
      let type = input["selection_type"] as? String ?? "text"
      guard ["text","cursor_before","cursor_after"].contains(type) else { throw Failure("Invalid selection type.") }
      var range = CFRange(location: matches[0].location + (prefix as NSString).length, length: (text as NSString).length)
      if type == "cursor_before" { range.length = 0 }
      if type == "cursor_after" { range.location += range.length; range.length = 0 }
      guard try await focusElement(record, app: app) else { return NSNull() }
      guard let axRange = AXValueCreate(.cfRange, &range) else { throw Failure("Could not create text range.") }
      actionTrace?.verify("selection", matched: nil)
      let selectionFailure = try writeForObservation(record.element, kAXSelectedTextRangeAttribute, axRange) { try checkInputOwner(app) }
      let matched = try await settle(app) { self.selectedRange(record.element).map { $0.location == range.location && $0.length == range.length } ?? false }
      actionTrace?.verify("selection", matched: matched)
      if !matched && selectionFailure != nil { actionTrace?.fail("Requested text selection was not acknowledged or observed. Inspect the field before typing.") }
      else if !matched { actionTrace?.message = "Requested text selection was not observed. Inspect the field before typing." }
    case "paste": try await paste(input, app)
    default: throw Failure("Unknown Glide operation.")
    }
    if inputMode == .background { try checkInputProcessOwner(app); try refreshMenuGuard(app) }
    return NSNull()
  }
}

private final class PasteProvider: NSObject, NSPasteboardItemDataProvider {
  private let item: NSPasteboardItem
  private let lock = NSLock()
  private var readAt: UInt64 = 0
  var lastRead: UInt64 { lock.lock(); defer { lock.unlock() }; return readAt }
  init(item: NSPasteboardItem) { self.item = item }
  func pasteboard(_ pasteboard: NSPasteboard?, item target: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
    if let data = item.data(forType: type) { target.setData(data, forType: type); lock.lock(); readAt = DispatchTime.now().uptimeNanoseconds; lock.unlock() }
  }
}

// Rich paste supports an inert XHTML subset. Do not feed arbitrary HTML to
// AppKit's WebKit-backed HTML importer: resource loading would escape the native
// helper's intended observation/input role. XML external entities are disabled.
private final class SafeRichHTML: NSObject, XMLParserDelegate {
  private let output = NSMutableAttributedString(string: "")
  private var styles: [[NSAttributedString.Key: Any]] = [[.font: NSFont.systemFont(ofSize: 13)]]
  private var rejected = false
  static func parse(_ html: String) throws -> NSAttributedString {
    guard !html.contains("<!"), !html.contains("<?"), html.utf8.count <= 64 * 1024 else { throw Failure("Rich HTML contains unsupported declarations.") }
    let normalized = html.replacingOccurrences(of: "<br>", with: "<br/>").replacingOccurrences(of: "&nbsp;", with: "\u{00a0}")
    let parser = XMLParser(data: Data(("<cafe>" + normalized + "</cafe>").utf8)), delegate = SafeRichHTML()
    parser.shouldResolveExternalEntities = false
    parser.delegate = delegate
    guard parser.parse(), !delegate.rejected else { throw Failure("Rich HTML must use well-formed inert text tags without resource/style attributes.") }
    return delegate.output
  }
  func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
    let allowed: Set<String> = ["cafe","p","div","span","b","strong","i","em","u","s","strike","br","ul","ol","li","code","pre","h1","h2","h3","h4","h5","h6","a"]
    guard allowed.contains(name), styles.count < 64, attributes.keys.allSatisfy({ name == "a" && $0 == "href" }) else { rejected = true; parser.abortParsing(); return }
    var style = styles.last!
    if name == "b" || name == "strong" { style[.font] = NSFontManager.shared.convert(style[.font] as! NSFont, toHaveTrait: .boldFontMask) }
    if name == "i" || name == "em" { style[.font] = NSFontManager.shared.convert(style[.font] as! NSFont, toHaveTrait: .italicFontMask) }
    if name == "u" { style[.underlineStyle] = NSUnderlineStyle.single.rawValue }
    if name == "s" || name == "strike" { style[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
    if name == "code" || name == "pre" { style[.font] = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) }
    if let href = attributes["href"] {
      guard let url = URL(string: href), ["http","https","mailto"].contains(url.scheme?.lowercased() ?? "") else { rejected = true; parser.abortParsing(); return }
      style[.link] = url
    }
    if name == "br" { output.append(NSAttributedString(string: "\n", attributes: style)) }
    if name == "li" { output.append(NSAttributedString(string: "• ", attributes: style)) }
    styles.append(style)
  }
  func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
    if ["p","div","li","pre","h1","h2","h3","h4","h5","h6"].contains(name) { output.append(NSAttributedString(string: "\n", attributes: styles.last)) }
    if styles.count > 1 { styles.removeLast() }
  }
  func parser(_ parser: XMLParser, foundCharacters string: String) {
    output.append(NSAttributedString(string: string, attributes: styles.last))
  }
}

private func readExact(_ count: Int) throws -> Data? {
  var data = Data()
  while data.count < count {
    guard let chunk = try FileHandle.standardInput.read(upToCount: count - data.count), !chunk.isEmpty else {
      if data.isEmpty { return nil }; throw Failure("Truncated native frame.")
    }
    data.append(chunk)
  }
  return data
}
private func reply(_ value: [String: Any]) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  guard data.count <= maxFrame else { throw Failure("Native response exceeded frame limit.") }
  var header = UInt32(data.count).bigEndian
  try withUnsafeBytes(of: &header) { try FileHandle.standardOutput.write(contentsOf: Data($0)) }
  try FileHandle.standardOutput.write(contentsOf: data)
}

private func retireGlideConnection(_ service: GlideService, _ authority: ConnectionAuthority) {
  authority.revoke()
  DispatchQueue.main.async { service.closeConnection(); exit(0) }
  DispatchQueue.global().asyncAfter(deadline: .now() + 1.5) { _exit(1) }
}

@main
private struct Main {
  @MainActor static func main() {
    let arguments = Array(CommandLine.arguments.dropFirst())
    if arguments.count == 2, arguments[0] == "--resolve-app" {
      NSApplication.shared.setActivationPolicy(.prohibited)
      guard let installed = try? installedApplication(arguments[1]),
        let data = try? JSONSerialization.data(withJSONObject: ["name": installed.name, "bundleId": installed.id, "path": installed.url.path], options: [.sortedKeys]), data.count <= 4096 else { exit(64) }
      try? FileHandle.standardOutput.write(contentsOf: data)
      return
    }
    // `--with-host` is additive: servers built before host identity existed
    // still request plain `--status` and strictly decode its original shape.
    if arguments == ["--status"] || arguments == ["--status", "--with-host"] {
      let application = NSApplication.shared
      application.setActivationPolicy(.prohibited)
      let running = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && !$0.isTerminated && processIdentity($0.processIdentifier) != nil }
      let groups = Dictionary(grouping: running, by: { $0.bundleIdentifier ?? "" })
      var emitted = Set<String>()
      let apps = running.sorted { $0.processIdentifier < $1.processIdentifier }.filter { app in
        guard let id = app.bundleIdentifier, !id.isEmpty, id.utf8.count <= 255, let group = groups[id],
          let url = app.bundleURL?.resolvingSymlinksInPath(), url.path.utf8.count <= 1024,
          Bundle(url: url)?.bundleIdentifier == id else { return false }
        let paths = group.compactMap { $0.bundleURL?.resolvingSymlinksInPath().path }
        guard paths.count == group.count, Set(paths).count == 1 else { return false }
        // The PID is display metadata. Selecting a canonical app never grants
        // input to this arbitrary representative; windows bind their owner.
        return emitted.insert(id).inserted
      }.sorted { ($0.localizedName ?? "") < ($1.localizedName ?? "") }.prefix(256).map { app in
        ["name": String((app.localizedName ?? "Application").prefix(128)), "bundleId": app.bundleIdentifier!, "path": app.bundleURL!.resolvingSymlinksInPath().path, "pid": Int(app.processIdentifier)] as [String: Any]
      }
      var status: [String: Any] = ["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "apps": apps]
      if arguments.count == 2 {
        status["osMajorVersion"] = ProcessInfo.processInfo.operatingSystemVersion.majorVersion
        status["responsibleApp"] = responsibleApplication() ?? NSNull()
      }
      guard let data = try? JSONSerialization.data(withJSONObject: status, options: [.sortedKeys]), data.count <= 512 * 1024 else { exit(64) }
      try? FileHandle.standardOutput.write(contentsOf: data)
      return
    }
    guard arguments.count >= 2, arguments.count % 2 == 0 else { exit(64) }
    var bundleIDs: [String] = []
    var installations: [String: URL] = [:]
    var inputMode = InputMode.background, foundInputMode = false
    for i in stride(from: 0, to: arguments.count, by: 2) {
      if arguments[i] == "--input-mode" {
        guard !foundInputMode, let mode = InputMode(rawValue: arguments[i+1]) else { exit(64) }
        foundInputMode = true; inputMode = mode
      } else if arguments[i] == "--allow-app-path" {
        guard arguments[i+1].hasPrefix("/"), let installed = try? installedApplication(arguments[i+1]), installations[installed.id] == nil else { exit(64) }
        installations[installed.id] = installed.url
      } else {
        guard arguments[i] == "--allow-app" else { exit(64) }
        bundleIDs.append(arguments[i+1])
      }
    }
    // CPS focus queries require an AppKit/WindowServer connection. Capture used
    // to initialize one incidentally; an AX-only session must establish its own
    // before creating the focus guard. This helper owns no UI, Dock icon or
    // activation authority, and does not run NSApplication's window lifecycle.
    let application = NSApplication.shared
    if application.activationPolicy() != .prohibited { application.setActivationPolicy(.prohibited) }
    guard application.activationPolicy() == .prohibited else { exit(64) }
    let service: GlideService
    let authority = ConnectionAuthority()
    diagnostic("native.initializing")
    do { service = try GlideService(bundleIDs: bundleIDs, installations: installations, authority: authority, inputMode: inputMode) } catch { exit(64) }
    diagnostic("native.ready")
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN); signal(SIGPIPE, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    terminate.setEventHandler { authority.revoke(); service.closeConnection(); exit(0) }
    interrupt.setEventHandler { authority.revoke(); service.closeConnection(); exit(0) }
    terminate.resume(); interrupt.resume()
    let admission = DispatchSemaphore(value: 1)
    // Keep reading while an asynchronous native operation is running, so exact
    // parent-pipe EOF revokes it promptly. A self-only backstop handles a blocked
    // system API without depending on another process's PID or creation record.
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        while let header = try readExact(4) {
          let size = header.reduce(0) { ($0 << 8) | Int($1) }
          guard size > 0, size <= 256 * 1024, let body = try readExact(size), let request = try JSONSerialization.jsonObject(with: body) as? [String: Any], let id = integer(request["id"]), id > 0, admission.wait(timeout: .now()) == .success else { throw Failure("Invalid or overlapping native frame.") }
          diagnostic("native.request")
          Task { @MainActor in
            let response: [String: Any]
            do { response = ["id":id,"result":try await service.dispatch(request)] }
            catch let failure as Failure { response = ["id":id,"error":failure.message] }
            catch { response = ["id":id,"error":"Native operation failed. Inspect app state before repeating an action."] }
            // Admission retires before publication: the parent can read and
            // submit the next request immediately after the reply is written.
            admission.signal()
            do { try reply(response) } catch { service.closeConnection(); exit(1) }
          }
        }
        retireGlideConnection(service, authority)
      } catch { retireGlideConnection(service, authority) }
    }
    // A main CF run loop services MainActor, AX and pasteboard work without
    // creating a separate Dock/window lifecycle for each pipe connection.
    var context = CFRunLoopSourceContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil, equal: nil, hash: nil, schedule: nil, cancel: nil, perform: { _ in })
    guard let anchor = CFRunLoopSourceCreate(nil, 0, &context) else { exit(1) }
    CFRunLoopAddSource(CFRunLoopGetMain(), anchor, .defaultMode)
    CFRunLoopRun()
  }
}
