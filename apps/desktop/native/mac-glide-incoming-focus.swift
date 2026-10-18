import AppKit
import ApplicationServices
import Darwin

// Suppression/recovery proof never grants agent input authority. Existing
// shared auxiliaries can be proven before dispatch. A newly observed raw
// subject is queried only on the independent bounded AX lane while its Taken
// callback waits outside the admission lock; late work cannot publish proof.
enum BackgroundIncomingFocusProofPolicy {
  enum ProcessKind { case prohibited, unrepresented, regular }
  enum Context: Int, Sendable { case focusedElement, focusedWindow, mainWindow }
  struct Evidence {
    let exactName: Bool
    let currentUser: Bool
    let kind: ProcessKind
    let context: Context
    let equalHandles: Bool
    let rootLogicalPID: Int32?
    let auxiliaryLogicalPID: Int32?
    let rootActual: FocusProcess?
    let auxiliaryActual: FocusProcess?
  }
  struct Proof: Equatable, Sendable {
    let root: FocusProcess
    let rawSubject: FocusProcess
    let recipient: FocusProcess?
    let generation: UInt64
    let context: Context
    let specialAuxiliary: Bool

    func admits(root: FocusProcess, generation: UInt64, isLive: (FocusProcess) -> Bool) -> Bool {
      self.root == root && self.generation == generation && isLive(root) && isLive(rawSubject) && (recipient.map(isLive) ?? true)
    }
  }

  static func prove(root: FocusProcess, rawSubject: FocusProcess, knownRecipient: FocusProcess?, generation: UInt64, evidence: Evidence, requiresExactName: Bool = true, derivedRecipient: FocusProcess? = nil, isLive: (FocusProcess) -> Bool) -> Proof? {
    guard root.pid > 0, rawSubject.pid > 0, root.pid != rawSubject.pid,
          isLive(root), isLive(rawSubject), knownRecipient.map(isLive) ?? true,
          (!requiresExactName || evidence.exactName), evidence.currentUser, evidence.kind != .regular,
          evidence.equalHandles, evidence.rootLogicalPID == root.pid,
          evidence.auxiliaryLogicalPID == root.pid,
          let actual = evidence.rootActual, actual == evidence.auxiliaryActual,
          isLive(actual), actual == root || actual == rawSubject || actual == knownRecipient || actual == derivedRecipient else { return nil }
    return Proof(root: root, rawSubject: rawSubject, recipient: actual == root ? nil : actual, generation: generation, context: evidence.context, specialAuxiliary: evidence.exactName)
  }

  // Multiple matching contexts for one exact auxiliary are harmless; two raw
  // subjects are ambiguous and cannot expand the fixed suppression scope.
  static func unique(_ proofs: [Proof]) -> [Proof] {
    guard let first = proofs.first, proofs.allSatisfy({ $0.root == first.root && $0.rawSubject == first.rawSubject && $0.generation == first.generation && $0.recipient == first.recipient && $0.specialAuxiliary == first.specialAuxiliary }) else { return [] }
    return [first]
  }
}

// One absolute allowance covers proof and rescue-tap readiness. Completion is
// one-use; timeout, replacement and cancellation cannot publish authority later.
struct BackgroundIncomingFocusWork {
  static let maximumNanoseconds: UInt64 = 40_000_000
  let root: FocusProcess
  let subject: FocusProcess
  let foreground: FocusProcess
  let generation: UInt64
  let deadline: UInt64
  private var retired = false
  private var result: BackgroundIncomingFocusProofPolicy.Proof?

  init?(root: FocusProcess, subject: FocusProcess, foreground: FocusProcess, generation: UInt64, now: UInt64, deadline: UInt64) {
    guard root.pid > 0, subject.pid > 0, foreground.pid > 0, root.pid != subject.pid,
      deadline > now, deadline - now <= Self.maximumNanoseconds else { return nil }
    self.root = root; self.subject = subject; self.foreground = foreground; self.generation = generation; self.deadline = deadline
  }

  func isLive(now: UInt64, isLive: (FocusProcess) -> Bool) -> Bool {
    !retired && now < deadline && isLive(root) && isLive(subject) && isLive(foreground)
  }

