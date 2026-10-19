import ApplicationServices
import Foundation
import Darwin

// Sky owns one active PID-targeted keyboard tap per registered process. These
// taps recover a foreign key already addressed to a transient focus thief;
// they never inspect key contents or redirect helper-owned keyboard input.
final class GlideKeyRescueGuard: @unchecked Sendable {
  enum Refusal: Error, LocalizedError {
    case unavailable, retired, processChanged
    var errorDescription: String? {
      switch self {
      case .unavailable: return "Background keyboard recovery is unavailable. No foreground fallback was attempted."
      case .retired: return "Background keyboard recovery was retired. Obtain fresh app state."
      case .processChanged: return "A background keyboard recipient changed process identity. Obtain fresh app state."
      }
    }
  }

  fileprivate final class State: @unchecked Sendable {
    let lock = NSLock()
    var processes: [FocusProcess]
    let identity: @Sendable (Int32) -> ProcessIdentity?
    let started = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)
    var policy = BackgroundKeyRescuePolicy()
    var stopping = false
    var failed = false
    var runLoop: CFRunLoop?
    var taps = [CFMachPort]()
    var additions = [Registration]()

    init(processes: [FocusProcess], identity: @escaping @Sendable (Int32) -> ProcessIdentity?) {
      self.processes = processes; self.identity = identity
    }

