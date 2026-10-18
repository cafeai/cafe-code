// Native PID-tap transport qualification between exact test-owned processes.
// No windows, global HID posts, real foreground recipients or key text exist.
import AppKit
import ApplicationServices
import Darwin

private func identity(_ pid: Int32) -> ProcessIdentity? {
  var info = proc_bsdinfo()
  let size = Int32(MemoryLayout<proc_bsdinfo>.size)
  guard pid > 0, proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
    info.pbi_pid == UInt32(pid), info.pbi_uid == getuid(), info.pbi_start_tvsec > 0 else { return nil }
  return ProcessIdentity(seconds: info.pbi_start_tvsec, microseconds: info.pbi_start_tvusec)
}
private func process(_ offset: Int) -> FocusProcess? {
  guard CommandLine.arguments.count > offset + 2, let pid = Int32(CommandLine.arguments[offset]),
    let seconds = UInt64(CommandLine.arguments[offset + 1]), let microseconds = UInt64(CommandLine.arguments[offset + 2]) else { return nil }
  let birth = ProcessIdentity(seconds: seconds, microseconds: microseconds)
  guard identity(pid) == birth else { return nil }
  return FocusProcess(pid: pid, birth: birth)
}
private func emit(_ kind: String, extras: [String: Any] = [:]) {
  guard let own = identity(getpid()), let foreground = NSWorkspace.shared.frontmostApplication,
    let frontBirth = identity(foreground.processIdentifier) else { exit(1) }
  let pointer = NSEvent.mouseLocation
  var value: [String: Any] = [
    "kind": kind, "pid": getpid(), "birth": ["seconds": own.seconds, "microseconds": own.microseconds],
    "foreground": ["pid": foreground.processIdentifier, "birth": ["seconds": frontBirth.seconds, "microseconds": frontBirth.microseconds]],
    "pointer": ["x": pointer.x, "y": pointer.y],
  ]
  for (key, value_) in extras { value[key] = value_ }
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { exit(1) }
  do { try FileHandle.standardOutput.write(contentsOf: data + Data([10])) } catch { exit(0) }
}
private func post(_ target: FocusProcess, marker: Int64) -> Bool {
  guard identity(target.pid) == target.birth,
    let event = CGEvent(keyboardEventSource: nil, virtualKey: 56, keyDown: false) else { return false }
  event.type = .flagsChanged; event.flags = []
  event.setIntegerValueField(.eventSourceUserData, value: marker)
  event.postToPid(target.pid)
  return true
}

private final class Driver: NSObject, NSApplicationDelegate {
  let mode: String
  var guard_: GlideKeyRescueGuard?
  var target: FocusProcess?
  var receiver: FocusProcess?
  var tap: CFMachPort?
  var source: CFRunLoopSource?
  var markerCount = 0
  init(mode: String) { self.mode = mode }
  func applicationDidFinishLaunching(_ notification: Notification) {
    if mode == "--controller" {
      guard let target = process(2), let receiver = process(5), target.pid != receiver.pid else { exit(1) }
      self.target = target; self.receiver = receiver
      do { guard_ = try GlideKeyRescueGuard(processes: [target], identity: { identity($0) }) }
      catch { emit("failure", extras: ["reason": "native rescue guard unavailable"]); exit(1) }
    }
    emit("ready")
    DispatchQueue.global().async {
      var pending = Data()
      var buffer = [UInt8](repeating: 0, count: 4096)
      while true {
        let count = Darwin.read(STDIN_FILENO, &buffer, buffer.count)
        if count < 0 && errno == EINTR { continue }
        guard count > 0 else { break }
        pending.append(contentsOf: buffer.prefix(count))
        guard pending.count <= 16_384 else { exit(1) }
        while let end = pending.firstIndex(of: 10) {
          let line = pending.prefix(upTo: end)
          pending.removeSubrange(...end)
          guard let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { exit(1) }
          DispatchQueue.main.async { self.handle(command) }
        }
      }
      DispatchQueue.main.async { self.guard_?.stop(); NSApplication.shared.terminate(nil) }
    }
  }
  func handle(_ command: [String: Any]) {
    guard let operation = command["op"] as? String else { exit(1) }
    switch operation {
    case "observe":
      guard mode == "--peer", tap == nil else { exit(1) }
      let thread = Thread { self.observe() }
      thread.name = "cafe-owned-key-transport-observer"; thread.start()
    case "arm":
      guard mode == "--controller", let target, let receiver,
        guard_?.admit(subject: target, target: receiver, retainedForeground: receiver) == true else { exit(1) }
      emit("armed")
    case "post-own":
      guard mode == "--controller", let target, let marker = (command["marker"] as? NSNumber)?.int64Value,
        post(target, marker: marker) else { exit(1) }
      emit("posted")
    case "retire": guard_?.retirePending(); emit("retired")
    default: exit(1)
    }
  }
  func observe() {
      guard let port = CGEvent.tapCreateForPid(pid: getpid(), place: .tailAppendEventTap, options: .listenOnly,
        eventsOfInterest: CGEventMask(1) << CGEventType.flagsChanged.rawValue, callback: { _, _, event, context in
          guard let context else { return Unmanaged.passUnretained(event) }
          let driver = Unmanaged<Driver>.fromOpaque(context).takeUnretainedValue()
          driver.markerCount += 1
          guard driver.markerCount <= 16 else { exit(1) }
          emit("event", extras: ["marker": event.getIntegerValueField(.eventSourceUserData), "target": event.getIntegerValueField(.eventTargetUnixProcessID)])
          return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()), let source = CFMachPortCreateRunLoopSource(nil, port, 0) else { emit("failure", extras: ["reason": "native peer observer unavailable"]); exit(1) }
      tap = port; self.source = source
      let loop = CFRunLoopGetCurrent()!
      CFRunLoopAddSource(loop, source, .commonModes)
      CFRunLoopPerformBlock(loop, CFRunLoopMode.commonModes.rawValue) { emit("observing") }
      CFRunLoopRun()
      CGEvent.tapEnable(tap: port, enable: false); CFMachPortInvalidate(port)
      CFRunLoopRemoveSource(loop, source, .commonModes)
  }
}

@main
struct QualificationMain {
  static func main() {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    guard CommandLine.arguments.count > 1 else { exit(1) }
    let mode = CommandLine.arguments[1]
    if mode == "--post" {
      guard let target = process(2), CommandLine.arguments.count == 6, let marker = Int64(CommandLine.arguments[5]), post(target, marker: marker) else { exit(1) }
      emit("posted"); return
    }
    guard mode == "--peer" || mode == "--controller" else { exit(1) }
    let driver = Driver(mode: mode)
    application.delegate = driver
    application.run()
  }
}