  mutating func publish(_ proof: BackgroundIncomingFocusProofPolicy.Proof?, now: UInt64, isLive: (FocusProcess) -> Bool) -> Bool {
    guard result == nil, self.isLive(now: now, isLive: isLive), let proof, proof.rawSubject == subject,
      proof.admits(root: root, generation: generation, isLive: isLive) else { retire(); return false }
    result = proof
    return true
  }

  mutating func take(root: FocusProcess, subject: FocusProcess, foreground: FocusProcess, generation: UInt64, now: UInt64, isLive: (FocusProcess) -> Bool) -> BackgroundIncomingFocusProofPolicy.Proof? {
    defer { retire() }
    guard self.root == root, self.subject == subject, self.foreground == foreground, self.generation == generation,
      self.isLive(now: now, isLive: isLive), let result,
      result.admits(root: root, generation: generation, isLive: isLive) else { return nil }
    return result
  }

  mutating func retire() { retired = true; result = nil }
}

// A blocked AX server cannot tie up the event-tap thread beyond its original
// allowance. The lane has at most one outstanding request, including a late OS
// call; retired work is read-only and cannot later install a tap or focus policy.
final class BackgroundIncomingFocusLane: @unchecked Sendable {
  private final class Request: @unchecked Sendable {
    let lock = NSLock()
    let completed = DispatchSemaphore(value: 0)
    var work: BackgroundIncomingFocusWork
    init(_ work: BackgroundIncomingFocusWork) { self.work = work }
  }
  private let lock = NSLock()
  private var busy = false
  private let queue = DispatchQueue(label: "cafe-glide-incoming-focus-proof", qos: .userInitiated)

  func resolve(root: FocusProcess, subject: FocusProcess, retainedForeground: FocusProcess, generation: UInt64, knownRecipient: FocusProcess?, before deadline: UInt64, identity: @escaping @Sendable (Int32) -> ProcessIdentity?) -> BackgroundIncomingFocusProofPolicy.Proof? {
    guard let work = BackgroundIncomingFocusWork(root: root, subject: subject, foreground: retainedForeground, generation: generation, now: DispatchTime.now().uptimeNanoseconds, deadline: deadline) else { return nil }
    lock.lock()
    guard !busy else { lock.unlock(); return nil }
    busy = true; lock.unlock()
    let request = Request(work)
    queue.async { [self] in
      autoreleasepool {
        request.lock.lock()
        let live = request.work.isLive(now: DispatchTime.now().uptimeNanoseconds) { identity($0.pid) == $0.birth }
        request.lock.unlock()
        let proof = live ? BackgroundIncomingFocusResolver.resolveSubject(root: root, subject: subject, generation: generation, knownRecipient: knownRecipient, before: deadline, identity: identity) : nil
        request.lock.lock()
        _ = request.work.publish(proof, now: DispatchTime.now().uptimeNanoseconds) { identity($0.pid) == $0.birth }
        request.lock.unlock()
        lock.lock(); busy = false; lock.unlock()
        request.completed.signal()
      }
    }
    let finished = request.completed.wait(timeout: DispatchTime(uptimeNanoseconds: deadline)) == .success
    request.lock.lock(); defer { request.lock.unlock() }
    guard finished else { request.work.retire(); return nil }
    return request.work.take(root: root, subject: subject, foreground: retainedForeground, generation: generation, now: DispatchTime.now().uptimeNanoseconds) { identity($0.pid) == $0.birth }
  }
}

// The special ViewBridge NewFront branch in Sky requires successful focus
// release. A release decision alone is not proof that the WindowServer call
// succeeded. The native owner reports that result synchronously after the call.
struct BackgroundAuxiliaryFocusPolicy {
  private var policy = BackgroundFocusPolicy()
  private var subject: FocusProcess?
  private var pendingTarget: FocusProcess?
  private var releaseRequested: UInt32?
  private var releaseSucceeded = false
  private var suppressesNewFront = false