    func handle(stream: FocusProcess, type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
      let pass = Unmanaged.passUnretained(event)
      lock.lock(); defer { lock.unlock() }
      if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        failed = true; policy.retire(); return pass
      }
      guard !stopping && !failed, [CGEventType.keyDown, .keyUp, .flagsChanged].contains(type),
            processes.contains(stream), identity(stream.pid) == stream.birth else { return pass }
      let rawTarget = event.getIntegerValueField(.eventTargetUnixProcessID)
      guard rawTarget == Int64(stream.pid),
            let targetBirth = identity(stream.pid) else { return pass }
      let target = FocusProcess(pid: stream.pid, birth: targetBirth)
      guard let recipient = policy.recipient(sourcePID: event.getIntegerValueField(.eventSourceUnixProcessID), helperPID: getpid(), eventTarget: target, isLive: { identity($0.pid) == $0.birth }),
            identity(recipient.pid) == recipient.birth else { return pass }
      event.postToPid(recipient.pid)
      return nil
    }
  }

  fileprivate final class TapContext {
    weak var state: State?
    let stream: FocusProcess
    init(state: State, stream: FocusProcess) { self.state = state; self.stream = stream }
  }

  fileprivate final class Registration {
    let process: FocusProcess
    let port: CFMachPort
    let source: CFRunLoopSource
    let context: TapContext
    init(process: FocusProcess, port: CFMachPort, source: CFRunLoopSource, context: TapContext) {
      self.process = process; self.port = port; self.source = source; self.context = context
    }
    func invalidate(on loop: CFRunLoop) {
      CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port)
      CFRunLoopRemoveSource(loop, source, .commonModes); CFRunLoopSourceInvalidate(source)
      withExtendedLifetime(context) {}
    }
  }

  fileprivate final class AuxiliaryRequest: @unchecked Sendable {
    let lock = NSLock()
    let completed = DispatchSemaphore(value: 0)
    let proof: BackgroundIncomingFocusProofPolicy.Proof
    let deadline: UInt64
    var registration: Registration?
    var ready = false
    var committed = false
    var retired = false
    init(proof: BackgroundIncomingFocusProofPolicy.Proof, deadline: UInt64) { self.proof = proof; self.deadline = deadline }
  }

  final class AuxiliaryPreparation: @unchecked Sendable {
    private let request: AuxiliaryRequest
    private let state: State
    fileprivate init(request: AuxiliaryRequest, state: State) { self.request = request; self.state = state }
    // Native owner calls this while holding its focus admission lock after
    // rechecking root, generation, retained foreground and the exact subject.
    func commit() -> Bool {
      request.lock.lock(); defer { request.lock.unlock() }
      guard !request.retired, !request.committed, request.ready, DispatchTime.now().uptimeNanoseconds < request.deadline else { return false }
      state.lock.lock(); defer { state.lock.unlock() }
      guard !state.stopping, !state.failed, state.processes.first == request.proof.root,
        state.processes.contains(request.proof.rawSubject),
        request.proof.admits(root: request.proof.root, generation: request.proof.generation, isLive: { state.identity($0.pid) == $0.birth }),
        state.taps.count == state.processes.count,
        state.taps.allSatisfy({ CFMachPortIsValid($0) && CGEvent.tapIsEnabled(tap: $0) }),
        DispatchTime.now().uptimeNanoseconds < request.deadline else { return false }
      request.committed = true
      return true
    }
    func cancel() { GlideKeyRescueGuard.retire(request, state: state) }
    deinit {
      request.lock.lock(); let committed = request.committed; request.lock.unlock()
      if !committed { cancel() }
    }
  }

  private let state: State
  private let thread: Thread

  init(processes: [FocusProcess], auxiliary: FocusProcess? = nil, identity: @escaping @Sendable (Int32) -> ProcessIdentity?) throws {
    // A third stream is suppression/recovery-only and must be supplied by the
    // native owner's separate root-linked auxiliary preproof. It never enters
    // the root+hosted agent-input recipient set.
    guard !processes.isEmpty, processes.count <= 2 || (processes.count == 3 && processes.last == auxiliary),
          Set(processes.map(\.pid)).count == processes.count,
          processes.allSatisfy({ $0.pid > 0 && identity($0.pid) == $0.birth }) else { throw Refusal.processChanged }
    let state = State(processes: processes, identity: identity)
    self.state = state
    thread = Thread { Self.run(state) }
    thread.name = "cafe-glide-background-key-recovery"
    thread.qualityOfService = .userInitiated
    thread.start()
    guard state.started.wait(timeout: .now() + 2) == .success else { stop(); throw Refusal.unavailable }
    do { try validate() }
    catch { stop(); throw error }
  }

  deinit { stop() }

  // Installs only the exact already-proven raw subject. It uses the existing
  // keyboard tap run loop and the caller's original absolute deadline. A late
  // native creation is invalidated before it can enter the admitted stream set.
  func prepareAuxiliary(proof: BackgroundIncomingFocusProofPolicy.Proof, before deadline: UInt64) -> AuxiliaryPreparation? {
    // Bind the immutable owner before either closure captures it. A later local
    // binding shadows the stored property throughout this method in Swift.
    let state = self.state
    guard DispatchTime.now().uptimeNanoseconds < deadline else { return nil }
    let request = AuxiliaryRequest(proof: proof, deadline: deadline)
    state.lock.lock()
    guard !state.stopping, !state.failed, state.processes.first == proof.root,
      proof.admits(root: proof.root, generation: proof.generation, isLive: { state.identity($0.pid) == $0.birth }),
      let loop = state.runLoop else { state.lock.unlock(); return nil }
    if state.processes.contains(proof.rawSubject) {
      request.ready = state.taps.count == state.processes.count && state.taps.allSatisfy { CFMachPortIsValid($0) && CGEvent.tapIsEnabled(tap: $0) }
      state.lock.unlock()
      return request.ready ? AuxiliaryPreparation(request: request, state: state) : nil
    }
    guard state.processes.count < 3 else { state.lock.unlock(); return nil }
    state.lock.unlock()
    CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) {
      defer { request.completed.signal() }
      request.lock.lock()
      let active = !request.retired && DispatchTime.now().uptimeNanoseconds < deadline
      request.lock.unlock()
      guard active else { return }
      guard let registration = Self.registration(process: proof.rawSubject, state: state) else { return }
      let identitiesLive = proof.admits(root: proof.root, generation: proof.generation, isLive: { state.identity($0.pid) == $0.birth })
      CFRunLoopAddSource(loop, registration.source, .commonModes)
      request.lock.lock()
      guard !request.retired, DispatchTime.now().uptimeNanoseconds < deadline else { request.lock.unlock(); registration.invalidate(on: loop); return }
      state.lock.lock()
      guard !state.stopping, !state.failed, state.processes.first == proof.root, state.processes.count < 3,
        !state.processes.contains(where: { $0.pid == proof.rawSubject.pid }),
        identitiesLive, DispatchTime.now().uptimeNanoseconds < deadline else {
        state.lock.unlock(); request.lock.unlock(); registration.invalidate(on: loop); return
      }
      state.processes.append(proof.rawSubject); state.taps.append(registration.port); state.additions.append(registration)
      request.registration = registration; request.ready = true
      state.lock.unlock(); request.lock.unlock()
    }
    CFRunLoopWakeUp(loop)
    guard request.completed.wait(timeout: DispatchTime(uptimeNanoseconds: deadline)) == .success else { Self.retire(request, state: state); return nil }
    request.lock.lock()
    let ready = request.ready && !request.retired && DispatchTime.now().uptimeNanoseconds < deadline
    request.lock.unlock()
    guard ready else { Self.retire(request, state: state); return nil }
    return AuxiliaryPreparation(request: request, state: state)
  }

  private static func retire(_ request: AuxiliaryRequest, state: State) {
    request.lock.lock()
    request.retired = true; request.ready = false
    let registration = request.registration
    request.registration = nil
    if let registration {
      state.lock.lock()
      state.processes.removeAll { $0 == registration.process }
      state.taps.removeAll { CFEqual($0, registration.port) }
      state.additions.removeAll { $0 === registration }
      let loop = state.runLoop
      state.lock.unlock()
      if let loop {
        CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { registration.invalidate(on: loop) }
        CFRunLoopWakeUp(loop)
      } else {
        CGEvent.tapEnable(tap: registration.port, enable: false); CFMachPortInvalidate(registration.port)
        CFRunLoopSourceInvalidate(registration.source)
        withExtendedLifetime(registration.context) {}
      }
    }
    request.lock.unlock()
  }

  private static func registration(process: FocusProcess, state: State) -> Registration? {
    let context = TapContext(state: state, stream: process)
    let mask = [CGEventType.keyDown, .keyUp, .flagsChanged].reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
    guard let port = CGEvent.tapCreateForPid(pid: process.pid, place: .tailAppendEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
      guard let pointer else { return Unmanaged.passUnretained(event) }
      let context = Unmanaged<TapContext>.fromOpaque(pointer).takeUnretainedValue()
      guard let state = context.state else { return Unmanaged.passUnretained(event) }
      return state.handle(stream: context.stream, type: type, event: event)
    }, userInfo: Unmanaged.passUnretained(context).toOpaque()) else { return nil }
    guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { CFMachPortInvalidate(port); return nil }
    return Registration(process: process, port: port, source: source, context: context)
  }

  func admit(subject: FocusProcess, target: FocusProcess, retainedForeground: FocusProcess) -> Bool {
    state.lock.lock(); defer { state.lock.unlock() }
    guard !state.stopping, !state.failed, state.processes.contains(subject),
          state.taps.count == state.processes.count,
          state.taps.allSatisfy({ CFMachPortIsValid($0) && CGEvent.tapIsEnabled(tap: $0) }) else { state.policy.retire(); return false }
    return state.policy.admit(subject: subject, target: target, retainedForeground: retainedForeground) { state.identity($0.pid) == $0.birth }
  }

  func observeFocus(kind: UInt16, subject: FocusProcess?) {
    state.lock.lock(); defer { state.lock.unlock() }
    state.policy.observeFocus(kind: kind, subject: subject) { state.identity($0.pid) == $0.birth }
  }

  func retirePending() { state.lock.lock(); state.policy.retire(); state.lock.unlock() }

  // The native owner holds its focus/admission lock across this transfer and
  // publication. Snapshot old then lock new, so callbacks never acquire two
  // guard locks or invert the native owner's focus lock ordering.
  func inheritPending(from previous: GlideKeyRescueGuard) {
    guard previous !== self else { return }
    previous.state.lock.lock()
    let policy = previous.state.policy
    let previousUsable = !previous.state.failed && !previous.state.stopping
    let previousRoot = previous.state.processes.first
    previous.state.lock.unlock()
    state.lock.lock(); defer { state.lock.unlock() }
    guard previousUsable, !state.stopping, !state.failed,
          previousRoot == state.processes.first,
          state.policy.inheritPending(from: policy, permittedSubjects: state.processes, isLive: { state.identity($0.pid) == $0.birth }) else {
      state.policy.retire(); state.failed = true; return
    }
  }

  func validate() throws {
    state.lock.lock()
    let retired = state.stopping
    let failed = state.failed
    let taps = state.taps
    let processes = state.processes
    state.lock.unlock()
    guard !retired else { throw Refusal.retired }
    guard !failed, taps.count == processes.count,
          taps.allSatisfy({ CFMachPortIsValid($0) && CGEvent.tapIsEnabled(tap: $0) }) else { throw Refusal.unavailable }
    guard processes.allSatisfy({ state.identity($0.pid) == $0.birth }) else { throw Refusal.processChanged }
  }

  func stop() {
    state.lock.lock()
    let alreadyStopping = state.stopping
    state.stopping = true; state.policy.retire()
    let loop = state.runLoop
    state.lock.unlock()
    if let loop {
      CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { CFRunLoopStop(loop) }
      CFRunLoopWakeUp(loop)
    }
    if !alreadyStopping, Thread.current !== thread { _ = state.finished.wait(timeout: .now() + 2) }
  }

  private static func run(_ state: State) {
    let loop = CFRunLoopGetCurrent()!
    var ports = [CFMachPort]()
    var sources = [CFRunLoopSource]()
    var contexts = [TapContext]()
    defer {
      state.lock.lock()
      let additions = state.additions
      state.additions.removeAll(); state.runLoop = nil
      state.lock.unlock()
      for addition in additions { addition.invalidate(on: loop) }
      for port in ports { CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port) }
      for source in sources { CFRunLoopRemoveSource(loop, source, .commonModes); CFRunLoopSourceInvalidate(source) }
      withExtendedLifetime(contexts) {}
      state.lock.lock()
      state.taps.removeAll(); state.runLoop = nil; state.policy.retire()
      state.lock.unlock()
      state.finished.signal()
    }
    let mask = [CGEventType.keyDown, .keyUp, .flagsChanged].reduce(CGEventMask(0)) { $0 | CGEventMask(1) << $1.rawValue }
    for process in state.processes {
      let context = TapContext(state: state, stream: process)
      contexts.append(context)
      guard let port = CGEvent.tapCreateForPid(pid: process.pid, place: .tailAppendEventTap, options: .defaultTap, eventsOfInterest: mask, callback: { _, type, event, pointer in
        guard let pointer else { return Unmanaged.passUnretained(event) }
        let context = Unmanaged<TapContext>.fromOpaque(pointer).takeUnretainedValue()
        guard let state = context.state else { return Unmanaged.passUnretained(event) }
        return state.handle(stream: context.stream, type: type, event: event)
      }, userInfo: Unmanaged.passUnretained(context).toOpaque()) else {
        state.lock.lock(); state.failed = true; state.policy.retire(); state.lock.unlock()
        state.started.signal(); return
      }
      ports.append(port)
      guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else {
        state.lock.lock(); state.failed = true; state.policy.retire(); state.lock.unlock()
        state.started.signal(); return
      }
      sources.append(source)
      CFRunLoopAddSource(loop, source, .commonModes)
    }
    state.lock.lock()
    state.runLoop = loop; state.taps = ports
    let shouldRun = !state.stopping
    state.lock.unlock()
    guard shouldRun else { state.started.signal(); return }
    CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) {
      state.started.signal()
      state.lock.lock(); let stopping = state.stopping; state.lock.unlock()
      if stopping { CFRunLoopStop(loop) }
    }
    CFRunLoopRun()
  }
}
