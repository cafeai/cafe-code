// Value-only qualification. The linked resolver is never invoked, so this
// executable does not enumerate user processes, query AX or install any taps.
private struct IncomingFocusQualificationFailure: Error { let message: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw IncomingFocusQualificationFailure(message: message) }
}

@main
struct IncomingFocusPolicyQualification {
  typealias Policy = BackgroundIncomingFocusProofPolicy
  static let root = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 10, microseconds: 1))
  static let hosted = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 20, microseconds: 2))
  static let auxiliary = FocusProcess(pid: 303, birth: ProcessIdentity(seconds: 30, microseconds: 3))
  static let foreground = FocusProcess(pid: 404, birth: ProcessIdentity(seconds: 40, microseconds: 4))
  static let foreign = FocusProcess(pid: 505, birth: ProcessIdentity(seconds: 50, microseconds: 5))
  static let replacement = FocusProcess(pid: 303, birth: ProcessIdentity(seconds: 60, microseconds: 6))
  static func live(_ process: FocusProcess) -> Bool { [root, hosted, auxiliary, foreground, foreign].contains(process) }

  static func evidence(exactName: Bool = true, currentUser: Bool = true, kind: Policy.ProcessKind = .prohibited, context: Policy.Context = .focusedElement, equalHandles: Bool = true, rootLogicalPID: Int32? = root.pid, auxiliaryLogicalPID: Int32? = root.pid, rootActual: FocusProcess? = hosted, auxiliaryActual: FocusProcess? = hosted) -> Policy.Evidence {
    Policy.Evidence(exactName: exactName, currentUser: currentUser, kind: kind, context: context, equalHandles: equalHandles, rootLogicalPID: rootLogicalPID, auxiliaryLogicalPID: auxiliaryLogicalPID, rootActual: rootActual, auxiliaryActual: auxiliaryActual)
  }
  static func prove(_ evidence: Policy.Evidence, knownRecipient: FocusProcess? = hosted, isLive: (FocusProcess) -> Bool = live) -> Policy.Proof? {
    Policy.prove(root: root, rawSubject: auxiliary, knownRecipient: knownRecipient, generation: 7, evidence: evidence, isLive: isLive)
  }
  static func main() throws {
    guard let proof = prove(evidence()) else { throw IncomingFocusQualificationFailure(message: "Exact root-linked auxiliary evidence was refused.") }
    try require(proof.root == root && proof.rawSubject == auxiliary && proof.recipient == hosted && proof.generation == 7, "Preproof lost exact root/subject/recipient/generation ownership.")
    for kind in [Policy.ProcessKind.prohibited, .unrepresented] {
      for context in [Policy.Context.focusedElement, .focusedWindow, .mainWindow] {
        try require(prove(evidence(kind: kind, context: context)) != nil, "A qualified nonregular AX context was refused.")
      }
    }
    for invalid in [
      evidence(exactName: false), evidence(currentUser: false), evidence(kind: .regular), evidence(equalHandles: false),
      evidence(rootLogicalPID: nil), evidence(rootLogicalPID: foreign.pid), evidence(auxiliaryLogicalPID: nil), evidence(auxiliaryLogicalPID: foreign.pid),
      evidence(rootActual: nil), evidence(auxiliaryActual: nil), evidence(rootActual: foreign), evidence(auxiliaryActual: foreign),
      evidence(rootActual: foreign, auxiliaryActual: foreign), evidence(rootActual: replacement, auxiliaryActual: replacement),
    ] {
      try require(prove(invalid) == nil, "Incomplete, unrelated or replaced AX evidence minted auxiliary authority.")
    }
    try require(prove(evidence(), knownRecipient: nil) == nil, "Unknown hosted recipient was admitted through auxiliary proof.")
    try require(prove(evidence(rootActual: root, auxiliaryActual: root), knownRecipient: nil)?.recipient == nil, "Root-only auxiliary proof invented a hosted input recipient.")
    try require(prove(evidence(rootActual: auxiliary, auxiliaryActual: auxiliary), knownRecipient: nil)?.recipient == auxiliary, "Exact raw auxiliary AX identity was lost.")
    for dead in [root, auxiliary, hosted] {
      try require(prove(evidence(), isLive: { live($0) && $0 != dead }) == nil, "Dead preproof endpoint was admitted.")
      try require(!proof.admits(root: root, generation: 7, isLive: { live($0) && $0 != dead }), "Preproof outlived an endpoint generation.")
    }
    try require(proof.admits(root: root, generation: 7, isLive: live), "Exact live preproof did not admit its generation.")
    try require(!proof.admits(root: foreign, generation: 7, isLive: live), "Preproof migrated to a foreign approved root.")
    try require(!proof.admits(root: root, generation: 8, isLive: live), "Preproof outlived agent activity revocation.")
    try require(Policy.unique([]).isEmpty, "Empty discovery minted auxiliary proof.")
    try require(Policy.unique([proof, proof]) == [proof], "Duplicate exact contexts expanded auxiliary scope.")
    let other = Policy.prove(root: root, rawSubject: foreign, knownRecipient: hosted, generation: 7, evidence: evidence(), isLive: live)!
    try require(Policy.unique([proof, other]).isEmpty, "Ambiguous auxiliaries enlarged the fixed tap scope.")
    let changedGeneration = Policy.prove(root: root, rawSubject: auxiliary, knownRecipient: hosted, generation: 8, evidence: evidence(), isLive: live)!
    try require(Policy.unique([proof, changedGeneration]).isEmpty, "Discovery combined different activity generations.")

    let generic = Policy.prove(root: root, rawSubject: auxiliary, knownRecipient: hosted, generation: 7, evidence: evidence(exactName: false), requiresExactName: false, isLive: live)
    try require(generic != nil && generic?.specialAuxiliary == false, "Exact event-subject AX proof required a process-name fallback or acquired special ViewBridge flags.")
    try require(Policy.prove(root: root, rawSubject: auxiliary, knownRecipient: nil, generation: 7, evidence: evidence(rootActual: foreign, auxiliaryActual: foreign), requiresExactName: false, derivedRecipient: foreign, isLive: live)?.recipient == foreign, "A new nonregular actual recipient could not be represented as a root-linked proof dependency.")
    try require(Policy.prove(root: root, rawSubject: auxiliary, knownRecipient: nil, generation: 7, evidence: evidence(equalHandles: false, rootActual: foreign, auxiliaryActual: foreign), requiresExactName: false, derivedRecipient: foreign, isLive: live) == nil, "Derived recipient bypassed exact root-linked AX proof.")

    func work() -> BackgroundIncomingFocusWork {
      BackgroundIncomingFocusWork(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 10, deadline: 40_000_010)!
    }
    try require(BackgroundIncomingFocusWork(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 10, deadline: 40_000_011) == nil, "Incoming focus work renewed its maximum allowance.")
    try require(BackgroundIncomingFocusWork(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 10, deadline: 10) == nil, "Expired incoming work was admitted.")
    var timely = work()
    try require(timely.publish(proof, now: 20, isLive: live), "Timely exact proof did not publish.")
    try require(timely.take(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 21, isLive: live) == proof, "Timely exact proof did not complete.")
    try require(timely.take(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 22, isLive: live) == nil, "Incoming proof completion was reusable.")
    try require(!timely.publish(proof, now: 23, isLive: live), "Late producer republished already-consumed proof.")
    for time in [UInt64(40_000_010), UInt64(40_000_011), UInt64.max] {
      var expired = work()
      try require(!expired.publish(proof, now: time, isLive: live), "Deadline-expired resolver published authority.")
      try require(expired.take(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 30, isLive: live) == nil, "Expired work regained authority after a later clock sample.")
    }
    var cancelled = work()
    cancelled.retire()
    try require(!cancelled.publish(proof, now: 20, isLive: live), "Cancelled resolver published late proof.")
    for stale in 0..<4 {
      var value = work()
      _ = value.publish(proof, now: 20, isLive: live)
      try require(value.take(root: stale == 0 ? foreign : root, subject: stale == 1 ? replacement : auxiliary, foreground: stale == 2 ? foreign : foreground, generation: stale == 3 ? 8 : 7, now: 21, isLive: live) == nil, "Stale root/subject/foreground/generation consumed resolver proof.")
      try require(!value.publish(proof, now: 22, isLive: live), "Failed stale completion could publish later.")
    }
    for dead in [root, auxiliary, foreground, hosted] {
      var value = work()
      _ = value.publish(proof, now: 20, isLive: live)
      try require(value.take(root: root, subject: auxiliary, foreground: foreground, generation: 7, now: 21, isLive: { live($0) && $0 != dead }) == nil, "Resolver completion outlived an exact endpoint birth.")
    }

    var policy = BackgroundAuxiliaryFocusPolicy()
    policy.arm(auxiliary, current: foreground)
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Special NewFront suppressed before any successful release.")
    try require(policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .suppress, "Exact auxiliary Taken was not suppressed.")
    try require(policy.observe(kind: 0x8000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .suppress, "Exact paired Returned was not suppressed.")
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 71, isLive: live) == .release(71), "Auxiliary Changed did not request its exact one-use token.")
    policy.noteReleaseResult(token: 72, success: true)
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "A different token minted successful-release authority.")

    for success in [false, true] {
      policy.arm(auxiliary, current: foreground)
      _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
      _ = policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 83, isLive: live)
      policy.noteReleaseResult(token: 83, success: success)
      try require(policy.observe(kind: 2, subject: foreign, target: foreground, token: 0, isLive: live) == .pass, "Special suppression escaped its raw subject.")
      try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == (success ? .suppress : .pass), "Special NewFront ignored actual release success.")
      try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Special NewFront success was reusable.")
    }
    policy.arm(auxiliary, current: foreground, suppressesNewFront: false)
    _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
    _ = policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 88, isLive: live)
    policy.noteReleaseResult(token: 88, success: true)
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Generic prohibited service inherited special ViewBridge NewFront suppression.")
    policy.arm(auxiliary, current: foreground)
    _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
    _ = policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 91, isLive: live)
    policy.noteReleaseResult(token: 91, success: true)
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: { live($0) && $0 != foreground }) == .pass, "NewFront suppression outlived its original recipient.")
    policy.arm(auxiliary, current: foreground)
    _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 0, isLive: live) == .invalidToken, "Auxiliary invalid token was accepted.")
    policy.noteReleaseResult(token: 0, success: true)
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Invalid-token release result enabled NewFront suppression.")
    policy.disarm()
    try require(policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Disarmed auxiliary retained focus authority.")

    // Human takeover must cancel future agent focus attempts while preserving
    // the exact previously admitted token cleanup and special NewFront branch.
    policy.arm(auxiliary, current: foreground)
    _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
    policy.revokeFutureAdmission()
    try require(policy.observe(kind: 0x4000, subject: auxiliary, target: foreign, token: 0, isLive: live) == .pass, "Human takeover admitted a new auxiliary theft pair.")
    try require(policy.observe(kind: 0x8000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .suppress, "Human takeover abandoned the existing returned pair.")
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 101, isLive: live) == .release(101), "Human takeover abandoned an already admitted focus-release token.")
    policy.noteReleaseResult(token: 101, success: true)
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 102, isLive: live) == .pass, "Pending-only cleanup renewed its one-use release token.")
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .suppress, "Pending-only special NewFront lost successful-release cleanup.")
    try require(policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Pending cleanup rearmed after NewFront.")
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 103, isLive: live) == .pass, "Pending-only cleanup minted a new token without Taken admission.")
    policy.arm(auxiliary, current: foreground)
    policy.revokeFutureAdmission()
    try require(policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Revocation without a pending pair retained future admission.")
    try require(policy.observe(kind: 2, subject: auxiliary, target: foreground, token: 0, isLive: live) == .pass, "Revocation without a pair invented special cleanup.")
    policy.arm(auxiliary, current: foreground)
    _ = policy.observe(kind: 0x4000, subject: auxiliary, target: foreground, token: 0, isLive: live)
    policy.revokeFutureAdmission()
    _ = policy.observe(kind: 0xf102, subject: foreground, target: foreground, token: 0, isLive: live)
    try require(policy.observe(kind: 0xf102, subject: auxiliary, target: foreground, token: 104, isLive: live) == .pass, "Restored live focus allowed a later unadmitted theft to borrow an old token pair.")
    print("glide-incoming-focus-policy-qualified")
  }
}