  mutating func arm(_ subject: FocusProcess, current: FocusProcess, suppressesNewFront: Bool = true) {
    self.subject = subject
    pendingTarget = nil
    releaseRequested = nil; releaseSucceeded = false
    self.suppressesNewFront = suppressesNewFront
    policy.arm(subject, current: current)
  }

  mutating func disarm() {
    subject = nil; pendingTarget = nil; releaseRequested = nil; releaseSucceeded = false; suppressesNewFront = false; policy.disarm()
  }

  // Outside input revokes new background focus attempts without abandoning a
  // token already admitted by an earlier Taken notification. Hard lifecycle
  // retirement still uses disarm(), which clears every pending fact.
  mutating func revokeFutureAdmission() { policy.revokeFutureAdmission() }

  mutating func observe(kind: UInt16, subject: FocusProcess?, target: FocusProcess?, token: Int64, isLive: (FocusProcess) -> Bool) -> BackgroundFocusPolicy.Decision {
    if kind == 2, let subject, subject == self.subject, isLive(subject) {
      let suppress = suppressesNewFront && releaseSucceeded && (pendingTarget.map(isLive) ?? false)
      _ = policy.observe(kind: kind, subject: subject, target: target, token: token, isLive: isLive)
      pendingTarget = nil; releaseRequested = nil; releaseSucceeded = false
      return suppress ? .suppress : .pass
    }
    let result = policy.observe(kind: kind, subject: subject, target: target, token: token, isLive: isLive)
    if kind == 0x4000, result == .suppress, target != pendingTarget {
      pendingTarget = target; releaseRequested = nil; releaseSucceeded = false
    }
    if case .release(let value) = result { releaseRequested = value; releaseSucceeded = false }
    if case .invalidToken = result { releaseRequested = nil; releaseSucceeded = false }
    if kind == 0xf102, let subject, subject != self.subject, isLive(subject) {
      pendingTarget = nil; releaseRequested = nil; releaseSucceeded = false
    }
    return result
  }

  mutating func noteReleaseResult(token: UInt32, success: Bool) {
    guard releaseRequested == token else { return }
    releaseRequested = nil; releaseSucceeded = success
  }
}

// Sky discovers current-user ViewBridgeAuxiliary processes with PROC_UID_ONLY,
// then resolves their logical AX owner without its generic localized-name
// fallback. Glide additionally requires equal root/auxiliary AX handles, exact
// public root PID and matching private actual-PID process generations.
enum BackgroundIncomingFocusResolver {
  typealias Proof = BackgroundIncomingFocusProofPolicy.Proof
  private typealias GetPID = @convention(c) (AXUIElement, UnsafeMutablePointer<Int32>) -> AXError
  private static let library = dlopen("/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices", RTLD_NOW | RTLD_LOCAL)
  private static let getActualPID: GetPID? = {
    guard let library, let symbol = dlsym(library, "_AXUIElementGetActualPid") else { return nil }
    return unsafeBitCast(symbol, to: GetPID.self)
  }()
  private static let processName = "ViewBridgeAuxiliary"
  private static let maximumPIDs = 16_384
  private static let maximumAuxiliaries = 8
  private static let budgetNanoseconds: UInt64 = 150_000_000
  private static let messagingTimeout: Float = 0.01

  private struct Candidate {
    let process: FocusProcess
    let kind: BackgroundIncomingFocusProofPolicy.ProcessKind
  }

