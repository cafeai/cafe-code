import AppKit
import ApplicationServices
import Darwin

// An active menu is derived from the approved application's focused ancestry
// or the exact selected AX window. AppKit popup tracking need not change the
// focused element. Closed menu bars and unrelated application trees establish
// no authority. All reads share one bounded allowance.
@MainActor
enum AXMenuContext {
  struct Context {
    let element: AXUIElement
    let menuProcess: FocusProcess?
  }

  static func find(root: FocusProcess, window: AXUIElement? = nil, before: UInt64? = nil, identity: (Int32) -> ProcessIdentity?) -> Context? {
    guard root.pid > 0, identity(root.pid) == root.birth else { return nil }
    let deadline = min(before ?? UInt64.max, DispatchTime.now().uptimeNanoseconds + 100_000_000)
    var borrowed = [AXUIElement]()
    // Discovery borrows snapshot handles. Keep all of its reads short, then
    // restore the normal allowance before callers validate or act on them.
    defer { for element in borrowed { AXUIElementSetMessagingTimeout(element, 0.2) } }
    func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
      guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      if !borrowed.contains(where: { CFEqual($0, element) }) {
        guard borrowed.count < 1024 else { return nil }
        AXUIElementSetMessagingTimeout(element, 0.01)
        borrowed.append(element)
      }
      var result: CFTypeRef?
      return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success ? result : nil
    }
    func axElement(_ value: CFTypeRef?) -> AXUIElement? {
      guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
      return unsafeBitCast(value, to: AXUIElement.self)
    }
    func bounds(_ element: AXUIElement) -> CGRect? {
      guard let position = value(element, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
        let size = value(element, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
      var point = CGPoint.zero, dimensions = CGSize.zero
      guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
        AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
        point.x.isFinite, point.y.isFinite, dimensions.width.isFinite, dimensions.height.isFinite,
        dimensions.width > 0, dimensions.height > 0 else { return nil }
      return CGRect(origin: point, size: dimensions)
    }
    func context(_ menu: AXUIElement) -> Context? {
      guard DispatchTime.now().uptimeNanoseconds < deadline,
        value(menu, kAXRoleAttribute) as? String == kAXMenuRole,
        let rectangle = bounds(menu),
        let children = value(menu, kAXChildrenAttribute) as? [AXUIElement], children.count <= 512,
        children.contains(where: { child in
          value(child, kAXRoleAttribute) as? String == kAXMenuItemRole && bounds(child).map({ $0.intersects(rectangle) }) == true
        }) else { return nil }
      var actions: CFArray?
      guard AXUIElementCopyActionNames(menu, &actions) == .success,
        (actions as? [String])?.contains(kAXCancelAction) == true,
        let route = try? AXRecipientResolver.resolve(root: root, element: menu, needsWindow: false, before: deadline, identity: identity) else { return nil }
      var logicalPID: Int32 = 0
      guard AXUIElementGetPid(menu, &logicalPID) == .success,
        logicalPID == root.pid || logicalPID == route.recipient.pid,
        identity(root.pid) == root.birth, identity(route.recipient.pid) == route.recipient.birth,
        DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      return Context(element: menu, menuProcess: route.isHosted ? route.recipient : nil)
    }
    let application = AXUIElementCreateApplication(root.pid)
    var current = axElement(value(application, kAXFocusedUIElementAttribute))
    var visited = [AXUIElement]()
    while let element = current {
      guard visited.count < 300, !visited.contains(where: { CFEqual($0, element) }),
        DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      visited.append(element)
      if value(element, kAXRoleAttribute) as? String == kAXMenuRole { return context(element) }
      current = axElement(value(element, kAXParentAttribute))
    }
    guard let window, identity(root.pid) == root.birth else { return nil }
    var windowPID: Int32 = 0
    guard AXUIElementGetPid(window, &windowPID) == .success, windowPID == root.pid else { return nil }
    var stack: [(AXUIElement, Int)] = [(window, 0)]
    visited.removeAll(keepingCapacity: true)
    var result: Context?
    while let (node, depth) = stack.popLast() {
      guard visited.count < 512, DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      if visited.contains(where: { CFEqual($0, node) }) { continue }
      visited.append(node)
      var logicalPID: Int32 = 0
      guard AXUIElementGetPid(node, &logicalPID) == .success, logicalPID == root.pid else { continue }
      if value(node, kAXRoleAttribute) as? String == kAXMenuRole {
        if let candidate = context(node) {
          guard result == nil else { return nil }
          result = candidate
        }
        // A submenu does not receive authority through its parent's tree.
        // Its focused ancestry can independently establish the active menu.
        continue
      }
      if let children = value(node, kAXChildrenAttribute) as? [AXUIElement] {
        guard children.count <= 512, depth < 32 || children.isEmpty else { return nil }
        stack.append(contentsOf: children.reversed().map { ($0, depth + 1) })
        guard stack.count <= 512 else { return nil }
      }
    }
    guard identity(root.pid) == root.birth, DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    return result
  }

}

// A menu can otherwise receive an outside-window mouse event through its
// process stream and dismiss while the agent is controlling it in background.
// These taps are scoped to the exact root/menu processes, never the global
// mouse stream. Foreign user activity must call revoke() before it passes.
final class GlideMenuGuard: @unchecked Sendable {
  enum Refusal: Error, LocalizedError {
    case unavailable, retired, processChanged
    var errorDescription: String? {
      switch self {
      case .unavailable: return "Background menu event protection is unavailable. No foreground fallback was attempted."
      case .retired: return "Background menu protection was retired by outside activity or connection cleanup. Obtain fresh app state."
      case .processChanged: return "The approved application or hosted menu changed process identity. Obtain fresh app state."
      }
    }
  }

