// Pure value-policy runner: no AppKit, taps, process calls, or native input.
private struct RescueQualificationFailure: Error { let message: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw RescueQualificationFailure(message: message) }
}

@main
struct KeyRescuePolicyQualification {
  static let thief = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 10, microseconds: 1))
  static let foreground = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 20, microseconds: 2))
  static let unrelated = FocusProcess(pid: 303, birth: ProcessIdentity(seconds: 30, microseconds: 3))
  static let replacement = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 40, microseconds: 4))
  static let foregroundReplacement = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 50, microseconds: 5))
  static func live(_ process: FocusProcess) -> Bool { [thief, foreground, unrelated].contains(process) }
  static func admit(_ policy: inout BackgroundKeyRescuePolicy) -> Bool {
    policy.admit(subject: thief, target: foreground, retainedForeground: foreground, isLive: live)
  }
  static func rescue(_ policy: BackgroundKeyRescuePolicy) -> FocusProcess? {
    policy.recipient(sourcePID: 909, helperPID: 404, eventTarget: thief, isLive: live)
  }

  static func main() throws {
    var policy = BackgroundKeyRescuePolicy()
    try require(rescue(policy) == nil, "Unpaired key event minted foreground routing authority.")
    try require(admit(&policy), "Admitted exact foreground pair was refused.")
    try require(rescue(policy) == foreground, "Foreign key was not rescued to its original foreground generation.")
    try require(policy.recipient(sourcePID: 404, helperPID: 404, eventTarget: thief, isLive: live) == nil, "Agent input was redirected into the user's foreground application.")
    try require(policy.recipient(sourcePID: 909, helperPID: 0, eventTarget: thief, isLive: live) == nil, "Unknown helper identity acquired rescue authority.")
    for target in [nil, unrelated, replacement, foreground] {
      try require(policy.recipient(sourcePID: 909, helperPID: 404, eventTarget: target, isLive: { _ in true }) == nil, "Unrelated, unknown or replaced event target matched pending rescue.")
    }
    for dead in [thief, foreground] {
      try require(policy.recipient(sourcePID: 909, helperPID: 404, eventTarget: thief, isLive: { $0 != dead }) == nil, "Key rescue used a dead process generation.")
    }

    // Cancelling agent dispatch is intentionally independent of the rescue
    // tuple. The first foreign key and its later up/modifier events retain the
    // exact original recipient until a real focus/lifecycle transition retires.
    var dispatch = BackgroundActivityPolicy()
    let admittedGeneration = dispatch.generation
    try require(dispatch.observe(sourcePID: 909, helperPID: 404), "Foreign input did not revoke agent dispatch.")
    try require(dispatch.generation != admittedGeneration, "Old agent generation survived takeover.")
    for _ in 0..<3 { try require(rescue(policy) == foreground, "Agent cancellation erased a pending human key rescue.") }
    try require(admit(&policy), "Duplicate exact Taken damaged the original pending tuple.")
    try require(rescue(policy) == foreground, "Duplicate Taken changed the original foreground recipient.")

    // Returned and Changed-to-thief belong to the same pending transition.
    policy.observeFocus(kind: 0x8000, subject: foreground, isLive: live)
    policy.observeFocus(kind: 0xf102, subject: thief, isLive: live)
    policy.observeFocus(kind: 2, subject: unrelated, isLive: live)
    policy.observeFocus(kind: 0xf102, subject: nil, isLive: live)
    policy.observeFocus(kind: 0xf102, subject: foregroundReplacement, isLive: live)
    try require(rescue(policy) == foreground, "Unpaired or unresolved notification replaced the pending tuple.")
    policy.observeFocus(kind: 0xf102, subject: foreground, isLive: live)
    try require(rescue(policy) == nil, "Actual foreground restoration retained old key rerouting.")

    for restored in [foreground, unrelated] {
      try require(admit(&policy), "New exact attempt was refused after restoration.")
      policy.observeFocus(kind: 0xf102, subject: restored, isLive: live)
      try require(rescue(policy) == nil, "A live focus change away from the thief retained rescue authority.")
    }
    for front in [thief, foreground] {
      try require(admit(&policy), "New exact attempt was refused before NewFront.")
      policy.observeFocus(kind: 2, subject: front, isLive: live)
      try require(rescue(policy) == nil, "Matching NewFront retained an old pending attempt.")
    }

    // A second raw thief, replaced birth, or target other than the retained
    // foreground must retire rather than build a recursive rescue chain.
    try require(admit(&policy), "Exact attempt failed before collision check.")
    try require(!policy.admit(subject: unrelated, target: foreground, retainedForeground: foreground, isLive: live), "An incompatible second thief overwrote the first pending tuple.")
    try require(rescue(policy) == nil, "Incompatible admission retained the first tuple.")
    try require(admit(&policy), "Exact attempt failed before recursive-target check.")
    try require(!policy.admit(subject: unrelated, target: thief, retainedForeground: foreground, isLive: live), "A transient thief became a new foreground rescue destination.")
    try require(rescue(policy) == nil, "Recursive-target refusal retained old rescue authority.")
    try require(admit(&policy), "Exact attempt failed before replacement check.")
    try require(!policy.admit(subject: replacement, target: foreground, retainedForeground: foreground, isLive: live), "A dead replacement process acquired rescue authority.")
    try require(rescue(policy) == nil, "Failed replacement admission retained old rescue authority.")
    try require(!policy.admit(subject: thief, target: foregroundReplacement, retainedForeground: foreground, isLive: { _ in true }), "A reused foreground PID matched the retained generation.")
    try require(!policy.admit(subject: thief, target: thief, retainedForeground: thief, isLive: live), "A subject became its own rescue destination.")
    try require(!policy.admit(subject: thief, target: replacement, retainedForeground: replacement, isLive: { _ in true }), "Different generations of the same PID became simultaneous rescue endpoints.")

    try require(admit(&policy), "Exact attempt failed before hosted guard handoff.")
    var hostedGuardPolicy = BackgroundKeyRescuePolicy()
    try require(hostedGuardPolicy.inheritPending(from: policy, permittedSubjects: [thief, unrelated], isLive: live), "Root-to-hosted guard handoff rejected the exact pending attempt.")
    policy.retire()
    try require(rescue(hostedGuardPolicy) == foreground, "Retiring the old guard erased the new guard's retained foreground tuple.")
    try require(!policy.inheritPending(from: hostedGuardPolicy, permittedSubjects: [replacement, unrelated], isLive: { _ in true }), "Replacement root process acquired inherited key rescue authority.")
    try require(rescue(policy) == nil, "Rejected replacement handoff retained pending authority.")
    try require(!policy.inheritPending(from: hostedGuardPolicy, permittedSubjects: [thief], isLive: { $0 != foreground }), "Handoff retained a dead original foreground.")
    try require(rescue(policy) == nil, "Dead-foreground handoff retained a pending destination.")
    let empty = BackgroundKeyRescuePolicy()
    try require(hostedGuardPolicy.inheritPending(from: empty, permittedSubjects: [thief], isLive: live), "Empty old guard handoff was not inert.")
    try require(rescue(hostedGuardPolicy) == nil, "Empty handoff retained a previously pending tuple.")

    try require(admit(&policy), "Exact attempt failed before lifecycle cleanup.")
    policy.retire()
    try require(rescue(policy) == nil, "Connection/reset cleanup retained rescue authority.")
    try require(admit(&policy), "Exact attempt failed before death notification.")
    policy.observeFocus(kind: 0xf102, subject: thief, isLive: { $0 != foreground })
    try require(rescue(policy) == nil, "A dead endpoint notification retained a stale tuple.")
    print("glide-key-rescue-policy-qualified")
  }
}
