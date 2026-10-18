// Human input recovery is separate from agent dispatch admission. A foreign
// key cancels future agent input, but its original event may already name the
// transient background thief. Preserve only that admitted attempt's original
// foreground recipient until actual focus restoration or lifecycle cleanup.
struct BackgroundKeyRescuePolicy {
  private struct Pending: Equatable {
    let subject: FocusProcess
    let target: FocusProcess
  }

  private var pending: Pending?

  // Call only after the focus policy admits/suppresses this Taken notification.
  // The WindowServer target must also equal the operation's independently
  // retained actual foreground generation. There is no recursive rescue chain.
  mutating func admit(subject: FocusProcess, target: FocusProcess, retainedForeground: FocusProcess, isLive: (FocusProcess) -> Bool) -> Bool {
    guard subject.pid > 0, target.pid > 0, subject.pid != target.pid,
          target == retainedForeground, isLive(subject), isLive(target) else {
      retire()
      return false
    }
    let value = Pending(subject: subject, target: target)
    if let pending, pending != value {
      retire()
      return false
    }
    pending = value
    return true
  }

  mutating func observeFocus(kind: UInt16, subject: FocusProcess?, isLive: (FocusProcess) -> Bool) {
    guard let pending else { return }
    guard isLive(pending.subject), isLive(pending.target) else { retire(); return }
    guard let subject, isLive(subject) else { return }
    switch kind {
    case 0xf102: // A live Changed away from the thief ends this attempt.
      if subject != pending.subject { retire() }
    case 2: // Matching NewFront consumes the old pending focus transition.
      if subject == pending.subject || subject == pending.target { retire() }
    default:
      break
    }
  }

  mutating func retire() { pending = nil }

  // Root-only protection may be replaced after the same admitted operation
  // discovers a hosted recipient. Transfer the existing attempt without
  // minting a new target or losing the original foreground generation.
  mutating func inheritPending(from previous: BackgroundKeyRescuePolicy, permittedSubjects: [FocusProcess], isLive: (FocusProcess) -> Bool) -> Bool {
    guard let value = previous.pending else { retire(); return true }
    guard permittedSubjects.contains(value.subject), isLive(value.subject), isLive(value.target) else { retire(); return false }
    pending = value
    return true
  }

  // Native transport invokes this only for the PID-scoped keyDown/keyUp/
  // flagsChanged tap. It reposts to a returned recipient and drops the original
  // event. No text, keycode, flags or other keyboard payload is inspected here.
  func recipient(sourcePID: Int64, helperPID: Int32, eventTarget: FocusProcess?, isLive: (FocusProcess) -> Bool) -> FocusProcess? {
    guard helperPID > 0, sourcePID != Int64(helperPID), let pending,
          eventTarget == pending.subject, isLive(pending.subject), isLive(pending.target) else { return nil }
    return pending.target
  }
}