  private final class State: @unchecked Sendable {
    let lock = NSLock()
    let root: FocusProcess
    let menu: FocusProcess?
    let identity: @Sendable (Int32) -> ProcessIdentity?
    let started = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)
    var policy = MenuDismissalPolicy()
    var revoked = false
    var stopping = false
    var failed = false
    var runLoop: CFRunLoop?
    var taps = [CFMachPort]()

    init(root: FocusProcess, menu: FocusProcess?, identity: @escaping @Sendable (Int32) -> ProcessIdentity?) {
      self.root = root; self.menu = menu; self.identity = identity
      policy.arm(root: root, menu: menu)
    }

    func handle(stream: FocusProcess, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
      lock.lock()
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        failed = true; policy.disarm()
        lock.unlock()
        return Unmanaged.passUnretained(event)
      }
      let active = !revoked && !stopping && !failed
      lock.unlock()
      guard active else { return Unmanaged.passUnretained(event) }

      let rawID = event.getIntegerValueField(CGEventField(rawValue: 51)!)
      guard rawID > 0, rawID <= Int64(UInt32.max),
            let window = NativeWindowMetadata.exact(CGWindowID(rawID)),
            let number = window[kCGWindowOwnerPID as String] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID(),
            number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
            number.int64Value > 0, number.int64Value <= Int64(Int32.max),
            let birth = identity(Int32(number.int64Value)) else { return Unmanaged.passUnretained(event) }
      let owner = FocusProcess(pid: Int32(number.int64Value), birth: birth)

