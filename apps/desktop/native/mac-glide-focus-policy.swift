// Pure admission policy for the narrow root-AppKit background focus guard.
// Native event transport resolves process generations and supplies isLive;
// this policy never queries the OS or sends/releases an event itself.
import Foundation
import CoreFoundation

// A missing/uncertain display inventory cannot authorize background input.
// The native query is read-only; this policy owns its bounded canonical shape
// and the exact active-Space tuple retained by one operation.
struct BackgroundDesktopPolicy {
  private var expected: [String: UInt64]?
  var isArmed: Bool { expected != nil }

  static func snapshot(_ displays: [[String: Any]]?) -> [String: UInt64]? {
    guard let displays, !displays.isEmpty, displays.count <= 16 else { return nil }
    var result: [String: UInt64] = [:]
    for display in displays {
      guard let name = display["Display Identifier"] as? String, !name.isEmpty,
        name.utf8.count <= 256, result[name] == nil,
        let id = (display["Current Space"] as? [String: Any])?["id64"] as? NSNumber,
        CFGetTypeID(id) != CFBooleanGetTypeID(), id.doubleValue.isFinite,
        id.compare(NSNumber(value: 0)) == .orderedDescending,
        id.compare(NSNumber(value: UInt64.max)) != .orderedDescending else { return nil }
      let value = id.uint64Value
      guard value > 0, id.compare(NSNumber(value: value)) == .orderedSame else { return nil }
      result[name] = value
    }
    return result
  }

  mutating func arm(_ sample: [[String: Any]]?) -> Bool {
    expected = Self.snapshot(sample)
    return isArmed
  }
  func admits(_ sample: [[String: Any]]?) -> Bool {
    guard let expected, let actual = Self.snapshot(sample) else { return false }
    return actual == expected
  }
  mutating func disarm() { expected = nil }
}

struct ProcessIdentity: Equatable, Hashable, Sendable {
  let seconds: UInt64
  let microseconds: UInt64
}

struct FocusProcess: Equatable, Hashable, Sendable {
  let pid: Int32
  let birth: ProcessIdentity
}

// Activity is observed without reading key contents. A cell/action can retain
// its admitted generation and refuse subsequent dispatch after foreign input.
struct BackgroundActivityPolicy {
  struct Interruption: Sendable {
    let event: String
    let sourcePID: Int64
    var result: [String: Any] {
      let attributable = sourcePID > 0 && sourcePID <= Int64(Int32.max)
      var value: [String: Any] = ["event": event, "source": attributable ? "external-process" : "unattributed"]
      if attributable { value["sourcePid"] = sourcePID }
      return value
    }
  }
  private(set) var generation: UInt64 = 0
  private(set) var interruption: Interruption?
  var exhausted: Bool { generation == UInt64.max }

  mutating func beginAdmission() -> UInt64 {
    interruption = nil
    return generation
  }

  mutating func observe(sourcePID: Int64, helperPID: Int32, event: String = "key-down") -> Bool {
    guard sourcePID != Int64(helperPID) else { return false }
    if interruption == nil { interruption = Interruption(event: event, sourcePID: sourcePID) }
    if !exhausted { generation += 1 }
    return true
  }
}

struct BackgroundFocusPolicy {
  enum Decision: Equatable {
    case pass
    case suppress
    case release(UInt32)
    case invalidToken
  }

  private struct Pending {
    let subject: FocusProcess
    let target: FocusProcess
    var returned = false
    var changed = false
  }

  private var armed: FocusProcess?
  private var acceptsTaken = false
  private var current: FocusProcess?
  private var pending: Pending?

  mutating func arm(_ subject: FocusProcess, current: FocusProcess) {
    armed = subject
    acceptsTaken = true
    self.current = current
    pending = nil
  }

  mutating func disarm() {
    armed = nil
    acceptsTaken = false
    pending = nil
  }
  // Outside input retires future agent work, but the exact theft already
  // suppressed must still release its one pending OS token and Return pair.
  mutating func revokeFutureAdmission() { acceptsTaken = false }

  mutating func observe(kind: UInt16, subject: FocusProcess?, target: FocusProcess?, token: Int64, isLive: (FocusProcess) -> Bool) -> Decision {
    switch kind {
    case 0x4000: // KeyFocusTaken: admit only the armed subject/recipient pair.
      guard acceptsTaken, let subject, let target, armed == subject, subject != current,
            isLive(subject), isLive(target) else { return .pass }
      // Repeated Taken observations cannot replenish the one-use release or
      // returned flags for this exact pending pair during the same operation.
      if pending?.subject != subject || pending?.target != target {
        pending = Pending(subject: subject, target: target)
      }
      return .suppress

    case 0x8000: // Return suppression belongs to that exact recipient generation.
      guard var value = pending, !value.returned, armed == value.subject,
            target == value.target, isLive(value.subject), isLive(value.target) else { return .pass }
      value.returned = true
      pending = value
      return .suppress

    case 0xf102: // Changed updates observed focus even for unrelated processes.
      current = subject
      // A live change away from an already handled subject ends that attempt.
      // A later Taken can then admit another real theft within this operation,
      // without inheriting the first attempt's returned/changed flags. Unknown
      // or dead generations cannot replenish one-use release authority.
      if let subject, let value = pending, value.changed || !acceptsTaken,
         subject != value.subject, isLive(subject) {
        pending = nil
      }
      guard var value = pending, !value.changed, armed == value.subject,
            subject == value.subject, isLive(value.subject), isLive(value.target) else { return .pass }
      // Consume the attempt before token validation. Invalid metadata must not
      // permit a later event to mint a release for the same observed change.
      value.changed = true
      pending = value
      guard token > 0, token <= Int64(UInt32.max) else { return .invalidToken }
      return .release(UInt32(token))

    case 2: // NewFront retires only a matching pending subject; never suppress.
      if let subject, pending?.subject == subject { pending = nil }
      return .pass

    default:
      return .pass
    }
  }
}
