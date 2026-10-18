import AppKit
import ApplicationServices
import Darwin

enum NativeWindowMetadata {
  static func exact(_ id: CGWindowID) -> [String: Any]? {
    guard id > 0 else { return nil }
    // Quartz expects raw CGWindowID values in a non-retaining CFArray, rather
    // than boxed CFNumbers. The result must name exactly the requested window.
    var value = UnsafeRawPointer(bitPattern: UInt(id))
    guard let identifiers = CFArrayCreate(kCFAllocatorDefault, &value, 1, nil),
      let descriptions = CGWindowListCreateDescriptionFromArray(identifiers) as? [[String: Any]], descriptions.count == 1,
      let result = descriptions.first,
      let number = result[kCGWindowNumber as String] as? NSNumber,
      CFGetTypeID(number) != CFBooleanGetTypeID(), number.uint64Value == UInt64(id) else { return nil }
    return result
  }
}

// ScreenCaptureKit captures an attached window family even when its filter
// names a sheet. Normalize that image to the selected window's public bounds;
// otherwise parent chrome changes both the origin and image-to-input scale.
enum WindowCaptureGeometry {
  struct Crop {
    let pixels: CGRect
    let width: Int
    let height: Int
  }
  static func crop(window: CGRect, family: CGRect, width: Int, height: Int) -> Crop? {
    for frame in [window, family] {
      guard frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite, frame.height.isFinite,
        abs(frame.minX) <= 100_000, abs(frame.minY) <= 100_000,
        frame.width > 0, frame.height > 0, frame.width <= 100_000, frame.height <= 100_000 else { return nil }
    }
    guard width > 0, height > 0, width <= 2048, height <= 2048, family.contains(window) else { return nil }
    let scale = min(Double(width) / family.width, Double(height) / family.height)
    let pixels = CGRect(x: (window.minX - family.minX) * scale, y: (window.minY - family.minY) * scale, width: window.width * scale, height: window.height * scale)
    guard pixels.minX >= 0, pixels.minY >= 0, pixels.maxX <= Double(width) + 0.000001, pixels.maxY <= Double(height) + 0.000001 else { return nil }
    return Crop(pixels: pixels, width: min(2048, max(1, Int(ceil(pixels.width)))), height: min(2048, max(1, Int(ceil(pixels.height)))))
  }
}

// Sky classifies AX parent-chain recipients by launch state and activation
// policy. A finished ordinary application is a boundary: searching past it
// could route input to an unrelated ancestor.
enum AXRecipientPolicy {
  enum ProcessType: Equatable { case regularApp, viewService, nonEventHandlingProcess }
  struct Candidate {
    let process: FocusProcess?
    let type: ProcessType
  }
  struct Selection: Equatable {
    let recipient: FocusProcess
    let hostedAncestorIndex: Int?
  }
  enum Refusal: Error { case unavailableIdentity, replacedRoot }

  static func processType(finished: Bool, activationPolicy: Int?) -> ProcessType {
    guard finished, let activationPolicy else { return .nonEventHandlingProcess }
    return activationPolicy == NSApplication.ActivationPolicy.prohibited.rawValue ? .viewService : .regularApp
  }

  static func select(root: FocusProcess, candidates: [Candidate]) throws -> Selection {
    for (index, candidate) in candidates.enumerated() {
      guard candidate.type != .nonEventHandlingProcess else { continue }
      guard let process = candidate.process, process.pid > 0 else { throw Refusal.unavailableIdentity }
      if process.pid == root.pid, process != root { throw Refusal.replacedRoot }
      guard candidate.type == .viewService, process != root else {
        return Selection(recipient: root, hostedAncestorIndex: nil)
      }
      return Selection(recipient: process, hostedAncestorIndex: index)
    }
    return Selection(recipient: root, hostedAncestorIndex: nil)
  }
}