  private static func process(_ pid: Int32, identity: (Int32) -> ProcessIdentity?) -> (candidate: Candidate, exactName: Bool)? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
      info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), let birth = identity(pid) else { return nil }
    let name = withUnsafeBytes(of: info.pbi_name) { bytes -> String? in
      guard let end = bytes.firstIndex(of: 0) else { return nil }
      return String(bytes: bytes.prefix(end), encoding: .utf8)
    }
    let kind: BackgroundIncomingFocusProofPolicy.ProcessKind
    if let application = NSRunningApplication(processIdentifier: pid) {
      // Sky's focus-owner classifier checks prohibited activation policy even
      // before DidFinishLaunching. Input recipient traversal has a separate
      // finished-launch boundary and retains that stricter routing predicate.
      guard !application.isTerminated, application.activationPolicy == .prohibited else { return nil }
      kind = .prohibited
    } else { kind = .unrepresented }
    return (Candidate(process: FocusProcess(pid: pid, birth: birth), kind: kind), name == processName)
  }

  // Called only on the bounded resolver lane for the exact raw subject from
  // the held Taken callback. No process inventory or main-actor hop occurs.
  static func resolveSubject(root: FocusProcess, subject: FocusProcess, generation: UInt64, knownRecipient: FocusProcess?, before deadline: UInt64, identity: (Int32) -> ProcessIdentity?) -> Proof? {
    guard DispatchTime.now().uptimeNanoseconds < deadline,
      identity(root.pid) == root.birth, let getActualPID,
      let value = process(subject.pid, identity: identity), value.candidate.process == subject else { return nil }
    let application = AXUIElementCreateApplication(root.pid), auxiliary = AXUIElementCreateApplication(subject.pid)
    let contexts: [(BackgroundIncomingFocusProofPolicy.Context, CFString)] = [
      (.focusedElement, kAXFocusedUIElementAttribute as CFString),
      (.focusedWindow, kAXFocusedWindowAttribute as CFString),
      (.mainWindow, kAXMainWindowAttribute as CFString),
    ]
    for (context, attribute) in contexts {
      guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      guard let rootElement = element(application, attribute: attribute, before: deadline),
        let auxiliaryElement = element(auxiliary, attribute: attribute, before: deadline), CFEqual(rootElement, auxiliaryElement) else { continue }
      let rootActual = actual(rootElement, getPID: getActualPID, identity: identity, before: deadline)
      let auxiliaryActual = actual(auxiliaryElement, getPID: getActualPID, identity: identity, before: deadline)
      let derived = rootActual.flatMap { actual in process(actual.pid, identity: identity)?.candidate.process == actual ? actual : nil }
      let evidence = BackgroundIncomingFocusProofPolicy.Evidence(
        exactName: value.exactName, currentUser: true, kind: value.candidate.kind, context: context, equalHandles: true,
        rootLogicalPID: logicalPID(rootElement, before: deadline), auxiliaryLogicalPID: logicalPID(auxiliaryElement, before: deadline),
        rootActual: rootActual, auxiliaryActual: auxiliaryActual)
      guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      if let proof = BackgroundIncomingFocusProofPolicy.prove(root: root, rawSubject: subject, knownRecipient: knownRecipient, generation: generation, evidence: evidence, requiresExactName: false, derivedRecipient: derived, isLive: { identity($0.pid) == $0.birth }) { return proof }
    }
    return nil
  }

  private static func candidates(identity: (Int32) -> ProcessIdentity?, before deadline: UInt64) -> [Candidate]? {
    let bytes = maximumPIDs * MemoryLayout<Int32>.stride
    let needed = proc_listpids(UInt32(PROC_UID_ONLY), getuid(), nil, 0)
    guard needed > 0, needed < bytes, DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    var pids = [Int32](repeating: 0, count: maximumPIDs)
    let count = pids.withUnsafeMutableBytes { proc_listpids(UInt32(PROC_UID_ONLY), getuid(), $0.baseAddress, Int32(bytes)) }
    guard count > 0, count < bytes, Int(count) % MemoryLayout<Int32>.stride == 0 else { return nil }
    var values = [Candidate]()
    for pid in pids.prefix(Int(count) / MemoryLayout<Int32>.stride) where pid > 0 {
      guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
      var info = proc_bsdinfo()
      let size = Int32(MemoryLayout<proc_bsdinfo>.size)
      guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
            info.pbi_pid == UInt32(pid), info.pbi_uid == getuid() else { continue }
      let name = withUnsafeBytes(of: info.pbi_name) { bytes -> String? in
        guard let end = bytes.firstIndex(of: 0) else { return nil }
        return String(bytes: bytes.prefix(end), encoding: .utf8)
      }
      guard name == processName, let birth = identity(pid) else { continue }
      let application = NSRunningApplication(processIdentifier: pid)
      let kind: BackgroundIncomingFocusProofPolicy.ProcessKind
      if let application {
        guard application.isFinishedLaunching, !application.isTerminated, application.activationPolicy == .prohibited else { continue }
        kind = .prohibited
      } else { kind = .unrepresented }
      guard values.count < maximumAuxiliaries else { return nil }
      values.append(Candidate(process: FocusProcess(pid: pid, birth: birth), kind: kind))
    }
    return values
  }

  private static func element(_ application: AXUIElement, attribute: CFString, before deadline: UInt64) -> AXUIElement? {
    guard DispatchTime.now().uptimeNanoseconds < deadline,
          AXUIElementSetMessagingTimeout(application, messagingTimeout) == .success else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, attribute, &value) == .success,
          DispatchTime.now().uptimeNanoseconds < deadline,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    let element = unsafeBitCast(value, to: AXUIElement.self)
    guard AXUIElementSetMessagingTimeout(element, messagingTimeout) == .success else { return nil }
    return element
  }

  private static func logicalPID(_ element: AXUIElement, before deadline: UInt64) -> Int32? {
    guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    var pid: Int32 = 0
    guard AXUIElementGetPid(element, &pid) == .success, pid > 0 else { return nil }
    return pid
  }

  private static func actual(_ element: AXUIElement, getPID: GetPID, identity: (Int32) -> ProcessIdentity?, before deadline: UInt64) -> FocusProcess? {
    guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    var pid: Int32 = 0
    guard getPID(element, &pid) == .success, pid > 0, let birth = identity(pid) else { return nil }
    return FocusProcess(pid: pid, birth: birth)
  }

  static func prepare(root: FocusProcess, generation: UInt64, knownRecipient: FocusProcess?, identity: (Int32) -> ProcessIdentity?) -> [Proof] {
    guard identity(root.pid) == root.birth, knownRecipient.map({ identity($0.pid) == $0.birth }) ?? true,
          let getActualPID else { return [] }
    let start = DispatchTime.now().uptimeNanoseconds
    guard start <= UInt64.max - budgetNanoseconds else { return [] }
    let deadline = start + budgetNanoseconds
    guard let candidates = candidates(identity: identity, before: deadline) else { return [] }
    let application = AXUIElementCreateApplication(root.pid)
    let contexts: [(BackgroundIncomingFocusProofPolicy.Context, CFString)] = [
      (.focusedElement, kAXFocusedUIElementAttribute as CFString),
      (.focusedWindow, kAXFocusedWindowAttribute as CFString),
      (.mainWindow, kAXMainWindowAttribute as CFString),
    ]
    var proofs = [Proof]()
    for candidate in candidates where candidate.process.pid != root.pid {
      let auxiliary = AXUIElementCreateApplication(candidate.process.pid)
      for (context, attribute) in contexts {
        guard DispatchTime.now().uptimeNanoseconds < deadline else { return [] }
        guard let rootElement = element(application, attribute: attribute, before: deadline),
              let auxiliaryElement = element(auxiliary, attribute: attribute, before: deadline),
              CFEqual(rootElement, auxiliaryElement) else { continue }
        let evidence = BackgroundIncomingFocusProofPolicy.Evidence(
          exactName: true, currentUser: true, kind: candidate.kind, context: context, equalHandles: true,
          rootLogicalPID: logicalPID(rootElement, before: deadline), auxiliaryLogicalPID: logicalPID(auxiliaryElement, before: deadline),
          rootActual: actual(rootElement, getPID: getActualPID, identity: identity, before: deadline),
          auxiliaryActual: actual(auxiliaryElement, getPID: getActualPID, identity: identity, before: deadline))
        guard DispatchTime.now().uptimeNanoseconds < deadline else { return [] }
        if let proof = BackgroundIncomingFocusProofPolicy.prove(root: root, rawSubject: candidate.process, knownRecipient: knownRecipient, generation: generation, evidence: evidence, isLive: { identity($0.pid) == $0.birth }) {
          proofs.append(proof)
          break
        }
      }
    }
    return BackgroundIncomingFocusProofPolicy.unique(proofs)
  }
}