      lock.lock(); defer { lock.unlock() }
      guard !revoked && !stopping && !failed else { return Unmanaged.passUnretained(event) }
      let decision = policy.observe(stream: stream, windowOwner: owner) { identity($0.pid) == $0.birth }
      return decision == .suppress ? nil : Unmanaged.passUnretained(event)
    }
  }

  private final class TapContext {
    weak var state: State?
    let stream: FocusProcess
    init(state: State, stream: FocusProcess) { self.state = state; self.stream = stream }
  }

  private let state: State
  private let thread: Thread

  init(root: FocusProcess, menu: FocusProcess?, identity: @escaping @Sendable (Int32) -> ProcessIdentity?) throws {
    guard root.pid > 0, identity(root.pid) == root.birth,
          menu.map({ $0.pid > 0 && identity($0.pid) == $0.birth }) ?? true else { throw Refusal.processChanged }
    let state = State(root: root, menu: menu, identity: identity)
    self.state = state
    thread = Thread { Self.run(state) }
    thread.name = "cafe-glide-background-menu"
    thread.qualityOfService = .utility
    thread.start()
    guard state.started.wait(timeout: .now() + 2) == .success else {
      stop()
      throw Refusal.unavailable
    }
    do { try validate() }
    catch { stop(); throw error }
  }

  deinit { stop() }

  // This is safe from the focus guard's activity tap: no run-loop operation or
  // thread join occurs. Native caller later calls stop() from its owner thread.
  func revoke() {
    state.lock.lock()
    state.revoked = true
    state.policy.disarm()
    state.lock.unlock()
  }

  func validate() throws {
    state.lock.lock()
    let retired = state.revoked || state.stopping
    let failed = state.failed
    let taps = state.taps
    state.lock.unlock()
    guard !retired else { throw Refusal.retired }
    guard !failed, !taps.isEmpty, taps.allSatisfy({ CGEvent.tapIsEnabled(tap: $0) }) else { throw Refusal.unavailable }
    guard state.identity(state.root.pid) == state.root.birth,
          state.menu.map({ state.identity($0.pid) == $0.birth }) ?? true else { throw Refusal.processChanged }
  }

  func stop() {
    state.lock.lock()
    let alreadyStopping = state.stopping
    state.stopping = true
    state.revoked = true
    state.policy.disarm()
    let loop = state.runLoop
    state.lock.unlock()
    if let loop {
      CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(loop) }
      CFRunLoopWakeUp(loop)
    }
    // The worker owns its callback contexts until invalidation completes. A
    // bounded join cannot free context memory still in use by a native callback.
    if !alreadyStopping, Thread.current !== thread { _ = state.finished.wait(timeout: .now() + 2) }
  }

  private static func run(_ state: State) {
    let loop = CFRunLoopGetCurrent()!
    var ports = [CFMachPort]()
    var sources = [CFRunLoopSource]()
    var contexts = [TapContext]()
    defer {
      for port in ports { CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port) }
      for source in sources { CFRunLoopRemoveSource(loop, source, .commonModes); CFRunLoopSourceInvalidate(source) }
      // Keep the exact unretained callback pointers alive through invalidation.
      withExtendedLifetime(contexts) {}
      state.lock.lock()
      state.taps.removeAll(); state.runLoop = nil; state.policy.disarm()
      state.lock.unlock()
      state.finished.signal()
    }
    let mask = [UInt32(1), 2, 6, 3, 4, 7, 25, 26, 27].reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1) }
    let streams = state.menu.map({ $0 == state.root ? [state.root] : [state.root, $0] }) ?? [state.root]
    for stream in streams {
      let context = TapContext(state: state, stream: stream)
      contexts.append(context)
      guard let port = CGEvent.tapCreateForPid(pid: stream.pid, place: .headInsertEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
        guard let pointer else { return Unmanaged.passUnretained(event) }
        let context = Unmanaged<TapContext>.fromOpaque(pointer).takeUnretainedValue()
        guard let state = context.state else { return Unmanaged.passUnretained(event) }
        return state.handle(stream: context.stream, type: type, event: event)
      }, userInfo: Unmanaged.passUnretained(context).toOpaque()) else {
        state.lock.lock(); state.failed = true; state.policy.disarm(); state.lock.unlock()
        state.started.signal()
        return
      }
      ports.append(port)
      guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
        state.lock.lock(); state.failed = true; state.policy.disarm(); state.lock.unlock()
        state.started.signal()
        return
      }
      sources.append(source)
      CFRunLoopAddSource(loop, source, .commonModes)
    }
    state.lock.lock()
    state.runLoop = loop; state.taps = ports
    let shouldRun = !state.stopping && !state.revoked
    state.lock.unlock()
    guard shouldRun else { state.started.signal(); return }
    CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) {
      state.started.signal()
      state.lock.lock(); let retired = state.stopping || state.revoked; state.lock.unlock()
      if retired { CFRunLoopStop(loop) }
    }
    CFRunLoopRun()
  }
}