// AXMenu may inherit the document's native ID. Rebinding is permitted only to
// one exact-geometry native menu owned by the already AX-admitted recipient.
// Geometry alone never grants another process authority.
enum MenuWindowPolicy {
  struct Candidate {
    let id: CGWindowID
    let owner: Int32
    let layer: Int
    let bounds: CGRect
    let alpha: Double
  }
  static func select(recipient: Int32, reference: CGWindowID?, bounds: CGRect, candidates: [Candidate]) -> Candidate? {
    guard recipient > 0, candidates.count <= 4096,
      bounds.minX.isFinite, bounds.minY.isFinite, bounds.width.isFinite, bounds.height.isFinite,
      bounds.width > 0, bounds.height > 0 else { return nil }
    let matches = candidates.filter { candidate in
      candidate.id > 0 && candidate.owner == recipient && (candidate.layer > 0 || candidate.id == reference) &&
        candidate.alpha.isFinite && candidate.alpha > 0 &&
        candidate.bounds.width > 0 && candidate.bounds.height > 0 &&
        abs(candidate.bounds.minX - bounds.minX) < 1 && abs(candidate.bounds.minY - bounds.minY) < 1 &&
        abs(candidate.bounds.width - bounds.width) < 1 && abs(candidate.bounds.height - bounds.height) < 1
    }
    return matches.count == 1 ? matches.first : nil
  }
}

// This policy applies only inside an active PID-targeted menu tap. It cannot
// acquire authority over global user input or infer a window owner from the
// event's target PID. Unknown window ownership passes through.
struct MenuDismissalPolicy {
  enum Decision: Equatable { case pass, suppress }
  private var root: FocusProcess?
  private var menu: FocusProcess?

  mutating func arm(root: FocusProcess, menu: FocusProcess?) { self.root = root; self.menu = menu }
  mutating func disarm() { root = nil; menu = nil }

  func observe(stream: FocusProcess, windowOwner: FocusProcess?, isLive: (FocusProcess) -> Bool) -> Decision {
    guard let root, isLive(root), menu.map(isLive) ?? true,
          stream == root || stream == menu, isLive(stream),
          let windowOwner, isLive(windowOwner) else { return .pass }
    return windowOwner == root || windowOwner == menu ? .pass : .suppress
  }
}

// The caller supplies an AX element already admitted through the approved root
// snapshot. This read-only resolver derives a recipient; it does not create
// input authority, change application focus, or send an event. Every dispatch
// still revalidates the approved root, the recipient, and native window owner.
@MainActor
enum AXRecipientResolver {
  struct Route {
    let root: FocusProcess
    let recipient: FocusProcess
    let targetElement: AXUIElement?
    let hostedWindowID: CGWindowID?
    let hostedWindow: AXUIElement?
    var isHosted: Bool { recipient != root }
  }

  enum Refusal: Error, LocalizedError {
    case processChanged, actualPIDUnavailable, parentChainLimit, hostedWindowUnavailable, deadlineExpired
    var errorDescription: String? {
      switch self {
      case .processChanged: return "The approved application or hosted recipient changed process identity. Obtain fresh app state."
      case .actualPIDUnavailable: return "Hosted accessibility recipient routing is unavailable. No foreground fallback was attempted."
      case .parentChainLimit: return "The accessibility parent chain exceeded its bounded traversal or contained a cycle."
      case .hostedWindowUnavailable: return "The hosted accessibility recipient has no confirmed native window. Obtain fresh app state."
      case .deadlineExpired: return "Accessibility recipient resolution exceeded its bounded allowance. Obtain fresh app state."
      }
    }
  }

