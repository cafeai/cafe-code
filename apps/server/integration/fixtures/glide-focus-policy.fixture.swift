// Pure policy runner. No AppKit, event taps, process APIs or GUI operations.
import Foundation
private struct QualificationFailure: Error { let message: String }
private func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  if !condition() { throw QualificationFailure(message: message) }
}

@main
struct FocusPolicyQualification {
  static let subject = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 10, microseconds: 1))
  static let foreground = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 20, microseconds: 2))
  static let unrelated = FocusProcess(pid: 303, birth: ProcessIdentity(seconds: 30, microseconds: 3))
  static let replacement = FocusProcess(pid: 101, birth: ProcessIdentity(seconds: 40, microseconds: 4))
  static let recipientReplacement = FocusProcess(pid: 202, birth: ProcessIdentity(seconds: 50, microseconds: 5))
  static func live(_ process: FocusProcess) -> Bool { [subject, foreground, unrelated].contains(process) }

  static func taken(_ policy: inout BackgroundFocusPolicy) throws {
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 0, isLive: live) == .suppress, "Armed exact-generation Taken was not suppressed.")
  }

  static func main() throws {
    func display(_ name: String, _ space: Any) -> [String: Any] {
      ["Display Identifier": name, "Current Space": ["id64": space]]
    }
    let desktop = [display("one", NSNumber(value: 1)), display("two", NSNumber(value: UInt64.max))]
    var desktops = BackgroundDesktopPolicy()
    try require(!desktops.admits(desktop), "Unarmed active desktops authorized input.")
    try require(desktops.arm(desktop), "Exact positive native Space IDs were rejected.")
    try require(desktops.admits(Array(desktop.reversed())), "Display inventory order changed active-Space identity.")
    let malformed: [[[String: Any]]?] = [nil, [], [display("", 1)], [display("one", 1), display("one", 1)],
      [["Display Identifier": "one"]], [display("one", true)], [display("one", -1)], [display("one", 0)],
      [display("one", 1.5)], [display("one", Double.infinity)], [display("one", Double.nan)],
      [display("one", NSNumber(value: 18_446_744_073_709_551_616.0))], [display("one", "1")],
      [display(String(repeating: "x", count: 257), 1)], (0..<17).map { display(String($0), 1) }]
    for sample in malformed {
      try require(!desktops.admits(sample), "Uncertain display metadata retained input authority.")
      try require(BackgroundDesktopPolicy.snapshot(sample) == nil, "Malformed display/Space metadata was coerced.")
    }
    try require(!desktops.admits([display("one", 2), desktop[1]]), "Changed active Space retained old authority.")
    try require(!desktops.admits([desktop[0]]), "Missing display retained old authority.")
    try require(!desktops.admits(desktop + [display("three", 3)]), "Added display retained old authority.")
    try require(!desktops.arm(nil) && !desktops.admits(desktop), "Failed admission preserved a previous desktop tuple.")
    try require(desktops.arm([display("one", NSNumber(value: 1.0))]), "Exact integral NSNumber was rejected.")
    desktops.disarm()
    try require(!desktops.isArmed && !desktops.admits([display("one", 1)]), "Desktop cleanup preserved admission.")

    // Background events produced by this helper cannot cancel their own
    // admitted generation. Every other source, including missing/untrusted PID
    // values, revokes that generation without inspecting key content.
    var activity = BackgroundActivityPolicy()
    let admittedGeneration = activity.generation
    try require(!activity.exhausted, "Fresh activity policy was exhausted.")
    try require(!activity.observe(sourcePID: 404, helperPID: 404), "Own helper input cancelled itself.")
    try require(activity.generation == admittedGeneration, "Own input changed admitted activity ownership.")
    for source in [Int64(0), -1, 202, 202] {
      let previous = activity.generation
      try require(activity.observe(sourcePID: source, helperPID: 404), "Foreign or untrusted input was ignored.")
      try require(activity.generation > previous, "Repeated foreign activity did not revoke prior admission.")
      try require(activity.generation != admittedGeneration, "Foreign activity retained old dispatch authority.")
    }
    let nextAdmission = activity.generation
    try require(!activity.observe(sourcePID: 404, helperPID: 404), "Own input cancelled the next admission.")
    try require(activity.generation == nextAdmission, "New admission did not retain its own events.")
    try require(activity.observe(sourcePID: 303, helperPID: 404), "Later outside input was ignored.")
    try require(activity.generation != nextAdmission, "Next admission survived outside activity.")
    _ = activity.beginAdmission()
    try require(activity.observe(sourcePID: 0, helperPID: 404, event: "scroll"), "Unattributed scroll was ignored.")
    try require(activity.interruption?.result["source"] as? String == "unattributed", "Missing PID was reported as physical human input.")
    try require(activity.interruption?.event == "scroll", "Interruption event category was lost.")
    try require(activity.observe(sourcePID: 505, helperPID: 404, event: "button-down"), "Foreign button input was ignored.")
    try require(activity.interruption?.event == "scroll", "Later activity erased the first interruption in this admission.")
    _ = activity.beginAdmission()
    try require(activity.interruption == nil, "A fresh admission retained old interruption diagnostics.")
    try require(activity.observe(sourcePID: 505, helperPID: 404, event: "button-down"), "New-admission foreign input was ignored.")
    try require(activity.interruption?.result["sourcePid"] as? Int64 == 505, "Bounded source PID was lost.")
    try require(activity.interruption?.result["source"] as? String == "external-process", "Foreign process input was reported as hardware proof.")

    // Unarmed, unknown, unrelated, already-focused and stale process identities
    // cannot acquire suppression authority from a matching PID alone.
    var policy = BackgroundFocusPolicy()
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 1, isLive: live) == .pass, "Unarmed subject was admitted.")
    policy.arm(subject, current: foreground)
    try require(policy.observe(kind: 0x4000, subject: unrelated, target: foreground, token: 1, isLive: live) == .pass, "Unregistered process was admitted.")
    try require(policy.observe(kind: 0x4000, subject: replacement, target: foreground, token: 1, isLive: { _ in true }) == .pass, "Reused subject PID acquired old authority.")
    try require(policy.observe(kind: 0x4000, subject: subject, target: nil, token: 1, isLive: live) == .pass, "Unknown recipient acquired authority.")
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 1, isLive: { $0 != subject }) == .pass, "Dead armed generation was admitted.")
    policy.arm(subject, current: subject)
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 1, isLive: live) == .pass, "Already-focused subject was suppressed.")

    // Changed owns the release token; Returned is independently paired by the
    // exact recipient generation and may arrive before or after Changed.
    policy.arm(subject, current: foreground)
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: unrelated, token: 1, isLive: live) == .pass, "Unpaired Return was suppressed.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: recipientReplacement, token: 1, isLive: { _ in true }) == .pass, "Reused recipient PID matched pending Return.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 1, isLive: live) == .suppress, "Exact paired Return was not suppressed.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 1, isLive: live) == .pass, "Duplicate Return was suppressed twice.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: unrelated, token: 731, isLive: live) == .release(731), "Changed did not release its own exact token.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 999, isLive: live) == .pass, "Duplicate Changed released twice.")

    policy.arm(subject, current: foreground)
    try taken(&policy)
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: Int64(UInt32.max), isLive: live) == .release(UInt32.max), "Changed improperly waited for Return or rejected the maximum token.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "Late exact Return lost its pending pair.")

    // Repeated Taken/Changed cannot re-arm a consumed release while the subject
    // still holds focus. A real live focus restoration does retire that attempt
    // and admits a second complete attempt within the same operation.
    policy.arm(subject, current: foreground)
    try taken(&policy)
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "First cycle Return was not consumed.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 9, isLive: live) == .release(9), "Repeated Taken damaged its original pair.")
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 8, isLive: live) == .pass, "Focused duplicate Taken was admitted.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 8, isLive: live) == .pass, "Duplicate Changed replenished release authority.")
    try require(policy.observe(kind: 0xf102, subject: unrelated, target: foreground, token: 8, isLive: live) == .pass, "Restored external focus was intercepted.")
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "New attempt retained the old Return flag.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 8, isLive: live) == .release(8), "Restored focus failed to admit the next theft attempt.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 8, isLive: live) == .pass, "Second attempt released twice.")
    _ = policy.observe(kind: 0xf102, subject: foreground, target: unrelated, token: 0, isLive: live)
    try taken(&policy)
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 10, isLive: live) == .release(10), "Repeated legitimate focus cycles were not independently admitted.")

    policy.arm(subject, current: foreground)
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "Initial Return was not suppressed.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 11, isLive: live) == .release(11), "Initial attempt was not consumed.")
    _ = policy.observe(kind: 0xf102, subject: nil, target: foreground, token: 0, isLive: live)
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .pass, "Unknown restoration replenished Return authority.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 12, isLive: live) == .pass, "Unknown restoration replenished release authority.")
    _ = policy.observe(kind: 0xf102, subject: unrelated, target: foreground, token: 0, isLive: { $0 != unrelated })
    try taken(&policy)
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .pass, "Dead restoration replenished Return authority.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 12, isLive: live) == .pass, "Dead restoration replenished release authority.")

    // Both halves of a pending pair remain birth-fenced at the final decision.
    policy.arm(subject, current: foreground)
    try taken(&policy)
    try require(policy.observe(kind: 0xf102, subject: replacement, target: foreground, token: 13, isLive: { _ in true }) == .pass, "Stale pending subject matched a replacement.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: { $0 != subject }) == .pass, "Return used a dead pending subject.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 13, isLive: { $0 != foreground }) == .pass, "Release used a dead pending recipient.")

    for invalid in [Int64(-1), 0, Int64(UInt32.max) + 1] {
      policy.arm(subject, current: foreground)
      try taken(&policy)
      try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: invalid, isLive: live) == .invalidToken, "Malformed Changed token was accepted.")
      try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 42, isLive: live) == .pass, "Malformed Changed token replenished release authority.")
    }

    policy.arm(subject, current: foreground)
    try taken(&policy)
    policy.disarm()
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .pass, "Disarm retained pending Return authority.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 19, isLive: live) == .pass, "Disarm retained pending release authority.")

    policy.arm(subject, current: foreground)
    try taken(&policy)
    policy.revokeFutureAdmission()
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "Outside activity erased the admitted Return pair.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 24, isLive: live) == .release(24), "Outside activity erased the already admitted release.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 25, isLive: live) == .pass, "Revoked admission replenished a consumed release.")
    _ = policy.observe(kind: 0xf102, subject: foreground, target: subject, token: 0, isLive: live)
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 0, isLive: live) == .pass, "Outside activity admitted another theft.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 26, isLive: live) == .pass, "Revoked future Taken minted a release.")
    policy.arm(subject, current: foreground)
    policy.revokeFutureAdmission()
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 0, isLive: live) == .pass, "Revocation with no pending pair admitted new work.")
    policy.arm(subject, current: foreground)
    try taken(&policy)
    policy.revokeFutureAdmission()
    _ = policy.observe(kind: 0xf102, subject: foreground, target: subject, token: 0, isLive: live)
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 27, isLive: live) == .pass, "Restored focus retained revoked pre-Changed token authority.")

    policy.arm(subject, current: foreground)
    try taken(&policy)
    try require(policy.observe(kind: 2, subject: unrelated, target: foreground, token: 0, isLive: live) == .pass, "Unrelated NewFront was suppressed.")
    try require(policy.observe(kind: 0x8000, subject: nil, target: foreground, token: 0, isLive: live) == .suppress, "Unrelated NewFront retired another subject's pair.")
    try require(policy.observe(kind: 2, subject: subject, target: foreground, token: 0, isLive: live) == .pass, "Matching NewFront was suppressed.")
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 23, isLive: live) == .pass, "Matching NewFront retained pending release.")

    // A Changed without a pending pair still changes the policy's current focus.
    policy.arm(subject, current: subject)
    try require(policy.observe(kind: 0xf102, subject: unrelated, target: foreground, token: 0, isLive: live) == .pass, "Unrelated Changed was intercepted.")
    try taken(&policy)
    policy.arm(subject, current: foreground)
    try require(policy.observe(kind: 0xf102, subject: subject, target: foreground, token: 0, isLive: live) == .pass, "Unpaired Changed minted token authority.")
    try require(policy.observe(kind: 0x4000, subject: subject, target: foreground, token: 0, isLive: live) == .pass, "Unpaired Changed failed to update actual focus.")
    print("background-focus-policy-qualified")
  }
}