  private typealias GetPID = @convention(c) (AXUIElement, UnsafeMutablePointer<Int32>) -> AXError
  private typealias GetWindow = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
  private static let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_NOW | RTLD_LOCAL)
  private static let getActualPID: GetPID? = {
    guard let library, let symbol = dlsym(library, "_AXUIElementGetActualPid") else { return nil }
    return unsafeBitCast(symbol, to: GetPID.self)
  }()
  private static let getWindow: GetWindow? = {
    guard let library, let symbol = dlsym(library, "_AXUIElementGetWindow") else { return nil }
    return unsafeBitCast(symbol, to: GetWindow.self)
  }()
  private static let maximumDepth = 300

  private static func parent(_ element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
  }

  private static func role(_ element: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &value) == .success else { return nil }
    return value as? String
  }

  private static func candidate(_ element: AXUIElement, getPID: GetPID, identity: (Int32) -> ProcessIdentity?) -> AXRecipientPolicy.Candidate {
    var pid: Int32 = 0
    guard getPID(element, &pid) == .success, pid > 0,
          let application = NSRunningApplication(processIdentifier: pid) else {
      return AXRecipientPolicy.Candidate(process: nil, type: .nonEventHandlingProcess)
    }
    let type = AXRecipientPolicy.processType(finished: application.isFinishedLaunching && !application.isTerminated, activationPolicy: application.activationPolicy.rawValue)
    return AXRecipientPolicy.Candidate(process: identity(pid).map { FocusProcess(pid: pid, birth: $0) }, type: type)
  }

  // The supplied element must already belong to an approved snapshot/menu.
  // This reference identifies a native window, but its AX node frame need not
  // be the window frame. The caller resolves exact CG owner/bounds separately.
  static func windowReference(element: AXUIElement) -> (element: AXUIElement, id: CGWindowID)? {
    try? locateWindow(element)
  }

  private static func locateWindow(_ element: AXUIElement, before: UInt64? = nil) throws -> (element: AXUIElement, id: CGWindowID) {
    guard let getWindow else { throw Refusal.hostedWindowUnavailable }
    var visited = [AXUIElement]()
    var current: AXUIElement? = element
    while let value = current {
      if let before, DispatchTime.now().uptimeNanoseconds >= before { throw Refusal.deadlineExpired }
      guard visited.count < maximumDepth, !visited.contains(where: { CFEqual($0, value) }) else { throw Refusal.parentChainLimit }
      visited.append(value)
      var id: CGWindowID = 0
      if getWindow(value, &id) == .success, id > 0 {
        if let before, DispatchTime.now().uptimeNanoseconds >= before { throw Refusal.deadlineExpired }
        return (value, id)
      }
      let role = role(value)
      if role == kAXWindowRole || role == kAXSheetRole { throw Refusal.hostedWindowUnavailable }
      current = parent(value)
    }
    throw Refusal.hostedWindowUnavailable
  }

  static func resolve(root: FocusProcess, element: AXUIElement?, needsWindow: Bool, before: UInt64? = nil, identity: (Int32) -> ProcessIdentity?) throws -> Route {
    guard root.pid > 0, identity(root.pid) == root.birth else { throw Refusal.processChanged }
    guard let element else { return Route(root: root, recipient: root, targetElement: nil, hostedWindowID: nil, hostedWindow: nil) }
    guard let getActualPID else { throw Refusal.actualPIDUnavailable }

    var chain = [AXUIElement]()
    var candidates = [AXRecipientPolicy.Candidate]()
    var current: AXUIElement? = element
    while let value = current {
      if let before, DispatchTime.now().uptimeNanoseconds >= before { throw Refusal.deadlineExpired }
      guard chain.count < maximumDepth, !chain.contains(where: { CFEqual($0, value) }) else { throw Refusal.parentChainLimit }
      chain.append(value)
      let candidate = candidate(value, getPID: getActualPID, identity: identity)
      candidates.append(candidate)
      if candidate.type != .nonEventHandlingProcess { break }
      current = parent(value)
    }
    if let before, DispatchTime.now().uptimeNanoseconds >= before { throw Refusal.deadlineExpired }
    let selection: AXRecipientPolicy.Selection
    do { selection = try AXRecipientPolicy.select(root: root, candidates: candidates) }
    catch { throw Refusal.processChanged }
    guard identity(root.pid) == root.birth, identity(selection.recipient.pid) == selection.recipient.birth else { throw Refusal.processChanged }
    guard let hostedIndex = selection.hostedAncestorIndex, needsWindow else {
      return Route(root: root, recipient: selection.recipient, targetElement: element, hostedWindowID: nil, hostedWindow: nil)
    }
    // Window lookup begins at the selected hosted ancestor. Sky stops at an
    // AXWindow/AXSheet boundary without a window ID instead of escaping it.
    let reference = try locateWindow(chain[hostedIndex], before: before)
    guard identity(root.pid) == root.birth, identity(selection.recipient.pid) == selection.recipient.birth else { throw Refusal.processChanged }
    return Route(root: root, recipient: selection.recipient, targetElement: element, hostedWindowID: reference.id, hostedWindow: reference.element)
  }
}
